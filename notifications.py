"""Persistent notifications; calendar dates are evaluated in the study timezone."""
import hashlib
import json
import logging
import math
import re
import threading
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from settings import APP_TIMEZONE, NOTIFICATION_INTERVAL

logger = logging.getLogger(__name__)


def is_deadline_tomorrow(deadline_str, current_date):
    today = current_date.date() if isinstance(current_date, datetime) else current_date
    if not isinstance(today, date) or not isinstance(deadline_str, str):
        return False
    tomorrow = today + timedelta(days=1)
    try:
        if len(deadline_str.split('.')) == 2:
            deadline_str = f'{deadline_str}.{tomorrow.year}'
        return datetime.strptime(deadline_str, '%d.%m.%Y').date() == tomorrow
    except ValueError:
        return False


def lesson_start(lesson, timezone):
    """Return the lesson start in the study timezone, or None for invalid legacy data."""
    match = re.match(r'\s*(\d{1,2})[.:](\d{2})', lesson.get('time', ''))
    if not match:
        return None
    try:
        value = datetime.strptime(lesson['date'], '%d.%m.%Y')
        return value.replace(hour=int(match.group(1)), minute=int(match.group(2)),
                             tzinfo=timezone)
    except (KeyError, TypeError, ValueError):
        return None


def lesson_day_message(lessons, now, timezone):
    first_start = lesson_start(lessons[0], timezone)
    minutes = max(1, math.ceil((first_start - now).total_seconds() / 60))
    heading = ('⏰ Занятия начнутся примерно через час' if minutes >= 55
               else f'⏰ Занятия начнутся через {minutes} мин.')
    lesson_date = first_start.date()
    if lesson_date == now.date():
        day = 'Сегодня'
    elif lesson_date == now.date() + timedelta(days=1):
        day = 'Завтра'
    else:
        day = first_start.strftime('%d.%m.%Y')
    rows = []
    for index, lesson in enumerate(lessons, 1):
        start = lesson_start(lesson, timezone).strftime('%H:%M')
        link = lesson.get('url') or 'не указана'
        rows.append(
            f"{index}. {start} — {lesson['subject']}\n"
            f"Преподаватель: {lesson['teacher']}\n"
            f"Ссылка: {link}"
        )
    return f"{heading}\n📅 {day}\n\n" + '\n\n'.join(rows)


def check_notifications(service, send_message, *, now=None):
    timezone = ZoneInfo(APP_TIMEZONE)
    now = now or datetime.now(timezone)
    now = now.astimezone(timezone) if now.tzinfo is not None else now.replace(tzinfo=timezone)
    catalog = service.catalog()
    fingerprint = hashlib.sha256(json.dumps(catalog['schedule'], sort_keys=True).encode()).hexdigest()
    service.db.observe_schedule(fingerprint)
    users = service.db.get_all_users()
    lessons_by_day = {}
    for lesson in catalog['schedule']:
        start = lesson_start(lesson, timezone)
        if start is None or start <= now:
            continue
        lessons_by_day.setdefault((lesson['date'], lesson['group']), []).append(lesson)
    for (lesson_date, group), lessons in lessons_by_day.items():
        lessons.sort(key=lambda item: lesson_start(item, timezone))
        first_start = lesson_start(lessons[0], timezone)
        if first_start - now > timedelta(hours=1):
            continue
        recipients = {user['user_id'] for user in users if user['group_name'] == group}
        service.db.enqueue_notification(
            'lessons', lesson_day_message(lessons, now, timezone),
            f'lesson-day:{lesson_date}', recipients)
    bookings = service.db.get_all_bookings()
    for kind in ('assignments', 'topics'):
        for item in catalog[kind]:
            deadline = item.get('deadline')
            if not is_deadline_tomorrow(deadline, now):
                continue
            recipients = None if kind == 'assignments' else {
                b['user_id'] for b in bookings if b['topic'] == item['title']
            }
            details = (f"{item['subject']}\n{item['description']}" if kind == 'assignments'
                       else item['title'])
            service.db.enqueue_notification(
                kind, f"🔔 Срок сдачи завтра\n{details}\n📅 {deadline}",
                f"deadline:{kind}:{item['id']}:{deadline}", recipients)
    direct_jobs = []
    topic_batches = {}
    for job in service.db.claim_notifications(limit=500):
        if job['event_key'].startswith('deadline:'):
            _, kind, item_id, deadline = job['event_key'].split(':', 3)
            item = next((i for i in service.catalog().get(kind, []) if i['id'] == int(item_id)), None)
            still_owned = kind != 'topics' or any(
                b['user_id'] == job['user_id'] and item and b['topic'] == item['title']
                for b in service.db.get_all_bookings()
            )
            # Do not retry yesterday's "tomorrow" or a cancelled report reminder.
            if not item or item.get('deadline') != deadline or not still_owned or not is_deadline_tomorrow(deadline, now):
                service.db.finish_notification(job, success=True)
                continue
        if job['event_key'].startswith('topic-added:'):
            try:
                topic_id = int(job['event_key'].rsplit(':', 1)[1])
            except (TypeError, ValueError):
                service.db.finish_notification(job, success=True)
                continue
            topic = next((item for item in service.visible_topics(job['user_id'])
                          if item['id'] == topic_id), None)
            if not topic:
                service.db.finish_notification(job, success=True)
                continue
            topic_batches.setdefault(job['user_id'], []).append((job, topic))
            continue
        direct_jobs.append(job)

    for job in direct_jobs:
        try:
            send_message(job['user_id'], job['message'])
        except Exception as exc:
            logger.warning('Notification delivery failed (%s); it will be retried.', type(exc).__name__)
            service.db.finish_notification(job, success=False)
        else:
            service.db.finish_notification(job, success=True)

    for user_id, batch in topic_batches.items():
        lines = []
        for index, (_, topic) in enumerate(batch, 1):
            scope = 'Общий доклад' if topic['isCommon'] else f"Группа: {topic['group']}"
            deadline = f"\nСрок: {topic['deadline']}" if topic.get('deadline') else ''
            lines.append(f"{index}. {topic['title']}\nПредмет: {topic['subject']}\n{scope}{deadline}")
        heading = ('📚 Добавлена новая тема доклада' if len(batch) == 1 else
                   f'📚 Добавлены новые темы докладов: {len(batch)}')
        message = heading + '\n\n' + '\n\n'.join(lines)
        try:
            send_message(user_id, message)
        except Exception as exc:
            logger.warning('Notification delivery failed (%s); it will be retried.', type(exc).__name__)
            for job, _ in batch:
                service.db.finish_notification(job, success=False)
        else:
            for job, _ in batch:
                service.db.finish_notification(job, success=True)


def start_notification_thread(service, send_message, stop_event=None):
    stop_event = stop_event or threading.Event()

    def run():
        while not stop_event.is_set():
            try:
                check_notifications(service, send_message)
            except Exception as exc:
                logger.error('Notification cycle failed: %s', type(exc).__name__)
            stop_event.wait(NOTIFICATION_INTERVAL)

    thread = threading.Thread(target=run, name='notifications', daemon=True)
    thread.start()
    return stop_event, thread
