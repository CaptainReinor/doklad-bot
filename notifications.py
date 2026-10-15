"""Persistent notifications; calendar dates are evaluated in the study timezone."""
import html
import logging
import math
import re
import threading
from datetime import date, datetime, timedelta
from zoneinfo import ZoneInfo

from attendance import DATES as ATTENDANCE_DATES
from attendance import GROUP as ATTENDANCE_GROUP
from attendance import message as attendance_message
from settings import APP_TIMEZONE, NOTIFICATION_INTERVAL
from storage import cleanup_uploads

logger = logging.getLogger(__name__)
DEADLINE_REMINDER_HOUR = 9
URL_LINE_RE = re.compile(r'^(?P<prefix>.*?)(?P<url>https?://\S+)$')
LEADING_ICON_RE = re.compile(
    r'^[ \t]*[\U0001F000-\U0001FAFF\u2600-\u27BF\u2300-\u23FF\u2B00-\u2BFF]+\ufe0f?\s*')


def notification_html(message):
    """Hide technical URLs behind short Telegram HTML links."""
    lines = []
    for raw_line in message.splitlines():
        line = LEADING_ICON_RE.sub('', raw_line)
        match = URL_LINE_RE.match(line)
        if not match:
            lines.append(html.escape(line))
            continue
        prefix, url = match.group('prefix'), match.group('url')
        if 'Материалы:' in prefix:
            label, replacement = 'Открыть материалы', ''
        elif 'Подробнее:' in prefix:
            label, replacement = 'Подробнее', ''
        elif 'СДО:' in prefix:
            label, replacement = 'Открыть СДО', ''
        elif 'Ссылка:' in prefix:
            label, replacement = 'Подключиться к паре', ''
        else:
            label, replacement = 'Открыть ссылку', prefix
        lines.append(f'{html.escape(replacement)}<a href="{html.escape(url, quote=True)}">{label}</a>')
    return '\n'.join(lines)


def send_notification(send_message, user_id, message):
    """Split before HTML conversion so Telegram limits cannot break links or markup."""
    # Prefer complete lines, keeping URLs intact even at chunk boundaries.
    for chunk in _notification_line_chunks(message):
        send_message(user_id, notification_html(chunk), parse_mode='HTML', disable_web_page_preview=True)


def _notification_line_chunks(message):
    current, size = [], 0
    for line in message.splitlines(keepends=True):
        line_size = len(line.encode('utf-16-le')) // 2
        if size + line_size > 3500 and current:
            yield ''.join(current)
            current, size = [], 0
        if line_size > 3500:
            # Validated catalog fields are shorter; tolerate oversized legacy plain text.
            part, part_size = [], 0
            for char in line:
                char_size = len(char.encode('utf-16-le')) // 2
                if part_size + char_size > 3500:
                    yield ''.join(part)
                    part, part_size = [], 0
                part.append(char)
                part_size += char_size
            current, size = part, part_size
        else:
            current.append(line)
            size += line_size
    if current:
        yield ''.join(current)


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


def deadline_reminder_time(current_time):
    return current_time.replace(hour=DEADLINE_REMINDER_HOUR, minute=0, second=0, microsecond=0)


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
    heading = ('Занятия начнутся примерно через час' if minutes >= 55
               else f'Занятия начнутся через {minutes} мин.')
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
    return f"{heading}\n{day}\n\n" + '\n\n'.join(rows)


def study_now():
    return datetime.now(ZoneInfo(APP_TIMEZONE))


def check_notifications(service, send_message, *, now=None):
    timezone = ZoneInfo(APP_TIMEZONE)
    fixed_clock = now is not None
    now = now or study_now()
    now = now.astimezone(timezone) if now.tzinfo is not None else now.replace(tzinfo=timezone)
    try:
        cleanup_uploads(service, now=now.timestamp())
    except Exception as exc:
        logger.warning('Uploaded-file cleanup failed: %s', type(exc).__name__)
    catalog = service.catalog()
    users = service.db.get_all_users()
    users_by_id = {user['user_id']: user for user in users}
    attendance = service.db.get_attendance_settings()
    today = now.strftime('%d.%m.%Y')
    if attendance['enabled'] and today in attendance['dates'] and today in ATTENDANCE_DATES:
        hour, minute = map(int, attendance['time'].split(':'))
        remind_at = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if now >= remind_at:
            service.db.enqueue_notification('attendance', attendance_message(attendance),
                f'attendance:{today}', {user['user_id'] for user in users if user['group_name'] == ATTENDANCE_GROUP})
    for user in users:
        lessons_by_day = {}
        for lesson in service.visible_lessons(user['user_id']):
            start = lesson_start(lesson, timezone)
            if start is None or start <= now:
                continue
            lessons_by_day.setdefault(lesson['date'], []).append(lesson)
        for lesson_date, lessons in lessons_by_day.items():
            lessons.sort(key=lambda item: lesson_start(item, timezone))
            first_start = lesson_start(lessons[0], timezone)
            if first_start - now > timedelta(hours=1):
                continue
            service.db.enqueue_notification(
                'lessons', lesson_day_message(lessons, now, timezone),
                f'lesson-day:{lesson_date}', {user['user_id']})
    bookings = service.db.get_all_bookings()
    items_by_kind = {kind: {item['id']: item for item in catalog[kind]}
                     for kind in ('assignments', 'topics')}
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
            link = f"\nМатериалы: {item['url']}" if item.get('url') else ''
            service.db.enqueue_notification(
                kind, f"Срок сдачи завтра\n{details}\n{deadline}{link}",
                f"deadline:{kind}:{item['id']}:{deadline}", recipients,
                next_attempt=deadline_reminder_time(now).timestamp())
    direct_jobs = []
    topic_batches = {}
    for job in service.db.claim_notifications(limit=500, now=now.timestamp()):
        if job['kind'] == 'attendance':
            current = service.db.get_attendance_settings()
            recipient = service.db.get_user(job['user_id'])
            if (not current['enabled'] or today not in current['dates'] or today not in ATTENDANCE_DATES or
                    job['event_key'] != f'attendance:{today}' or not recipient or
                    recipient['group_name'] != ATTENDANCE_GROUP):
                service.db.finish_notification(job, success=True, now=now.timestamp())
                continue
            hour, minute = map(int, current['time'].split(':'))
            remind_at = now.replace(hour=hour, minute=minute, second=0, microsecond=0)
            if now < remind_at:
                service.db.defer_notification(job, remind_at.timestamp())
                continue
            job['message'] = attendance_message(current)
        if job['event_key'].startswith('lesson-day:'):
            lesson_date = job['event_key'].split(':', 1)[1]
            lessons = [lesson for lesson in service.visible_lessons(job['user_id'])
                       if lesson['date'] == lesson_date and
                       (start := lesson_start(lesson, timezone)) is not None and start > now]
            lessons.sort(key=lambda item: lesson_start(item, timezone))
            if not lessons:
                service.db.finish_notification(job, success=True, now=now.timestamp())
                continue
            first_start = lesson_start(lessons[0], timezone)
            if first_start - now > timedelta(hours=1):
                service.db.defer_notification(job, (first_start - timedelta(hours=1)).timestamp())
                continue
            job['message'] = lesson_day_message(lessons, now, timezone)
        if job['event_key'].startswith('assignment-added:'):
            try:
                assignment_id = int(job['event_key'].split(':', 1)[1])
            except ValueError:
                assignment_id = None
            item = items_by_kind['assignments'].get(assignment_id)
            if not item or item['archived']:
                service.db.finish_notification(job, success=True, now=now.timestamp())
                continue
            link = f"\nМатериалы: {item['url']}" if item.get('url') else ''
            job['message'] = (f"Добавлено домашнее задание\n{item['subject']}\n{item['description']}\n"
                              f"Срок: {item['deadline']}{link}")
        if job['event_key'].startswith('deadline:'):
            _, kind, item_id, deadline = job['event_key'].split(':', 3)
            item = items_by_kind.get(kind, {}).get(int(item_id))
            still_owned = kind != 'topics' or any(
                b['user_id'] == job['user_id'] and item and b['topic'] == item['title']
                for b in bookings
            )
            # Do not retry yesterday's "tomorrow" or a cancelled report reminder.
            if not item or item.get('deadline') != deadline or not still_owned or not is_deadline_tomorrow(deadline, now):
                service.db.finish_notification(job, success=True, now=now.timestamp())
                continue
            details = (f"{item['subject']}\n{item['description']}" if kind == 'assignments'
                       else item['title'])
            link = f"\nМатериалы: {item['url']}" if item.get('url') else ''
            job['message'] = f"Срок сдачи завтра\n{details}\n{deadline}{link}"
        if job['event_key'].startswith(('topic-added:', 'topic-changed:')):
            try:
                event_kind, raw_topic_id = job['event_key'].split(':', 2)[:2]
                topic_id = int(raw_topic_id)
            except (TypeError, ValueError):
                service.db.finish_notification(job, success=True, now=now.timestamp())
                continue
            topic = items_by_kind['topics'].get(topic_id)
            user = users_by_id.get(job['user_id'])
            if topic and not (service.is_admin(job['user_id']) or topic['isCommon'] or
                              user and topic['group'] == user['group_name']):
                topic = None
            if not topic:
                service.db.finish_notification(job, success=True, now=now.timestamp())
                continue
            topic_batches.setdefault(job['user_id'], []).append((job, topic, event_kind))
            continue
        direct_jobs.append(job)

    for job in direct_jobs:
        try:
            if job['kind'] == 'attendance':
                # Read eligibility again immediately before the external send.
                delivery_now = now if fixed_clock else study_now()
                delivery_today = delivery_now.strftime('%d.%m.%Y')
                recipient = service.db.get_user(job['user_id'])
                current = service.db.get_attendance_settings()
                if (not recipient or recipient['group_name'] != ATTENDANCE_GROUP or
                        not current['enabled'] or delivery_today not in current['dates'] or
                        job['event_key'] != f'attendance:{delivery_today}' or
                        not service.db.get_notification_settings(job['user_id'])['attendance']):
                    service.db.finish_notification(job, success=True, now=now.timestamp())
                    continue
                hour, minute = map(int, current['time'].split(':'))
                remind_at = delivery_now.replace(hour=hour, minute=minute, second=0, microsecond=0)
                if delivery_now < remind_at:
                    service.db.defer_notification(job, remind_at.timestamp())
                    continue
                job['message'] = attendance_message(current)
            send_message(job['user_id'], job['message'])
        except Exception as exc:
            logger.warning('Notification delivery failed (%s); it will be retried.', type(exc).__name__)
            service.db.finish_notification(job, success=False, now=now.timestamp())
        else:
            service.db.finish_notification(job, success=True, now=now.timestamp())

    for user_id, batch in topic_batches.items():
        merged = {}
        for job, topic, event_kind in batch:
            entry = merged.setdefault(topic['id'], {'topic': topic, 'kinds': set(), 'jobs': []})
            entry['topic'] = topic
            entry['kinds'].add(event_kind)
            entry['jobs'].append(job)
        lines = []
        for entry in merged.values():
            topic = entry['topic']
            scope = 'Общий доклад' if topic['isCommon'] else f"Группа: {topic['group']}"
            deadline = f"\nСрок: {topic['deadline']}" if topic.get('deadline') else ''
            link = f"\nМатериалы: {topic['url']}" if topic.get('url') else ''
            lines.append(
                f"№{topic['number']}. {topic['title']}\nПредмет: {topic['subject']}\n{scope}{deadline}{link}")
        kinds = {kind for entry in merged.values() for kind in entry['kinds']}
        count = len(merged)
        if kinds == {'topic-added'}:
            heading = ('Добавлена новая тема доклада' if count == 1 else
                       f'Добавлены новые темы докладов: {count}')
        elif kinds == {'topic-changed'}:
            heading = ('Изменена тема доклада' if count == 1 else
                       f'Изменены темы докладов: {count}')
        else:
            heading = f'Обновления тем докладов: {count}'
        message = heading + '\n\n' + '\n\n'.join(lines)
        try:
            send_message(user_id, message)
        except Exception as exc:
            logger.warning('Notification delivery failed (%s); it will be retried.', type(exc).__name__)
            for job, _, _ in batch:
                service.db.finish_notification(job, success=False, now=now.timestamp())
        else:
            for job, _, _ in batch:
                service.db.finish_notification(job, success=True, now=now.timestamp())


def start_notification_thread(service, send_message, stop_event=None):
    stop_event = stop_event or threading.Event()

    def deliver(user_id, message):
        send_notification(send_message, user_id, message)

    def run():
        while not stop_event.is_set():
            try:
                check_notifications(service, deliver)
            except Exception as exc:
                logger.error('Notification cycle failed: %s', type(exc).__name__)
            stop_event.wait(NOTIFICATION_INTERVAL)

    thread = threading.Thread(target=run, name='notifications', daemon=True)
    thread.start()
    return stop_event, thread
