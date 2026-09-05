"""Validated actions used by Telegram handlers and HTTP routes."""
import re
import unicodedata
from datetime import datetime
from urllib.parse import urlsplit

from catalog import load_catalog
from database import BookingConflict, TopicInUse
from settings import ADMIN_IDS, APP_TIMEZONE

ALLOWED_GROUPS = ('МН-4-25-01', 'МН-4-25-02')


class ActionError(ValueError):
    def __init__(self, message, status=400):
        super().__init__(message)
        self.status = status


def clean_text(value, label, minimum=2, maximum=80):
    if not isinstance(value, str):
        raise ActionError(f'Укажите {label}.')
    value = ' '.join(value.split())
    if not minimum <= len(value) <= maximum or any(unicodedata.category(c).startswith('C') for c in value):
        raise ActionError(f'{label}: допустимо от {minimum} до {maximum} символов.')
    if value.startswith('/'):
        raise ActionError(f'Введите {label}, а не команду.')
    return value


def clean_name(value, label):
    value = clean_text(value, label, 2, 50)
    separators = "-'’"
    if (not value[0].isalpha() or not value[-1].isalpha() or
            any(not (char.isalpha() or char in separators) for char in value) or
            any(left in separators and right in separators
                for left, right in zip(value, value[1:], strict=False))):
        raise ActionError(f'{label.capitalize()}: используйте только буквы, дефис или апостроф.')
    return value


def clean_description(value):
    if not isinstance(value, str):
        raise ActionError('Укажите описание задания.')
    value = value.replace('\r\n', '\n').replace('\r', '\n').strip()
    value = '\n'.join(line.strip() for line in value.split('\n'))
    if not 3 <= len(value) <= 2000 or any(
            unicodedata.category(char).startswith('C') and char != '\n' for char in value):
        raise ActionError('Описание задания: допустимо от 3 до 2000 символов.')
    return value


def clean_group(value):
    value = clean_text(value, 'группу', 3, 40)
    value = re.sub(r'\s*[-‐‑–—−]\s*', '-', value).upper()
    if re.search('[А-ЯЁ]', value):
        value = value.translate(str.maketrans('ABCEHKMOPTXY', 'АВСЕНКМОРТХУ'))
    if value not in ALLOWED_GROUPS:
        raise ActionError('Выберите группу МН-4-25-01 или МН-4-25-02.')
    return value


class Service:
    def __init__(self, db, admin_id=None, admin_ids=None):
        self.db = db
        if admin_ids is not None:
            self.admin_ids = frozenset(int(value) for value in admin_ids)
        elif admin_id is not None:
            self.admin_ids = frozenset({int(admin_id)})
        else:
            self.admin_ids = ADMIN_IDS
        if not self.admin_ids:
            raise ValueError('At least one administrator is required.')

    def is_admin(self, user_id):
        return user_id in self.admin_ids

    @staticmethod
    def _valid_deadline(value):
        if not isinstance(value, str) or not re.fullmatch(r'\d{2}\.\d{2}\.\d{4}', value):
            raise ActionError('Укажите дату в формате ДД.ММ.ГГГГ.')
        try:
            datetime.strptime(value, '%d.%m.%Y')
        except ValueError as exc:
            raise ActionError('Такой календарной даты не существует.') from exc
        return value

    @staticmethod
    def _lesson_data(data):
        value = data.get('date')
        if not isinstance(value, str) or not re.fullmatch(r'\d{2}\.\d{2}\.\d{4}', value):
            raise ActionError('Укажите дату занятия в формате ДД.ММ.ГГГГ.')
        try:
            lesson_date = datetime.strptime(value, '%d.%m.%Y')
        except ValueError as exc:
            raise ActionError('Дата занятия не существует.') from exc
        raw_time = data.get('time')
        match = re.fullmatch(r'\s*(\d{1,2})[.:](\d{2})\s*[-–—]\s*(\d{1,2})[.:](\d{2})\s*',
                             raw_time or '')
        if not match:
            raise ActionError('Укажите время в формате 18.30–19.50.')
        start_hour, start_minute, end_hour, end_minute = map(int, match.groups())
        if (start_hour > 23 or end_hour > 23 or start_minute > 59 or end_minute > 59 or
                (start_hour, start_minute) >= (end_hour, end_minute)):
            raise ActionError('Проверьте время начала и окончания занятия.')
        lesson_type = clean_text(data.get('type'), 'тип занятия', 1, 20).upper()
        if lesson_type not in ('Л', 'ПЗ'):
            raise ActionError('Тип занятия должен быть «Л» или «ПЗ».')
        day_names = ('Пн.', 'Вт.', 'Ср.', 'Чт.', 'Пт.', 'Сб.', 'Вс.')
        meeting_url = data.get('url', '')
        if not isinstance(meeting_url, str):
            raise ActionError('Ссылка на пару должна быть текстом.')
        meeting_url = meeting_url.strip()
        if meeting_url:
            parsed = urlsplit(meeting_url)
            if (len(meeting_url) > 1000 or parsed.scheme != 'https' or not parsed.hostname or
                    any(char.isspace() for char in meeting_url)):
                raise ActionError('Укажите полную HTTPS-ссылку на пару.')
        return {
            'date': value,
            'day': day_names[lesson_date.weekday()],
            'time': f'{start_hour:02d}.{start_minute:02d}–{end_hour:02d}.{end_minute:02d}',
            'type': lesson_type,
            'subject': clean_text(data.get('subject'), 'название дисциплины', 3, 200),
            'teacher': clean_text(data.get('teacher'), 'преподавателя', 2, 100),
            'room': clean_text(data.get('room'), 'аудиторию', 1, 100),
            'group': clean_group(data.get('group')),
            'url': meeting_url
        }

    def _topic_subject(self, value):
        subject = clean_text(value, 'название предмета', 2, 200)
        available = {item['subject'] for item in self.db.get_lessons(include_inactive=True)}
        if subject not in available:
            raise ActionError('Выберите предмет из расписания.')
        return subject

    @staticmethod
    def _topic_scope(data):
        is_common = data.get('isCommon', False)
        is_multi = data.get('isMulti', False)
        if type(is_common) is not bool or type(is_multi) is not bool:
            raise ActionError('Укажите тип доступности темы и количество выступающих.')
        group_name = '' if is_common else clean_group(data.get('group', ALLOWED_GROUPS[0]))
        return is_common, is_multi, group_name

    def topics(self, *, include_inactive=False):
        deadlines = {(row['kind'], row['item_id']): row['deadline'] for row in self.db.get_deadlines()}
        default_deadlines = {item['id']: item.get('deadline') for item in load_catalog()['topics']}
        return [{'id': row['id'], 'title': row['title'], 'subject': row['subject'],
                 'active': row['active'], 'isCommon': row['is_common'],
                 'isMulti': row['is_multi'], 'group': row['group_name'],
                 'deadline': deadlines.get(('topics', row['id']), default_deadlines.get(row['id']))}
                for row in self.db.get_topics(include_inactive=include_inactive)]

    def visible_topics(self, user_id=None, *, include_inactive=False):
        topics = self.topics(include_inactive=include_inactive)
        if user_id is not None and self.is_admin(user_id):
            return topics
        user = self.db.get_user(user_id) if user_id is not None else None
        if not user:
            return [topic for topic in topics if topic['isCommon']]
        return [topic for topic in topics
                if topic['isCommon'] or topic['group'] == user['group_name']]

    def find_topic(self, value, *, include_inactive=False):
        if isinstance(value, dict):
            value = value.get('id')
        for topic in self.topics(include_inactive=include_inactive):
            if (type(value) is int and topic['id'] == value) or value == topic['title']:
                return topic
        return None

    def catalog(self, user_id=None, *, public=False):
        result = load_catalog()
        result['schedule'] = self.db.get_lessons()
        result['topics'] = self.visible_topics(user_id) if public else self.topics()
        result['assignments'] = self.db.get_assignments()
        for row in self.db.get_deadlines():
            for item in result.get(row['kind'], []):
                if item['id'] == row['item_id']:
                    item['deadline'] = row['deadline']
        result['timezone'] = APP_TIMEZONE
        return result

    @staticmethod
    def public_profile(user):
        if not user:
            return None
        return {**user, 'name': f"{user['first_name']} {user['last_name']}",
                'telegramId': user['user_id'], 'username': user.get('username') or ''}

    def state(self, user_id):
        user, rows, settings = self.db.snapshot(user_id)
        all_topics = self.topics(include_inactive=True)
        topics = {t['title']: t for t in all_topics}
        visible_titles = {topic['title'] for topic in self.visible_topics(user_id, include_inactive=True)}
        visible_rows = rows if self.is_admin(user_id) else [row for row in rows if row['topic'] in visible_titles]
        bookings = [{'id': topics.get(r['topic'], {}).get('id'), 'title': r['topic'],
                     'subject': topics.get(r['topic'], {}).get('subject', ''), 'user': r['booked_by'],
                     'group': r['group_name'], 'isMine': r['user_id'] == user_id,
                     'date': r['created_at']} for r in visible_rows]
        result = {'user': self.public_profile(user), 'bookings': bookings,
                  'notifications': settings, 'participants': len({r['user_id'] for r in visible_rows}),
                  'isAdmin': self.is_admin(user_id)}
        if result['isAdmin']:
            result['adminTopics'] = [{**topic, 'bookings': [
                {'bookingId': row['id'], 'user': row['booked_by'], 'group': row['group_name']}
                for row in rows if row['topic'] == topic['title']
            ]} for topic in all_topics]
            result['adminLessons'] = self.db.get_lessons(include_inactive=True)
            result['adminAssignments'] = self.db.get_assignments()
        return result

    def perform(self, user_id, data, telegram_user=None):
        if not isinstance(data, dict):
            raise ActionError('Ожидается объект с действием.')
        action = data.get('action')
        current = self.db.get_user(user_id)
        try:
            if action == 'admin_cancel_booking':
                if not self.is_admin(user_id):
                    raise ActionError('Снимать чужие брони может только администратор.', 403)
                booking_id = data.get('bookingId')
                if type(booking_id) is not int:
                    raise ActionError('Бронирование не найдено.')
                self.db.cancel_booking_as_admin(booking_id)
                return 'Бронирование снято.'
            if action in ('create_assignment', 'update_assignment', 'delete_assignment'):
                if not self.is_admin(user_id):
                    raise ActionError('Управлять домашними заданиями может только администратор.', 403)
                if action == 'create_assignment':
                    subject = self._topic_subject(data.get('subject'))
                    description = clean_description(data.get('description'))
                    deadline = self._valid_deadline(data.get('deadline'))
                    self.db.create_assignment(subject, description, deadline)
                    return 'Домашнее задание добавлено.'
                assignment_id = data.get('assignmentId')
                if type(assignment_id) is not int or not self.db.get_assignment(assignment_id):
                    raise ActionError('Домашнее задание не найдено.')
                if action == 'update_assignment':
                    subject = self._topic_subject(data.get('subject'))
                    description = clean_description(data.get('description'))
                    deadline = self._valid_deadline(data.get('deadline'))
                    self.db.update_assignment(assignment_id, subject, description, deadline)
                    return 'Домашнее задание сохранено.'
                self.db.delete_assignment(assignment_id)
                return 'Домашнее задание удалено.'
            if action in ('create_lesson', 'update_lesson', 'set_lesson_active', 'delete_lesson'):
                if not self.is_admin(user_id):
                    raise ActionError('Управлять расписанием может только администратор.', 403)
                if action == 'create_lesson':
                    self.db.create_lesson(self._lesson_data(data))
                    return 'Занятие добавлено.'
                lesson_id = data.get('lessonId')
                if type(lesson_id) is not int or not self.db.get_lesson(lesson_id):
                    raise ActionError('Занятие не найдено.')
                if action == 'update_lesson':
                    self.db.update_lesson(lesson_id, self._lesson_data(data))
                    return 'Занятие сохранено.'
                if action == 'set_lesson_active':
                    active = data.get('active')
                    if type(active) is not bool:
                        raise ActionError('Некорректный статус занятия.')
                    self.db.set_lesson_active(lesson_id, active)
                    return 'Занятие возвращено в расписание.' if active else 'Занятие перенесено в архив.'
                self.db.delete_lesson(lesson_id)
                return 'Занятие удалено.'
            if action in ('create_topic', 'update_topic', 'set_topic_active', 'delete_topic'):
                if not self.is_admin(user_id):
                    raise ActionError('Управлять темами может только администратор.', 403)
                if action == 'create_topic':
                    title = clean_text(data.get('title'), 'название темы', 3, 200)
                    subject = self._topic_subject(data.get('subject'))
                    is_common, is_multi, group_name = self._topic_scope(data)
                    deadline = self._valid_deadline(data['deadline']) if data.get('deadline') else None
                    topic = self.db.create_topic(title, subject, is_common, is_multi, group_name)
                    if deadline:
                        self.db.set_deadline('topics', topic['id'], deadline, title)
                    return 'Тема добавлена.'
                item_id = data.get('topicId')
                existing_topic = self.find_topic(item_id, include_inactive=True)
                if type(item_id) is not int or not existing_topic:
                    raise ActionError('Тема не найдена.')
                if action == 'update_topic':
                    title = clean_text(data.get('title'), 'название темы', 3, 200)
                    subject = self._topic_subject(data.get('subject'))
                    is_common, is_multi, group_name = self._topic_scope(data)
                    deadline = self._valid_deadline(data['deadline']) if data.get('deadline') else None
                    topic = self.db.update_topic(item_id, title, subject, is_common, is_multi, group_name)
                    if deadline and existing_topic.get('deadline') != deadline:
                        self.db.set_deadline('topics', item_id, deadline, topic['title'])
                    return 'Тема сохранена.'
                if action == 'set_topic_active':
                    active = data.get('active')
                    if type(active) is not bool:
                        raise ActionError('Некорректный статус темы.')
                    self.db.set_topic_active(item_id, active)
                    return 'Тема возвращена из архива.' if active else 'Тема перенесена в архив.'
                self.db.delete_topic(item_id)
                return 'Тема удалена.'
            if action == 'set_deadline':
                if not self.is_admin(user_id):
                    raise ActionError('Изменять сроки может только администратор.', 403)
                kind, item_id = data.get('kind'), data.get('itemId')
                if kind != 'topics' or type(item_id) is not int:
                    raise ActionError('Укажите тему доклада.')
                items = self.topics(include_inactive=True)
                item = next((candidate for candidate in items if candidate['id'] == item_id), None)
                if item is None:
                    raise ActionError('Задание или тема не найдены.')
                deadline = self._valid_deadline(data.get('deadline'))
                if item.get('deadline') != deadline:
                    self.db.set_deadline(kind, item_id, deadline, item['title'])
                return 'Срок сохранён.'
            if action in ('register', 'edit_profile'):
                if action == 'edit_profile' and not current:
                    raise ActionError('Сначала зарегистрируйтесь.', 403)
                profile = data.get('user')
                if not isinstance(profile, dict):
                    raise ActionError('Укажите данные профиля.')
                if 'first_name' in profile or 'last_name' in profile:
                    first = clean_name(profile.get('first_name'), 'имя')
                    last = clean_name(profile.get('last_name'), 'фамилию')
                else:
                    name = clean_text(profile.get('name'), 'имя и фамилию', 4, 161).split(' ', 1)
                    if len(name) != 2:
                        raise ActionError('Введите имя и фамилию через пробел.')
                    first, last = clean_name(name[0], 'имя'), clean_name(name[1], 'фамилию')
                group = clean_group(profile.get('group_name', (current or {}).get('group_name')))
                username = (telegram_user or {}).get('username', (current or {}).get('username', '')) or ''
                self.db.save_user(user_id, first, last, group, username)
                return 'Профиль сохранён.'
            if not current:
                raise ActionError('Сначала заполните профиль.', 403)
            if action in ('book_topic', 'cancel_topic'):
                topic = self.find_topic(data.get('topicId', data.get('topic')),
                                        include_inactive=action == 'cancel_topic')
                if not topic:
                    raise ActionError('Неизвестная тема.')
                if action == 'book_topic':
                    if topic['id'] not in {item['id'] for item in self.visible_topics(user_id)}:
                        raise ActionError('Эта тема предназначена для другой группы.', 403)
                    changed = self.db.book({
                        'title': topic['title'], 'is_common': topic['isCommon'],
                        'is_multi': topic['isMulti'], 'group_name': topic['group']
                    }, user_id)
                    return 'Тема забронирована.' if changed else 'Эта тема уже забронирована вами.'
                changed = self.db.cancel(topic['title'], user_id)
                return 'Бронирование отменено.' if changed else 'У вас нет брони на эту тему.'
            if action in ('notification_settings', 'update_notifications'):
                kind = data.get('type', data.get('subject'))
                self.db.set_notification(user_id, kind, data.get('enabled'))
                return 'Настройки уведомлений сохранены.'
            raise ActionError('Неизвестное действие.')
        except BookingConflict as exc:
            raise ActionError(str(exc), 409) from exc
        except TopicInUse as exc:
            raise ActionError(str(exc), 409) from exc
        except ValueError as exc:
            if isinstance(exc, ActionError):
                raise
            raise ActionError(str(exc)) from exc
