"""SQLite persistence shared by the bot and the Mini App."""
import sqlite3
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path

from catalog import NOTIFICATION_DEFAULTS, load_catalog
from settings import DATABASE_PATH, TOPIC_NOTIFICATION_BATCH_DELAY


class BookingConflict(ValueError):
    pass


class TopicInUse(ValueError):
    pass


def timestamp():
    return datetime.now(timezone.utc).isoformat()


class Database:
    def __init__(self, path=DATABASE_PATH):
        self.path = Path(path).resolve()

    @contextmanager
    def connection(self):
        conn = sqlite3.connect(self.path, timeout=15)
        conn.row_factory = sqlite3.Row
        conn.execute('PRAGMA foreign_keys=ON')
        try:
            with conn:
                yield conn
        finally:
            conn.close()

    def init(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        with self.connection() as conn:
            schema_version = conn.execute('PRAGMA user_version').fetchone()[0]
            columns = {r['name'] for r in conn.execute('PRAGMA table_info(bookings)')}
            legacy = bool(columns) and 'group_name' not in columns
            if legacy:
                backup_path = self.path.with_name(self.path.name + '.before-v2.bak')
                if not backup_path.exists():
                    with sqlite3.connect(backup_path) as backup:
                        conn.backup(backup)
            conn.execute('BEGIN IMMEDIATE')
            conn.execute('''CREATE TABLE IF NOT EXISTS users (
                user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
                group_name TEXT, registered_at TEXT)''')
            if 'username' not in {r['name'] for r in conn.execute('PRAGMA table_info(users)')}:
                conn.execute("ALTER TABLE users ADD COLUMN username TEXT NOT NULL DEFAULT ''")
            if legacy:
                conn.execute('ALTER TABLE bookings RENAME TO bookings_v1')
            conn.execute('''CREATE TABLE IF NOT EXISTS bookings (
                id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL,
                booked_by TEXT NOT NULL, user_id INTEGER NOT NULL,
                group_name TEXT NOT NULL, created_at TEXT NOT NULL,
                UNIQUE(topic, user_id))''')
            if legacy:
                conn.execute('''INSERT INTO bookings (id, topic, booked_by, user_id, group_name, created_at)
                    SELECT b.id, b.topic, b.booked_by, b.user_id,
                        COALESCE(NULLIF(u.group_name, ''), 'Не указана'), ?
                    FROM bookings_v1 b LEFT JOIN users u ON u.user_id=b.user_id''', (timestamp(),))
                conn.execute('DROP TABLE bookings_v1')
            if schema_version < 8 and not legacy:
                conn.execute('ALTER TABLE bookings RENAME TO bookings_before_v8')
                conn.execute('''CREATE TABLE bookings (
                    id INTEGER PRIMARY KEY AUTOINCREMENT, topic TEXT NOT NULL,
                    booked_by TEXT NOT NULL, user_id INTEGER NOT NULL,
                    group_name TEXT NOT NULL, created_at TEXT NOT NULL,
                    UNIQUE(topic, user_id))''')
                conn.execute('''INSERT OR IGNORE INTO bookings
                    (id, topic, booked_by, user_id, group_name, created_at)
                    SELECT id, topic, booked_by, user_id, group_name, created_at
                    FROM bookings_before_v8''')
                conn.execute('DROP TABLE bookings_before_v8')
            conn.execute('''CREATE TABLE IF NOT EXISTS schedule (
                id INTEGER PRIMARY KEY AUTOINCREMENT, group_name TEXT, day_of_week TEXT,
                time TEXT, subject TEXT, teacher TEXT)''')
            conn.execute('''CREATE TABLE IF NOT EXISTS notification_settings (
                user_id INTEGER NOT NULL, kind TEXT NOT NULL, enabled INTEGER NOT NULL,
                PRIMARY KEY(user_id, kind))''')
            conn.execute('''CREATE TABLE IF NOT EXISTS notification_jobs (
                event_key TEXT NOT NULL, user_id INTEGER NOT NULL, kind TEXT NOT NULL,
                message TEXT NOT NULL, sent_at REAL, claimed_at REAL,
                attempts INTEGER NOT NULL DEFAULT 0, next_attempt REAL NOT NULL DEFAULT 0,
                PRIMARY KEY(event_key, user_id))''')
            conn.execute('CREATE TABLE IF NOT EXISTS app_meta (key TEXT PRIMARY KEY, value TEXT)')
            conn.execute('''CREATE TABLE IF NOT EXISTS topics (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                title TEXT NOT NULL COLLATE NOCASE UNIQUE,
                subject TEXT NOT NULL DEFAULT '',
                is_common INTEGER NOT NULL DEFAULT 0,
                is_multi INTEGER NOT NULL DEFAULT 0,
                group_name TEXT NOT NULL DEFAULT 'МН-4-25-01',
                active INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)''')
            if 'subject' not in {r['name'] for r in conn.execute('PRAGMA table_info(topics)')}:
                conn.execute("ALTER TABLE topics ADD COLUMN subject TEXT NOT NULL DEFAULT ''")
            topic_columns = {r['name'] for r in conn.execute('PRAGMA table_info(topics)')}
            if 'is_common' not in topic_columns:
                conn.execute("ALTER TABLE topics ADD COLUMN is_common INTEGER NOT NULL DEFAULT 0")
            if 'is_multi' not in topic_columns:
                conn.execute("ALTER TABLE topics ADD COLUMN is_multi INTEGER NOT NULL DEFAULT 0")
            if 'group_name' not in topic_columns:
                conn.execute("ALTER TABLE topics ADD COLUMN group_name TEXT NOT NULL DEFAULT 'МН-4-25-01'")
            now = timestamp()
            conn.executemany('''INSERT OR IGNORE INTO topics
                (id, title, subject, is_common, is_multi, group_name, active, deleted, created_at, updated_at)
                VALUES (?, ?, ?, 0, 0, ?, 1, 0, ?, ?)''',
                [(topic['id'], topic['title'], topic.get('subject', ''),
                  topic.get('group', 'МН-4-25-01'), now, now)
                 for topic in load_catalog()['topics']])
            conn.executemany('''UPDATE topics SET subject=?, updated_at=?
                WHERE id=? AND subject='' AND deleted=0''',
                [(topic['subject'], now, topic['id']) for topic in load_catalog()['topics']
                 if topic.get('subject')])
            if schema_version < 8:
                # Preserve legacy bookings: a topic used by one group follows that group.
                # Conflicting cross-group rows become a locked common topic until an admin
                # removes the obsolete booking(s).
                conn.execute('''UPDATE topics SET group_name=(
                        SELECT MIN(b.group_name) FROM bookings b WHERE b.topic=topics.title)
                    WHERE (SELECT COUNT(DISTINCT b.group_name) FROM bookings b
                           WHERE b.topic=topics.title)=1''')
                conn.execute('''UPDATE topics SET is_common=1, is_multi=0, group_name=''
                    WHERE (SELECT COUNT(DISTINCT b.group_name) FROM bookings b
                           WHERE b.topic=topics.title)>1''')
            conn.execute('''CREATE TABLE IF NOT EXISTS lessons (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lesson_date TEXT NOT NULL,
                day_name TEXT NOT NULL,
                lesson_time TEXT NOT NULL,
                lesson_type TEXT NOT NULL,
                subject TEXT NOT NULL,
                teacher TEXT NOT NULL,
                room TEXT NOT NULL,
                group_name TEXT NOT NULL,
                meeting_url TEXT NOT NULL DEFAULT '',
                active INTEGER NOT NULL DEFAULT 1,
                deleted INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)''')
            if 'meeting_url' not in {r['name'] for r in conn.execute('PRAGMA table_info(lessons)')}:
                conn.execute("ALTER TABLE lessons ADD COLUMN meeting_url TEXT NOT NULL DEFAULT ''")
            conn.executemany('''INSERT OR IGNORE INTO lessons
                (id, lesson_date, day_name, lesson_time, lesson_type, subject, teacher,
                 room, group_name, meeting_url, active, deleted, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)''',
                [(index, item['date'], item['day'], item['time'], item['type'], item['subject'],
                  item['teacher'], item['room'], item['group'], item.get('url', ''), now, now)
                 for index, item in enumerate(load_catalog()['schedule'], 1)])
            conn.execute('''CREATE TABLE IF NOT EXISTS deadlines (
                kind TEXT NOT NULL, item_id INTEGER NOT NULL, deadline TEXT NOT NULL,
                PRIMARY KEY(kind, item_id))''')
            conn.execute('''CREATE TABLE IF NOT EXISTS assignments (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                subject TEXT NOT NULL,
                description TEXT NOT NULL,
                deadline TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL)''')
            if schema_version < 6:
                conn.execute("DELETE FROM deadlines WHERE kind='assignments'")
                conn.execute('''UPDATE notification_jobs SET sent_at=?
                    WHERE sent_at IS NULL AND event_key LIKE 'deadline:assignments:%' ''', (time.time(),))
            if schema_version < 9:
                migration_time = time.time()
                # Do not release notifications created by the old, noisy rules after restart.
                conn.execute('''UPDATE notification_jobs SET sent_at=?
                    WHERE sent_at IS NULL AND (
                        kind IN ('bookings', 'queue', 'topics') OR
                        (kind='assignments' AND event_key NOT LIKE 'deadline:%'))''',
                             (migration_time,))
                conn.execute("DELETE FROM notification_settings WHERE kind IN ('bookings', 'queue')")
            conn.execute('PRAGMA user_version=9')

    @staticmethod
    def _user(conn, user_id):
        row = conn.execute('SELECT * FROM users WHERE user_id=?', (user_id,)).fetchone()
        return dict(row) if row else None

    def get_user(self, user_id):
        with self.connection() as conn:
            return self._user(conn, user_id)

    def get_all_users(self):
        with self.connection() as conn:
            return [dict(r) for r in conn.execute('SELECT * FROM users ORDER BY registered_at, user_id')]

    def save_user(self, user_id, first_name, last_name, group_name, username=''):
        try:
            with self.connection() as conn:
                conn.execute('BEGIN IMMEDIATE')
                previous = self._user(conn, user_id)
                if previous and previous['group_name'] != group_name:
                    booked_topics = conn.execute('''SELECT t.*, b.id AS booking_id
                        FROM bookings b JOIN topics t ON t.title=b.topic
                        WHERE b.user_id=? AND t.deleted=0''', (user_id,)).fetchall()
                    for topic in booked_topics:
                        if not topic['is_common'] and topic['group_name'] != group_name:
                            raise BookingConflict(
                                'Сначала отмените темы, предназначенные для вашей текущей группы.')
                        if topic['is_common'] and topic['is_multi']:
                            other_groups = {row['group_name'] for row in conn.execute(
                                'SELECT group_name FROM bookings WHERE topic=? AND user_id<>?',
                                (topic['title'], user_id))}
                            if other_groups and other_groups != {group_name}:
                                raise BookingConflict(
                                    'Сначала отмените общий доклад с другими выступающими вашей группы.')
                conn.execute('''INSERT INTO users
                    (user_id, first_name, last_name, group_name, registered_at, username)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(user_id) DO UPDATE SET first_name=excluded.first_name,
                    last_name=excluded.last_name, group_name=excluded.group_name, username=excluded.username''',
                    (user_id, first_name, last_name, group_name, timestamp(), username))
                conn.execute('UPDATE bookings SET booked_by=?, group_name=? WHERE user_id=?',
                             (f'{first_name} {last_name}', group_name, user_id))
                return self._user(conn, user_id)
        except sqlite3.IntegrityError as exc:
            raise BookingConflict('Не удалось перенести бронирования в новую группу.') from exc

    def get_all_bookings(self):
        with self.connection() as conn:
            return [dict(r) for r in conn.execute('SELECT * FROM bookings ORDER BY id')]

    @staticmethod
    def _topic(conn, topic_id):
        row = conn.execute('SELECT * FROM topics WHERE id=? AND deleted=0', (topic_id,)).fetchone()
        if not row:
            return None
        result = dict(row)
        result['active'] = bool(result['active'])
        result['is_common'] = bool(result['is_common'])
        result['is_multi'] = bool(result['is_multi'])
        result.pop('deleted', None)
        return result

    def get_topic(self, topic_id):
        with self.connection() as conn:
            return self._topic(conn, topic_id)

    def get_topics(self, *, include_inactive=False):
        condition = 'deleted=0' if include_inactive else 'deleted=0 AND active=1'
        with self.connection() as conn:
            rows = conn.execute(f'SELECT * FROM topics WHERE {condition} ORDER BY id').fetchall()
            result = []
            for row in rows:
                item = dict(row)
                item['active'] = bool(item['active'])
                item['is_common'] = bool(item['is_common'])
                item['is_multi'] = bool(item['is_multi'])
                item.pop('deleted', None)
                result.append(item)
            return result

    def create_topic(self, title, subject, is_common, is_multi, group_name):
        try:
            with self.connection() as conn:
                now = timestamp()
                cursor = conn.execute('''INSERT INTO topics
                    (title, subject, is_common, is_multi, group_name, active, deleted, created_at, updated_at)
                    VALUES (?, ?, ?, ?, ?, 1, 0, ?, ?)''',
                                      (title, subject, int(is_common), int(is_multi), group_name, now, now))
                topic = self._topic(conn, cursor.lastrowid)
                scope = 'Общий доклад' if is_common else f'Группа: {group_name}'
                deliver_after = time.time() + TOPIC_NOTIFICATION_BATCH_DELAY
                recipients = None if is_common else {row['user_id'] for row in conn.execute(
                    'SELECT user_id FROM users WHERE group_name=?', (group_name,))}
                # Debounce a burst of additions: the timer restarts for the whole pending batch.
                conn.execute('''UPDATE notification_jobs SET next_attempt=?
                    WHERE sent_at IS NULL AND event_key LIKE 'topic-added:%' ''',
                             (deliver_after,))
                self._enqueue(conn, 'topics',
                              f'{title}\nПредмет: {subject}\n{scope}',
                              event_key=f'topic-added:{topic["id"]}',
                              recipients=recipients,
                              next_attempt=deliver_after)
                return topic
        except sqlite3.IntegrityError as exc:
            raise ValueError('Тема с таким названием уже существует.') from exc

    def update_topic(self, topic_id, title, subject, is_common, is_multi, group_name):
        try:
            with self.connection() as conn:
                conn.execute('BEGIN IMMEDIATE')
                topic = self._topic(conn, topic_id)
                if not topic:
                    raise ValueError('Тема не найдена.')
                if (topic['title'] == title and topic['subject'] == subject and
                        topic['is_common'] == is_common and topic['is_multi'] == is_multi and
                        topic['group_name'] == group_name):
                    return topic
                bookings = conn.execute('SELECT * FROM bookings WHERE topic=?',
                                        (topic['title'],)).fetchall()
                if is_common and len(bookings) > 1:
                    booking_groups = {row['group_name'] for row in bookings}
                    if not is_multi or len(booking_groups) > 1:
                        raise TopicInUse('Новые параметры несовместимы с существующими бронями.')
                if not is_common and any(row['group_name'] != group_name for row in bookings):
                    raise TopicInUse('Сначала снимите брони студентов из другой группы.')
                if not is_multi and len(bookings) > 1:
                    raise TopicInUse('Сначала оставьте только одного выступающего.')
                conn.execute('''UPDATE topics SET title=?, subject=?, is_common=?, is_multi=?,
                    group_name=?, updated_at=? WHERE id=?''',
                             (title, subject, int(is_common), int(is_multi), group_name,
                              timestamp(), topic_id))
                if topic['title'] != title:
                    conn.execute('UPDATE bookings SET topic=? WHERE topic=?', (title, topic['title']))
                return self._topic(conn, topic_id)
        except sqlite3.IntegrityError as exc:
            raise ValueError('Тема с таким названием уже существует.') from exc

    def set_topic_active(self, topic_id, active):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            topic = self._topic(conn, topic_id)
            if not topic:
                raise ValueError('Тема не найдена.')
            conn.execute('UPDATE topics SET active=?, updated_at=? WHERE id=?',
                         (int(active), timestamp(), topic_id))
            return self._topic(conn, topic_id)

    def delete_topic(self, topic_id):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            topic = self._topic(conn, topic_id)
            if not topic:
                raise ValueError('Тема не найдена.')
            if conn.execute('SELECT 1 FROM bookings WHERE topic=?', (topic['title'],)).fetchone():
                raise TopicInUse('Нельзя удалить тему с бронированиями. Сначала отмените брони или перенесите тему в архив.')
            conn.execute('UPDATE topics SET active=0, deleted=1, updated_at=? WHERE id=?',
                         (timestamp(), topic_id))
            conn.execute("DELETE FROM deadlines WHERE kind='topics' AND item_id=?", (topic_id,))
            conn.execute('''UPDATE notification_jobs SET sent_at=?
                WHERE sent_at IS NULL AND event_key=?''',
                         (time.time(), f'topic-added:{topic_id}'))
            return True

    @staticmethod
    def _lesson(conn, lesson_id):
        row = conn.execute('SELECT * FROM lessons WHERE id=? AND deleted=0', (lesson_id,)).fetchone()
        if not row:
            return None
        return {
            'id': row['id'], 'date': row['lesson_date'], 'day': row['day_name'],
            'time': row['lesson_time'], 'type': row['lesson_type'], 'subject': row['subject'],
            'teacher': row['teacher'], 'room': row['room'], 'group': row['group_name'],
            'url': row['meeting_url'], 'active': bool(row['active'])
        }

    def get_lesson(self, lesson_id):
        with self.connection() as conn:
            return self._lesson(conn, lesson_id)

    def get_lessons(self, *, include_inactive=False):
        condition = 'deleted=0' if include_inactive else 'deleted=0 AND active=1'
        with self.connection() as conn:
            ids = [row['id'] for row in conn.execute(
                f'SELECT id FROM lessons WHERE {condition}')]
            lessons = [self._lesson(conn, lesson_id) for lesson_id in ids]
            return sorted(lessons, key=lambda item: (
                datetime.strptime(item['date'], '%d.%m.%Y'), item['time'], item['id']))

    def create_lesson(self, lesson):
        with self.connection() as conn:
            now = timestamp()
            cursor = conn.execute('''INSERT INTO lessons
                (lesson_date, day_name, lesson_time, lesson_type, subject, teacher, room,
                 group_name, meeting_url, active, deleted, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0, ?, ?)''',
                (lesson['date'], lesson['day'], lesson['time'], lesson['type'], lesson['subject'],
                 lesson['teacher'], lesson['room'], lesson['group'], lesson['url'], now, now))
            return self._lesson(conn, cursor.lastrowid)

    def update_lesson(self, lesson_id, lesson):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            if not self._lesson(conn, lesson_id):
                raise ValueError('Занятие не найдено.')
            conn.execute('''UPDATE lessons SET lesson_date=?, day_name=?, lesson_time=?, lesson_type=?,
                subject=?, teacher=?, room=?, group_name=?, meeting_url=?, updated_at=? WHERE id=?''',
                (lesson['date'], lesson['day'], lesson['time'], lesson['type'], lesson['subject'],
                 lesson['teacher'], lesson['room'], lesson['group'], lesson['url'], timestamp(), lesson_id))
            return self._lesson(conn, lesson_id)

    def set_lesson_active(self, lesson_id, active):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            lesson = self._lesson(conn, lesson_id)
            if not lesson:
                raise ValueError('Занятие не найдено.')
            conn.execute('UPDATE lessons SET active=?, updated_at=? WHERE id=?',
                         (int(active), timestamp(), lesson_id))
            return self._lesson(conn, lesson_id)

    def delete_lesson(self, lesson_id):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            lesson = self._lesson(conn, lesson_id)
            if not lesson:
                raise ValueError('Занятие не найдено.')
            conn.execute('UPDATE lessons SET active=0, deleted=1, updated_at=? WHERE id=?',
                         (timestamp(), lesson_id))
            return True

    @staticmethod
    def _assignment(conn, assignment_id):
        row = conn.execute('SELECT * FROM assignments WHERE id=?', (assignment_id,)).fetchone()
        return dict(row) if row else None

    def get_assignment(self, assignment_id):
        with self.connection() as conn:
            return self._assignment(conn, assignment_id)

    def get_assignments(self):
        with self.connection() as conn:
            return [dict(row) for row in conn.execute(
                "SELECT * FROM assignments ORDER BY substr(deadline, 7, 4), substr(deadline, 4, 2), "
                "substr(deadline, 1, 2), id")]

    def create_assignment(self, subject, description, deadline):
        with self.connection() as conn:
            now = timestamp()
            cursor = conn.execute('''INSERT INTO assignments
                (subject, description, deadline, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?)''', (subject, description, deadline, now, now))
            assignment = self._assignment(conn, cursor.lastrowid)
            self._enqueue(conn, 'assignments',
                          f'📝 Добавлено домашнее задание\n{subject}\n{description}\n📅 Срок: {deadline}')
            return assignment

    def update_assignment(self, assignment_id, subject, description, deadline):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            assignment = self._assignment(conn, assignment_id)
            if not assignment:
                raise ValueError('Домашнее задание не найдено.')
            if (assignment['subject'], assignment['description'], assignment['deadline']) == (
                    subject, description, deadline):
                return assignment
            conn.execute('''UPDATE assignments SET subject=?, description=?, deadline=?, updated_at=?
                WHERE id=?''', (subject, description, deadline, timestamp(), assignment_id))
            if assignment['deadline'] != deadline:
                conn.execute('''UPDATE notification_jobs SET sent_at=?
                    WHERE sent_at IS NULL AND event_key LIKE ?''',
                             (time.time(), f'deadline:assignments:{assignment_id}:%'))
            return self._assignment(conn, assignment_id)

    def delete_assignment(self, assignment_id):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            assignment = self._assignment(conn, assignment_id)
            if not assignment:
                raise ValueError('Домашнее задание не найдено.')
            conn.execute('DELETE FROM assignments WHERE id=?', (assignment_id,))
            conn.execute('''UPDATE notification_jobs SET sent_at=?
                WHERE sent_at IS NULL AND event_key LIKE ?''',
                         (time.time(), f'deadline:assignments:{assignment_id}:%'))
            return True

    def book(self, topic, user_id):
        try:
            with self.connection() as conn:
                conn.execute('BEGIN IMMEDIATE')
                user = self._user(conn, user_id)
                if not user:
                    raise ValueError('Сначала зарегистрируйтесь.')
                if not topic['is_common'] and topic['group_name'] != user['group_name']:
                    raise ValueError('Эта тема предназначена для другой группы.')
                existing = conn.execute('SELECT * FROM bookings WHERE topic=? ORDER BY id',
                                        (topic['title'],)).fetchall()
                if any(row['user_id'] == user_id for row in existing):
                    return False
                if topic['is_common'] and existing:
                    if not topic['is_multi']:
                        raise BookingConflict('Эта общая тема уже занята.')
                    if any(row['group_name'] != user['group_name'] for row in existing):
                        raise BookingConflict('Эту общую тему уже выбрала другая группа.')
                if not topic['is_common'] and not topic['is_multi'] and existing:
                    raise BookingConflict('Эта тема уже занята в вашей группе.')
                name = f"{user['first_name']} {user['last_name']}"
                conn.execute('''INSERT INTO bookings (topic, booked_by, user_id, group_name, created_at)
                    VALUES (?, ?, ?, ?, ?)''',
                             (topic['title'], name, user_id, user['group_name'], timestamp()))
                return True
        except sqlite3.IntegrityError as exc:
            raise BookingConflict('Эта тема уже занята в вашей группе.') from exc

    def cancel(self, topic, user_id):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            rows = conn.execute('SELECT * FROM bookings WHERE topic=? AND user_id=?', (topic, user_id)).fetchall()
            conn.execute('DELETE FROM bookings WHERE topic=? AND user_id=?', (topic, user_id))
            return bool(rows)

    def cancel_booking_as_admin(self, booking_id):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute('SELECT * FROM bookings WHERE id=?', (booking_id,)).fetchone()
            if not row:
                raise ValueError('Бронирование не найдено.')
            conn.execute('DELETE FROM bookings WHERE id=?', (booking_id,))
            return dict(row)

    @staticmethod
    def _settings(conn, user_id):
        result = dict(NOTIFICATION_DEFAULTS)
        result.update({r['kind']: bool(r['enabled']) for r in conn.execute(
            'SELECT kind, enabled FROM notification_settings WHERE user_id=?', (user_id,))
                       if r['kind'] in NOTIFICATION_DEFAULTS})
        return result

    def get_notification_settings(self, user_id):
        with self.connection() as conn:
            return self._settings(conn, user_id)

    def set_notification(self, user_id, kind, enabled):
        if not isinstance(kind, str) or kind not in NOTIFICATION_DEFAULTS or type(enabled) is not bool:
            raise ValueError('Некорректная настройка уведомлений.')
        with self.connection() as conn:
            conn.execute('''INSERT INTO notification_settings (user_id, kind, enabled) VALUES (?, ?, ?)
                ON CONFLICT(user_id, kind) DO UPDATE SET enabled=excluded.enabled''', (user_id, kind, int(enabled)))

    def snapshot(self, user_id):
        with self.connection() as conn:
            conn.execute('BEGIN')
            return (self._user(conn, user_id),
                    [dict(r) for r in conn.execute('SELECT * FROM bookings ORDER BY id')],
                    self._settings(conn, user_id))

    def get_deadlines(self):
        with self.connection() as conn:
            return [dict(r) for r in conn.execute('SELECT * FROM deadlines')]

    def set_deadline(self, kind, item_id, deadline, title):
        with self.connection() as conn:
            conn.execute('''INSERT INTO deadlines (kind, item_id, deadline) VALUES (?, ?, ?)
                ON CONFLICT(kind, item_id) DO UPDATE SET deadline=excluded.deadline''', (kind, item_id, deadline))
            # Cancel unsent reminders carrying the previous deadline.
            conn.execute('''UPDATE notification_jobs SET sent_at=?
                WHERE sent_at IS NULL AND event_key LIKE ?''', (time.time(), f'deadline:{kind}:{item_id}:%'))
            # Deadline edits are reflected in the app; only the due reminder is sent.

    @staticmethod
    def _enabled(settings, kind):
        return settings.get(kind, False)

    def _enqueue(self, conn, kind, message, *, event_key=None, actor_id=None, recipients=None,
                 next_attempt=0):
        event_key = event_key or str(uuid.uuid4())
        for row in conn.execute('SELECT user_id FROM users').fetchall():
            user_id = row['user_id']
            if recipients is not None and user_id not in recipients:
                continue
            if user_id != actor_id and self._enabled(self._settings(conn, user_id), kind):
                conn.execute('''INSERT OR IGNORE INTO notification_jobs
                    (event_key, user_id, kind, message, next_attempt) VALUES (?, ?, ?, ?, ?)''',
                    (event_key, user_id, kind, message, next_attempt))

    def enqueue_notification(self, kind, message, event_key, recipients=None):
        with self.connection() as conn:
            self._enqueue(conn, kind, message, event_key=event_key, recipients=recipients)

    def observe_schedule(self, fingerprint):
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            row = conn.execute("SELECT value FROM app_meta WHERE key='schedule_hash'").fetchone()
            if row and row['value'] != fingerprint:
                self._enqueue(conn, 'schedule', '📅 Расписание обновилось. Откройте приложение, чтобы увидеть изменения.')
            conn.execute("INSERT OR REPLACE INTO app_meta (key, value) VALUES ('schedule_hash', ?)", (fingerprint,))

    def claim_notifications(self, limit=30, now=None):
        now = time.time() if now is None else now
        with self.connection() as conn:
            conn.execute('BEGIN IMMEDIATE')
            rows = conn.execute('''SELECT * FROM notification_jobs WHERE sent_at IS NULL
                AND next_attempt<=? AND (claimed_at IS NULL OR claimed_at<?)
                ORDER BY rowid LIMIT ?''', (now, now - 300, limit)).fetchall()
            ready = []
            for row in rows:
                identity = (row['event_key'], row['user_id'])
                if not self._user(conn, row['user_id']) or not self._enabled(self._settings(conn, row['user_id']), row['kind']):
                    conn.execute('UPDATE notification_jobs SET sent_at=? WHERE event_key=? AND user_id=?', (now, *identity))
                    continue
                conn.execute('UPDATE notification_jobs SET claimed_at=? WHERE event_key=? AND user_id=?', (now, *identity))
                ready.append(dict(row))
            return ready

    def finish_notification(self, job, *, success, now=None):
        now = time.time() if now is None else now
        with self.connection() as conn:
            conn.execute('''UPDATE notification_jobs SET sent_at=?, claimed_at=NULL,
                attempts=attempts+1, next_attempt=? WHERE event_key=? AND user_id=?''',
                (now if success else None, now + min(3600, 60 * 2 ** min(job['attempts'], 6)),
                 job['event_key'], job['user_id']))


if __name__ == '__main__':
    Database().init()
    print('База данных готова к работе.')
