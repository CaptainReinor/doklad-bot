import io
import json
import sqlite3
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone

import pytest
from conftest import ADMIN, TEST_TOKEN, register, signed_data

from auth import validate_init_data
from catalog import load_catalog
from database import Database
from notifications import check_notifications, is_deadline_tomorrow
from service import ENGLISH_SUBJECT, ActionError, Service, clean_group


def test_catalog_schedule_only_splits_professional_english():
    schedule = load_catalog()['schedule']
    english = [item for item in schedule if item['subject'] == ENGLISH_SUBJECT]

    assert len(schedule) == 43
    assert {item['date'] for item in english if item['group'] == 'МН-4-25-01'} == {
        '09.09.2026', '23.09.2026', '07.10.2026', '21.10.2026', '11.11.2026'}
    assert {item['date'] for item in english if item['group'] == 'МН-4-25-02'} == {
        '16.09.2026', '30.09.2026', '14.10.2026', '28.10.2026', '18.11.2026'}
    assert all(item['group'] == '' for item in schedule if item['subject'] != ENGLISH_SUBJECT)
    assert all(item['room'] == 'СДО РАНХиГС' for item in schedule)
    assert not any(item['subject'] == 'Научно-исследовательская работа (П)'
                   or item['subject'].startswith('Практика по профилю') for item in schedule)


def test_public_schedule_filters_only_english_by_registered_group(service):
    register(service, 1, 'МН-4-25-01')
    register(service, 2, 'МН-4-25-02')
    first = service.catalog(1, public=True)['schedule']
    second = service.catalog(2, public=True)['schedule']

    assert len(first) == len(second) == 38
    assert {item['id'] for item in first if item['subject'] != ENGLISH_SUBJECT} == {
        item['id'] for item in second if item['subject'] != ENGLISH_SUBJECT}
    assert {item['group'] for item in first if item['subject'] == ENGLISH_SUBJECT} == {'МН-4-25-01'}
    assert {item['group'] for item in second if item['subject'] == ENGLISH_SUBJECT} == {'МН-4-25-02'}
    assert not any(item['subject'] == ENGLISH_SUBJECT
                   for item in service.catalog(3, public=True)['schedule'])
    assert len(service.catalog(ADMIN, public=True)['schedule']) == 43


def test_v14_migration_restores_grouped_english_lessons(tmp_path):
    db = Database(tmp_path / 'schedule.db')
    db.init()
    with db.connection() as conn:
        conn.execute("UPDATE lessons SET group_name='' WHERE subject=? AND group_name=?",
                     (ENGLISH_SUBJECT, 'МН-4-25-01'))
        conn.execute('''UPDATE lessons SET active=0, deleted=1
            WHERE subject=? AND group_name=? AND lesson_date<>'30.09.2026' ''',
                     (ENGLISH_SUBJECT, 'МН-4-25-02'))
        conn.execute("DELETE FROM lessons WHERE subject=? AND lesson_date='30.09.2026'",
                     (ENGLISH_SUBJECT,))
        conn.execute('PRAGMA user_version=13')
    db.init()

    english = [item for item in db.get_lessons() if item['subject'] == ENGLISH_SUBJECT]
    assert len(english) == 10
    assert sum(item['group'] == 'МН-4-25-01' for item in english) == 5
    assert sum(item['group'] == 'МН-4-25-02' for item in english) == 5
    with db.connection() as conn:
        assert conn.execute('PRAGMA user_version').fetchone()[0] == 14


def test_auth_signature_identity_and_extra_signature_field():
    raw = signed_data(42, signature='telegram-signature', query_id='a=b+c/тест')
    assert validate_init_data(raw, TEST_TOKEN)['id'] == 42


@pytest.mark.parametrize('raw', ['', 'user={}', 'hash=0000', 'bad-data', 'a=1&a=2'])
def test_auth_rejects_malformed(raw):
    with pytest.raises(ValueError):
        validate_init_data(raw, TEST_TOKEN)


def test_auth_rejects_tampered_expired_future_and_duplicate():
    for raw in [signed_data().replace('user1', 'user2'), signed_data(auth_date=int(time.time()) - 90000),
                signed_data(auth_date=int(time.time()) + 90), signed_data() + '&auth_date=123']:
        with pytest.raises(ValueError):
            validate_init_data(raw, TEST_TOKEN)


def test_registration_preserves_time_and_ignores_claimed_identity(service):
    register(service)
    before = service.db.get_user(1)['registered_at']
    service.perform(1, {'action': 'edit_profile', 'user': {
        'first_name': 'Пётр', 'last_name': 'Петров', 'group_name': 'мн – 4 – 25 – 01',
        'telegramId': 999, 'username': 'fake'}})
    user = service.db.get_user(1)
    assert user['registered_at'] == before
    assert user['group_name'] == 'МН-4-25-01'
    assert user['username'] == ''
    assert service.db.get_user(999) is None


@pytest.mark.parametrize('group', [' мн-4-25-01 ', 'МH–4–25–01', 'МН - 4 - 25 - 01'])
def test_group_normalization(group):
    assert clean_group(group) == 'МН-4-25-01'


def test_registration_rejects_groups_outside_the_two_allowed(service):
    with pytest.raises(ActionError, match='МН-4-25-01 или МН-4-25-02'):
        register(service, group='МН-4-25-03')


@pytest.mark.parametrize('first,last', [
    ('12345', 'Иванов'), ('___', 'Иванов'), ('Иван<script>', 'Иванов'),
    ('Иван😀', 'Иванов'), ('Иван', 'Петров99'), ('-Иван', 'Иванов')
])
def test_registration_rejects_symbolic_and_numeric_names(service, first, last):
    with pytest.raises(ActionError, match='только буквы'):
        register(service, first=first, last=last)


@pytest.mark.parametrize('profile', [None, {}, {'name': 'Иван'}, {'name': 'Иван Иванов', 'group_name': ''},
                                     {'first_name': '/users', 'last_name': 'Иванов', 'group_name': 'ABC'},
                                     {'first_name': 'x' * 81, 'last_name': 'Иванов', 'group_name': 'ABC'}])
def test_invalid_profiles_do_not_register(service, profile):
    with pytest.raises(ActionError):
        service.perform(1, {'action': 'register', 'user': profile})
    assert not service.db.get_all_users()


def test_group_topic_is_visible_and_bookable_only_in_its_group(service):
    register(service, 1)
    register(service, 2, 'МН-4-25-02')
    register(service, 3)
    service.perform(1, {'action': 'book_topic', 'topicId': 1})
    with pytest.raises(ActionError) as error:
        service.perform(3, {'action': 'book_topic', 'topicId': 1})
    assert error.value.status == 409
    with pytest.raises(ActionError) as hidden:
        service.perform(2, {'action': 'book_topic', 'topicId': 1})
    assert hidden.value.status == 403
    assert not service.catalog(2, public=True)['topics']
    assert not service.state(2)['bookings']


def test_concurrent_single_speaker_booking_has_one_winner(service):
    for user_id in range(1, 13):
        register(service, user_id, 'МН-4-25-01')
    def book(user_id):
        try:
            service.perform(user_id, {'action': 'book_topic', 'topicId': 1})
            return True
        except ActionError as exc:
            assert exc.status == 409
            return False
    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(book, range(1, 13)))
    assert sum(results) == 1
    assert len(service.db.get_all_bookings()) == 1


def test_repeated_booking_is_idempotent(service):
    register(service)
    topic_id = load_catalog()['topics'][0]['id']
    for _ in range(2):
        service.perform(1, {'action': 'book_topic', 'topicId': topic_id})
    assert len(service.db.get_all_bookings()) == 1


def test_cancel_only_own_booking(service):
    register(service, 1)
    register(service, 3)
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Групповой доклад',
                            'subject': 'Управление бизнес-процессами', 'isCommon': False,
                            'isMulti': True, 'group': 'МН-4-25-01'})
    topic = service.catalog()['topics'][-1]
    for user_id in (1, 3):
        service.perform(user_id, {'action': 'book_topic', 'topicId': topic['id']})
    service.perform(1, {'action': 'cancel_topic', 'topicId': topic['id'], 'user_id': 3})
    assert [b['user_id'] for b in service.db.get_all_bookings()] == [3]


def test_profile_move_rolls_back_conflicting_bookings_and_name(service):
    register(service, 1)
    service.perform(1, {'action': 'book_topic', 'topicId': 1})
    with pytest.raises(ActionError):
        register(service, 1, 'МН-4-25-02', first='Пётр')
    assert service.db.get_user(1)['group_name'] == 'МН-4-25-01'
    assert service.db.get_user(1)['first_name'] == 'Иван'
    service.perform(1, {'action': 'cancel_topic', 'topicId': 1})
    register(service, 1, 'МН-4-25-02', first='Пётр')
    assert service.db.get_user(1)['first_name'] == 'Пётр'


def test_common_and_multiple_speaker_topic_rules(service):
    register(service, 1)
    register(service, 2, 'МН-4-25-02')
    register(service, 3)
    base = {'action': 'create_topic', 'subject': 'Управление бизнес-процессами',
            'isCommon': True, 'group': ''}
    service.perform(ADMIN, {**base, 'title': 'Общий одиночный', 'isMulti': False})
    single = service.catalog()['topics'][-1]
    service.perform(1, {'action': 'book_topic', 'topicId': single['id']})
    with pytest.raises(ActionError) as conflict:
        service.perform(2, {'action': 'book_topic', 'topicId': single['id']})
    assert conflict.value.status == 409

    service.perform(ADMIN, {**base, 'title': 'Общий групповой', 'isMulti': True})
    multi = service.catalog()['topics'][-1]
    service.perform(1, {'action': 'book_topic', 'topicId': multi['id']})
    service.perform(3, {'action': 'book_topic', 'topicId': multi['id']})
    with pytest.raises(ActionError) as other_group:
        service.perform(2, {'action': 'book_topic', 'topicId': multi['id']})
    assert other_group.value.status == 409
    assert {row['user_id'] for row in service.db.get_all_bookings()
            if row['topic'] == multi['title']} == {1, 3}


def test_profile_rename_updates_booking_owner(service):
    register(service)
    service.perform(1, {'action': 'book_topic', 'topicId': 1})
    register(service, first='Пётр')
    assert service.state(1)['bookings'][0]['user'] == 'Пётр Иванов'


def test_migration_keeps_original_rows_and_creates_backup(tmp_path):
    path = tmp_path / 'legacy.db'
    with sqlite3.connect(path) as conn:
        conn.executescript('''CREATE TABLE users (user_id INTEGER PRIMARY KEY, first_name TEXT,
            last_name TEXT, group_name TEXT, registered_at TEXT);
            INSERT INTO users VALUES (1, 'Иван', 'Иванов', 'МН-4-25-01', '2026-01-01');
            CREATE TABLE bookings (id INTEGER PRIMARY KEY, topic TEXT UNIQUE, booked_by TEXT, user_id INTEGER);
            INSERT INTO bookings VALUES (1, 'Тема', 'Иван Иванов', 1);''')
        original_dump = '\n'.join(conn.iterdump())
    db = Database(path)
    db.init()
    db.init()
    assert db.get_user(1)['registered_at'] == '2026-01-01'
    assert db.get_all_bookings()[0]['group_name'] == 'МН-4-25-01'
    with sqlite3.connect(path.with_name(path.name + '.before-v2.bak')) as backup:
        assert backup.execute('PRAGMA integrity_check').fetchone()[0] == 'ok'
        assert '\n'.join(backup.iterdump()) == original_dump


def test_v7_migration_preserves_cross_group_bookings_and_locks_topic(tmp_path):
    path = tmp_path / 'v7.db'
    title = load_catalog()['topics'][0]['title']
    with sqlite3.connect(path) as conn:
        conn.executescript(f'''PRAGMA user_version=7;
            CREATE TABLE users (user_id INTEGER PRIMARY KEY, first_name TEXT, last_name TEXT,
                group_name TEXT, registered_at TEXT, username TEXT DEFAULT '');
            INSERT INTO users VALUES (1, 'Иван', 'Иванов', 'МН-4-25-01', 'x', '');
            INSERT INTO users VALUES (2, 'Пётр', 'Петров', 'МН-4-25-02', 'x', '');
            CREATE TABLE bookings (id INTEGER PRIMARY KEY, topic TEXT, booked_by TEXT,
                user_id INTEGER, group_name TEXT, created_at TEXT, UNIQUE(topic, group_name));
            INSERT INTO bookings VALUES (1, '{title}', 'Иван Иванов', 1, 'МН-4-25-01', 'x');
            INSERT INTO bookings VALUES (2, '{title}', 'Пётр Петров', 2, 'МН-4-25-02', 'x');''')
    db = Database(path)
    db.init()
    topic = next(item for item in db.get_topics(include_inactive=True) if item['id'] == 1)
    assert topic['is_common'] is True and topic['is_multi'] is False
    assert len(db.get_all_bookings()) == 2
    assert sqlite3.connect(path).execute('PRAGMA user_version').fetchone()[0] == 14


def test_db_location_does_not_follow_cwd(db, monkeypatch, tmp_path):
    other = tmp_path / 'elsewhere'
    other.mkdir()
    monkeypatch.chdir(other)
    db.save_user(1, 'Иван', 'Иванов', 'МН-4-25-01')
    assert db.get_user(1)
    assert not (other / 'schedule.db').exists()


@pytest.mark.parametrize(('deadline', 'now', 'expected'), [
    ('15.09.2026', datetime(2026, 9, 14, 19, 30), True),
    ('15.09.2026', datetime(2026, 9, 15, 0, 1), False),
    ('01.01', datetime(2026, 12, 31, 23, 59), True),
    ('01.01.2027', datetime(2026, 12, 31), True),
    ('29.02.2028', datetime(2028, 2, 28), True),
    ('31.02.2026', datetime(2026, 2, 28), False),
    ('15.09.2025', datetime(2026, 9, 14), False),
    (None, datetime(2026, 9, 14), False)])
def test_deadline_calendar(deadline, now, expected):
    assert is_deadline_tomorrow(deadline, now) is expected


def test_notifications_persist_opt_out_and_no_repeat(service):
    service.perform(ADMIN, {'action': 'create_assignment',
                            'subject': 'Управление бизнес-процессами',
                            'description': 'Подготовить схему процесса.', 'deadline': '15.09.2026'})
    register(service, 1)
    register(service, 2)
    service.perform(2, {'action': 'notification_settings', 'type': 'assignments', 'enabled': False})
    sent = []
    def sender(user_id, text):
        sent.append((user_id, text))
    check_notifications(service, sender, now=datetime(2026, 9, 14, 0, 1))
    check_notifications(service, sender, now=datetime(2026, 9, 14, 8, 59))
    assert sent == []
    check_notifications(service, sender, now=datetime(2026, 9, 14, 9, 0))
    check_notifications(service, sender, now=datetime(2026, 9, 14, 23))
    assert len(sent) == 1 and sent[0][0] == 1
    again = Database(service.db.path)
    again.init()
    assert again.get_notification_settings(2)['assignments'] is False


def test_notification_timezone_and_report_recipient(service):
    service.perform(ADMIN, {'action': 'create_assignment',
                            'subject': 'Управление бизнес-процессами',
                            'description': 'Подготовить схему процесса.', 'deadline': '15.09.2026'})
    register(service, 1)
    register(service, 2)
    service.perform(1, {'action': 'book_topic', 'topicId': 1})
    sent = []
    # 21:30 UTC is September 14 in Moscow, but still earlier than 09:00.
    check_notifications(service, lambda uid, msg: sent.append((uid, msg)),
                        now=datetime(2026, 9, 13, 21, 30, tzinfo=timezone.utc))
    assert sent == []
    check_notifications(service, lambda uid, msg: sent.append((uid, msg)),
                        now=datetime(2026, 9, 14, 6, 0, tzinfo=timezone.utc))
    assert len(sent) == 3  # Assignment: 2 users; report: its owner only.


def test_notification_failure_retries_and_claim_not_shared(db):
    db.save_user(1, 'Иван', 'Иванов', 'МН-4-25-01')
    db.enqueue_notification('assignments', 'test', 'event')
    first = db.claim_notifications(now=1000)
    assert len(first) == 1
    assert db.claim_notifications(now=1001) == []
    db.finish_notification(first[0], success=False, now=1002)
    assert db.claim_notifications(now=1061) == []
    retry = db.claim_notifications(now=1062)
    assert len(retry) == 1
    db.finish_notification(retry[0], success=True, now=1063)
    assert db.claim_notifications(now=2000) == []


def test_topic_additions_and_edits_are_group_scoped_and_batched(service):
    register(service, 1, group='МН-4-25-01')
    register(service, 2, group='МН-4-25-02')
    subject = service.catalog()['schedule'][0]['subject']
    for title in ('Новая тема один', 'Новая тема два'):
        service.perform(ADMIN, {'action': 'create_topic', 'title': title, 'subject': subject,
                                'group': 'МН-4-25-01', 'deadline': '25.09.2026'})
    assert service.db.claim_notifications() == []  # The one-minute debounce has not elapsed.
    with service.db.connection() as conn:
        conn.execute("UPDATE notification_jobs SET next_attempt=0 WHERE event_key LIKE 'topic-added:%'")
    sent = []
    check_notifications(service, lambda uid, text: sent.append((uid, text)))
    assert len(sent) == 1 and sent[0][0] == 1
    assert 'Добавлены новые темы докладов: 2' in sent[0][1]
    assert 'Новая тема один' in sent[0][1] and 'Новая тема два' in sent[0][1]

    topic = next(item for item in service.catalog()['topics'] if item['title'] == 'Новая тема один')
    service.perform(ADMIN, {'action': 'update_topic', 'topicId': topic['id'],
                            'title': 'Новая тема исправлена', 'subject': subject,
                            'group': 'МН-4-25-01', 'deadline': '26.09.2026'})
    second = next(item for item in service.catalog()['topics'] if item['title'] == 'Новая тема два')
    service.perform(ADMIN, {'action': 'update_topic', 'topicId': second['id'],
                            'title': 'Новая тема два исправлена', 'subject': subject,
                            'group': 'МН-4-25-01', 'deadline': '27.09.2026'})
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': topic['id'], 'active': False})
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': topic['id'], 'active': True})
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    service.perform(1, {'action': 'cancel_topic', 'topicId': topic['id']})
    assert service.db.claim_notifications() == []
    with service.db.connection() as conn:
        conn.execute("UPDATE notification_jobs SET next_attempt=0 WHERE event_key LIKE 'topic-changed:%'")
    sent.clear()
    check_notifications(service, lambda uid, text: sent.append((uid, text)))
    assert len(sent) == 1 and sent[0][0] == 1
    assert 'Изменены темы докладов: 2' in sent[0][1]


def test_five_notification_toggles_and_homework_edits_are_silent(service):
    register(service)
    assert service.db.get_notification_settings(1) == {
        'assignments': True, 'topics': True, 'schedule': True,
        'announcements': True, 'lessons': False}
    with pytest.raises(ValueError):
        service.db.set_notification(1, 'queue', True)
    subject = service.catalog()['schedule'][0]['subject']
    service.perform(ADMIN, {'action': 'create_assignment', 'subject': subject,
                            'description': 'Сделать домашнюю работу.', 'deadline': '25.09.2026'})
    jobs = service.db.claim_notifications()
    assert len(jobs) == 1 and jobs[0]['kind'] == 'assignments'
    service.db.finish_notification(jobs[0], success=True)
    assignment = service.catalog()['assignments'][0]
    service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': assignment['id'],
                            'subject': subject, 'description': 'Исправить домашнюю работу.',
                            'deadline': '26.09.2026'})
    service.perform(ADMIN, {'action': 'delete_assignment', 'assignmentId': assignment['id']})
    assert service.db.claim_notifications() == []


def test_lesson_reminder_is_one_daily_common_digest_with_full_details(service):
    register(service, 1, group='МН-4-25-01')
    register(service, 2, group='МН-4-25-02')
    service.perform(1, {'action': 'notification_settings', 'type': 'lessons', 'enabled': True})
    service.perform(2, {'action': 'notification_settings', 'type': 'lessons', 'enabled': True})
    assert service.db.get_notification_settings(1)['lessons'] is True
    assert service.db.get_notification_settings(2)['lessons'] is True

    lessons = [item for item in service.catalog()['schedule']
               if item['date'] == '05.09.2026']
    assert len(lessons) == 2
    urls = ['https://meet.example/first', 'https://meet.example/second']
    for lesson, url in zip(lessons, urls, strict=True):
        service.perform(ADMIN, {
            'action': 'update_lesson', 'lessonId': lesson['id'],
            'date': lesson['date'], 'time': lesson['time'], 'type': lesson['type'],
            'subject': lesson['subject'], 'teacher': lesson['teacher'],
            'room': lesson['room'], 'group': lesson['group'], 'url': url,
        })

    sent = []
    def sender(user_id, text):
        sent.append((user_id, text))
    check_notifications(service, sender, now=datetime(2026, 9, 5, 13, 59))
    assert sent == []
    check_notifications(service, sender, now=datetime(2026, 9, 5, 14, 0))
    assert len(sent) == 2 and {item[0] for item in sent} == {1, 2}
    message = sent[0][1]
    assert sent[1][1] == message
    assert lessons[0]['subject'] in message and lessons[0]['teacher'] in message
    assert '15:00' in message and '16:30' in message
    assert all(url in message for url in urls)

    # The second consecutive class must not create another notification that day.
    check_notifications(service, sender, now=datetime(2026, 9, 5, 15, 30))
    assert len(sent) == 2
    assert Database(service.db.path).get_notification_settings(1)['lessons'] is True


def test_english_lesson_reminders_follow_the_students_group(service):
    register(service, 1, group='МН-4-25-01')
    register(service, 2, group='МН-4-25-02')
    for user_id in (1, 2):
        service.perform(user_id, {'action': 'notification_settings',
                                  'type': 'lessons', 'enabled': True})
    for group, url in [('МН-4-25-01', 'https://meet.example/english-01'),
                       ('МН-4-25-02', 'https://meet.example/english-02')]:
        service.perform(ADMIN, {'action': 'create_lesson', 'date': '14.12.2026',
                                'time': '18:30-21:20', 'type': 'ПЗ',
                                'subject': ENGLISH_SUBJECT, 'teacher': 'Санжарова О.Н.',
                                'room': 'СДО', 'group': group, 'url': url})

    sent = {}
    check_notifications(service, lambda uid, msg: sent.setdefault(uid, msg),
                        now=datetime(2026, 12, 14, 17, 30))
    assert set(sent) == {1, 2}
    assert 'english-01' in sent[1] and 'english-02' not in sent[1]
    assert 'english-02' in sent[2] and 'english-01' not in sent[2]


def test_schedule_change_notification_only_after_change(db):
    db.save_user(1, 'Иван', 'Иванов', 'МН-4-25-01')
    db.set_notification(1, 'schedule', True)
    db.observe_schedule('one')
    db.observe_schedule('one')
    assert db.claim_notifications() == []
    db.observe_schedule('two')
    assert len(db.claim_notifications()) == 1


def test_homework_is_common_admin_only_and_uses_active_schedule_subjects(service):
    register(service, 1, group='МН-4-25-01')
    register(service, 2, group='МН-4-25-02')
    payload = {'action': 'create_assignment',
               'subject': 'Управление бизнес-процессами',
               'description': 'Подготовить схему бизнес-процесса.',
               'deadline': '21.09.2026'}
    with pytest.raises(ActionError) as error:
        service.perform(1, payload)
    assert error.value.status == 403
    service.perform(ADMIN, payload)
    assignment = service.catalog()['assignments'][0]
    assert service.catalog(1, public=True)['assignments'] == service.catalog(2, public=True)['assignments']
    assert assignment['subject'] == 'Управление бизнес-процессами'
    assert assignment['description'] == 'Подготовить схему бизнес-процесса.'
    assert assignment['deadline'] == '21.09.2026'
    assert Service(Database(service.db.path)).catalog()['assignments'][0]['deadline'] == '21.09.2026'
    service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': assignment['id'],
                            'subject': 'Управление бизнес-процессами',
                            'description': 'Добавить владельца и результат процесса.',
                            'deadline': '22.09.2026'})
    assert service.catalog()['assignments'][0]['description'].startswith('Добавить владельца')
    with pytest.raises(ActionError):
        service.perform(ADMIN, {**payload, 'deadline': '31.02.2026'})
    service.perform(ADMIN, {'action': 'delete_assignment', 'assignmentId': assignment['id']})
    assert service.catalog()['assignments'] == []
    for lesson in service.db.get_lessons():
        if lesson['subject'] == payload['subject']:
            service.db.set_lesson_active(lesson['id'], False)
    with pytest.raises(ActionError, match='из расписания'):
        service.perform(ADMIN, payload)


def test_multiple_admins_can_manage_topics(db):
    service = Service(db, admin_ids={ADMIN, 842525310})
    service.perform(842525310, {'action': 'create_topic', 'title': 'Тема второго администратора',
                                'subject': 'Управление бизнес-процессами'})
    assert service.state(842525310)['isAdmin'] is True
    assert service.catalog()['topics'][-1]['subject'] == 'Управление бизнес-процессами'


def test_persistent_bulk_topic_draft_preview_publication_and_audit(service):
    register(service, 1, 'МН-4-25-01')
    register(service, 2, 'МН-4-25-02')
    payload = {'action': 'add_topic_drafts',
               'titles': ['Черновик первой темы', 'Черновик второй темы'],
               'subject': 'Управление бизнес-процессами', 'deadline': '30.09.2026',
               'isCommon': False, 'isMulti': False, 'group': 'МН-4-25-01'}
    with pytest.raises(ActionError) as forbidden:
        service.perform(1, payload)
    assert forbidden.value.status == 403

    service.perform(ADMIN, payload)
    state = service.state(ADMIN)
    assert [item['title'] for item in state['topicDrafts']] == payload['titles']
    assert not any(item['title'].startswith('Черновик') for item in service.catalog()['topics'])

    service.perform(ADMIN, {'action': 'publish_topic_drafts'})
    assert service.state(ADMIN)['topicDrafts'] == []
    published = [item for item in service.catalog(1, public=True)['topics']
                 if item['title'].startswith('Черновик')]
    assert len(published) == 2 and all(item['deadline'] == '30.09.2026' for item in published)
    assert not any(item['title'].startswith('Черновик')
                   for item in service.catalog(2, public=True)['topics'])
    assert service.state(ADMIN)['auditLog'][0]['summary'] == 'Опубликовано тем: 2'

    with service.db.connection() as conn:
        conn.execute("UPDATE notification_jobs SET next_attempt=0 WHERE event_key LIKE 'topic-added:%'")
    sent = []
    check_notifications(service, lambda user_id, text: sent.append((user_id, text)))
    student_messages = [text for user_id, text in sent if user_id == 1 and 'Добавлены новые темы' in text]
    assert len(student_messages) == 1
    assert all(title in student_messages[0] for title in payload['titles'])


def test_new_deadline_drives_reminder_and_cancels_old_job(service):
    register(service)
    service.perform(ADMIN, {'action': 'create_assignment',
                            'subject': 'Управление бизнес-процессами',
                            'description': 'Подготовить схему процесса.', 'deadline': '15.09.2026'})
    assignment = service.catalog()['assignments'][0]
    service.db.enqueue_notification('assignments', 'old deadline',
                                    f'deadline:assignments:{assignment["id"]}:15.09.2026')
    service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': assignment['id'],
                            'subject': assignment['subject'], 'description': assignment['description'],
                            'deadline': '21.09.2026'})
    sent = []
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 20, 20))
    assert not any(t == 'old deadline' for t in sent)
    assert any('Срок сдачи завтра' in t and '21.09.2026' in t for t in sent)


def test_admin_topic_management_preserves_and_can_remove_bookings(service):
    register(service, 1)
    assert service.catalog()['topics'][0]['subject'] == 'Управление программами и портфелями проектов'
    with pytest.raises(ActionError) as forbidden:
        service.perform(1, {'action': 'create_topic', 'title': 'Чужая тема', 'subject': 'Предмет'})
    assert forbidden.value.status == 403
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Новая управляемая тема',
                            'subject': 'Управление бизнес-процессами', 'deadline': '25.09.2026'})
    topic = service.catalog()['topics'][-1]
    assert topic['title'] == 'Новая управляемая тема'
    assert topic['subject'] == 'Управление бизнес-процессами' and topic['deadline'] == '25.09.2026'
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    service.perform(ADMIN, {'action': 'update_topic', 'topicId': topic['id'],
                            'title': 'Переименованная тема',
                            'subject': 'Методы реализации научно-исследовательских проектов',
                            'deadline': '26.09.2026'})
    booking = service.state(1)['bookings'][0]
    assert booking['title'] == 'Переименованная тема'
    assert booking['subject'] == 'Методы реализации научно-исследовательских проектов'
    assert service.find_topic(topic['id'])['deadline'] == '26.09.2026'
    with pytest.raises(ActionError, match='из расписания'):
        service.perform(ADMIN, {'action': 'create_topic', 'title': 'Нет такого предмета',
                                'subject': 'Несуществующая дисциплина'})
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': topic['id'], 'active': False})
    assert topic['id'] not in {item['id'] for item in service.catalog()['topics']}
    admin_topic = next(item for item in service.state(ADMIN)['adminTopics'] if item['id'] == topic['id'])
    assert admin_topic['active'] is False and len(admin_topic['bookings']) == 1
    with pytest.raises(ActionError) as occupied:
        service.perform(ADMIN, {'action': 'delete_topic', 'topicId': topic['id']})
    assert occupied.value.status == 409
    service.perform(ADMIN, {'action': 'admin_cancel_booking',
                            'bookingId': admin_topic['bookings'][0]['bookingId']})
    service.perform(ADMIN, {'action': 'delete_topic', 'topicId': topic['id']})
    assert topic['id'] not in {item['id'] for item in service.state(ADMIN)['adminTopics']}


def test_admin_schedule_management_and_validation(service):
    original_count = len(service.catalog()['schedule'])
    lesson = {'date': '07.09.2026', 'time': '18:30-19:50', 'type': 'ПЗ',
              'subject': 'Новая дисциплина', 'teacher': 'Иванов И.И.',
              'room': 'СДО',
              'url': 'https://example.edu/lesson/123'}
    with pytest.raises(ActionError) as forbidden:
        service.perform(1, {'action': 'create_lesson', **lesson})
    assert forbidden.value.status == 403
    service.perform(ADMIN, {'action': 'create_lesson', **lesson})
    created = next(item for item in service.catalog()['schedule'] if item['subject'] == 'Новая дисциплина')
    assert created['day'] == 'Пн.' and created['time'] == '18.30–19.50'
    assert created['group'] == ''
    assert created['url'] == 'https://example.edu/lesson/123'
    assert len(service.catalog()['schedule']) == original_count + 1
    service.perform(ADMIN, {'action': 'update_lesson', 'lessonId': created['id'],
                            **{**lesson, 'subject': 'Обновлённая дисциплина'}})
    assert service.db.get_lesson(created['id'])['subject'] == 'Обновлённая дисциплина'
    service.perform(ADMIN, {'action': 'set_lesson_active', 'lessonId': created['id'], 'active': False})
    assert created['id'] not in {item['id'] for item in service.catalog()['schedule']}
    assert any(item['id'] == created['id'] and not item['active']
               for item in service.state(ADMIN)['adminLessons'])
    service.perform(ADMIN, {'action': 'delete_lesson', 'lessonId': created['id']})
    assert created['id'] not in {item['id'] for item in service.state(ADMIN)['adminLessons']}
    with pytest.raises(ActionError):
        service.perform(ADMIN, {'action': 'create_lesson', **{**lesson, 'time': '20:00-19:00'}})
    with pytest.raises(ActionError, match='HTTPS'):
        service.perform(ADMIN, {'action': 'create_lesson', **{**lesson, 'url': 'javascript:alert(1)'}})


def test_admin_assigns_groups_only_to_english_lessons(service):
    register(service, 1, 'МН-4-25-01')
    register(service, 2, 'МН-4-25-02')
    english = {'date': '31.12.2026', 'time': '18:30-21:20', 'type': 'ПЗ',
               'subject': ENGLISH_SUBJECT, 'teacher': 'Санжарова О.Н.',
               'room': 'СДО', 'group': 'МН-4-25-02'}
    service.perform(ADMIN, {'action': 'create_lesson', **english})
    assert not any(item['date'] == english['date']
                   for item in service.catalog(1, public=True)['schedule'])
    assert any(item['date'] == english['date'] and item['group'] == 'МН-4-25-02'
               for item in service.catalog(2, public=True)['schedule'])
    with pytest.raises(ActionError, match='Выберите группу'):
        service.perform(ADMIN, {'action': 'create_lesson', **{**english, 'group': ''}})

    common = {**english, 'date': '30.12.2026', 'subject': 'Общая дисциплина'}
    service.perform(ADMIN, {'action': 'create_lesson', **common})
    created = next(item for item in service.catalog()['schedule']
                   if item['date'] == common['date'] and item['subject'] == common['subject'])
    assert created['group'] == ''


@pytest.mark.parametrize('payload', [None, [], 'abc', {'action': 'book_topic'},
                                    {'action': 'book_topic', 'topicId': True},
                                    {'action': 'notification_settings', 'type': 'assignments', 'enabled': 'false'},
                                    {'action': 'no_such_action'}])
def test_bad_actions_return_json_errors(client, service, headers, payload):
    register(service)
    response = client.post('/api/action', data=json.dumps(payload), content_type='application/json', headers=headers())
    assert response.status_code == 400
    assert response.json['error']


def test_api_requires_auth_and_does_not_trust_query_or_body(client, service, headers):
    assert client.get('/api/state?registered=1&user_id=900').status_code == 401
    assert client.get('/api/catalog').status_code == 200
    register(service, 1)
    response = client.post('/api/action', json={'action': 'book_topic', 'topicId': 1, 'user_id': 900}, headers=headers(1))
    assert response.status_code == 200
    assert service.db.get_all_bookings()[0]['user_id'] == 1
    assert response.json['state']['isAdmin'] is False


def test_api_cors_static_and_malformed_json(client, headers):
    for path in ('/config.py', '/schedule.db', '/../config.py', '/webapp/../config.py'):
        assert client.get(path).status_code == 404
    assert client.get('/').status_code == 200
    assert client.get('/api/state', headers={**headers(), 'Origin': 'https://evil.invalid'}).status_code == 403
    response = client.options('/api/action', headers={'Origin': 'https://litvawasi-ops.github.io'})
    assert response.status_code == 204
    assert response.headers['Access-Control-Allow-Origin'] == 'https://litvawasi-ops.github.io'
    assert client.post('/api/action', data='{', content_type='application/json', headers=headers()).status_code == 400


def test_https_reverse_proxy_preserving_host(client, headers):
    response = client.get('/api/state', headers={**headers(), 'Origin': 'https://app.example.com', 'Host': 'app.example.com'})
    assert response.status_code == 200


def test_cancelled_and_expired_reminders_are_not_sent(service):
    register(service)
    service.perform(1, {'action': 'book_topic', 'topicId': 1})
    service.db.enqueue_notification('assignments', 'cancelled report', 'deadline:topics:1:15.09.2026')
    service.perform(1, {'action': 'cancel_topic', 'topicId': 1})
    service.db.enqueue_notification('assignments', 'old reminder', 'deadline:assignments:2:17.09.2026')
    sent = []
    check_notifications(service, lambda uid, msg: sent.append(msg), now=datetime(2026, 9, 14, 20))
    assert 'cancelled report' not in sent
    assert 'old reminder' not in sent


@pytest.mark.parametrize('kind', [None, [], {}, 12])
def test_invalid_notification_type_does_not_crash(client, service, headers, kind):
    register(service)
    response = client.post('/api/action', json={'action': 'notification_settings', 'type': kind, 'enabled': True}, headers=headers())
    assert response.status_code == 400


def test_aggregate_admin_stats_counts_sessions_and_notification_preferences(client, service, headers):
    register(service, 1)
    register(service, 2, 'МН-4-25-02')
    service.db.set_notification(1, 'lessons', True)
    service.db.set_notification(2, 'assignments', False)

    assert client.post('/api/visit').status_code == 401
    assert client.post('/api/visit', json={}, headers=headers(1)).status_code == 200
    with service.db.connection() as conn:
        conn.execute('DELETE FROM activity_daily')

    first = datetime(2026, 9, 9, 10, 0, tzinfo=timezone.utc)
    assert service.db.record_visit(1, first) is True
    assert service.db.record_visit(1, datetime(2026, 9, 9, 10, 20, tzinfo=timezone.utc)) is False
    assert service.db.record_visit(1, datetime(2026, 9, 9, 11, 0, tzinfo=timezone.utc)) is True
    assert service.db.record_visit(2, datetime(2026, 9, 9, 11, 5, tzinfo=timezone.utc)) is True
    assert service.db.record_visit(1, datetime(2026, 9, 10, 7, 0, tzinfo=timezone.utc)) is True

    stats = service.db.get_admin_stats(today='2026-09-10')
    assert len(stats['dailyVisits']) == 30
    assert stats['dailyVisits'][-2:] == [
        {'date': '2026-09-09', 'visits': 3}, {'date': '2026-09-10', 'visits': 1}]
    assert stats['visitsToday'] == 1
    assert stats['visits7Days'] == 4
    assert stats['visits30Days'] == 4
    assert stats['registeredUsers'] == 2
    preferences = {item['kind']: item for item in stats['notifications']}
    assert preferences['assignments'] == {'kind': 'assignments', 'enabled': 1, 'percent': 50}
    assert preferences['topics']['enabled'] == 2
    assert preferences['schedule']['enabled'] == 2
    assert preferences['announcements']['enabled'] == 2
    assert preferences['lessons'] == {'kind': 'lessons', 'enabled': 1, 'percent': 50}
    assert 'adminStats' in service.state(ADMIN)
    assert 'adminStats' not in service.state(1)


def test_announcements_are_admin_only_and_default_notification_is_sent(service):
    register(service, 1)
    register(service, 2, 'МН-4-25-02')
    with pytest.raises(ActionError) as denied:
        service.perform(1, {'action': 'create_announcement', 'title': 'Важное сообщение',
                            'body': 'Текст для всех студентов.'})
    assert getattr(denied.value, 'status', None) == 403

    service.perform(ADMIN, {'action': 'create_announcement', 'title': 'Важное сообщение',
                            'body': 'Текст для всех студентов.', 'url': 'https://example.edu/news'})
    state = service.state(1)
    assert state['announcements'][0]['title'] == 'Важное сообщение'
    assert state['notifications']['announcements'] is True
    jobs = service.db.claim_notifications()
    assert {job['user_id'] for job in jobs} == {1, 2}
    assert all(job['kind'] == 'announcements' for job in jobs)

    announcement_id = state['announcements'][0]['id']
    service.perform(ADMIN, {'action': 'update_announcement', 'announcementId': announcement_id,
                            'title': 'Обновлённое сообщение', 'body': 'Новый текст.'})
    assert service.state(1)['announcements'][0]['title'] == 'Обновлённое сообщение'
    service.perform(ADMIN, {'action': 'delete_announcement', 'announcementId': announcement_id})
    assert service.state(1)['announcements'] == []
    assert service.db.claim_notifications(now=time.time() + 1000) == []


def test_presentation_queue_is_automatic_and_has_one_slot_per_booked_report(service, monkeypatch):
    today = '14.12.2099'
    subject = 'Управление бизнес-процессами'
    monkeypatch.setattr(Service, '_today_string', staticmethod(lambda: today))
    register(service, 1)
    register(service, 2)
    register(service, 3)
    service.perform(ADMIN, {'action': 'create_lesson', 'date': today, 'time': '10:00–11:30',
                            'type': 'Л', 'subject': subject, 'teacher': 'И. И. Иванов',
                            'room': 'Онлайн', 'url': 'https://example.edu/lesson'})
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Первый доклад',
                            'subject': subject, 'deadline': today, 'isCommon': False,
                            'isMulti': False, 'group': 'МН-4-25-01'})
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Доклад с соавторами',
                            'subject': subject, 'deadline': today, 'isCommon': False,
                            'isMulti': True, 'group': 'МН-4-25-01'})
    topics = {item['title']: item for item in service.topics()}
    service.perform(1, {'action': 'book_topic', 'topicId': topics['Первый доклад']['id']})
    service.perform(2, {'action': 'book_topic', 'topicId': topics['Доклад с соавторами']['id']})
    service.perform(3, {'action': 'book_topic', 'topicId': topics['Доклад с соавторами']['id']})

    queue = service.state(2)['presentationQueues'][0]
    assert queue['date'] == today
    assert queue['slotCount'] == 2
    assert len(queue['reports']) == 2
    assert len(next(item for item in queue['reports'] if item['title'] == 'Доклад с соавторами')['owners']) == 2

    service.perform(2, {'action': 'choose_presentation_position', 'date': today,
                        'subject': subject, 'topicId': topics['Доклад с соавторами']['id'],
                        'position': 1})
    assert service.state(3)['presentationQueues'][0]['reports'][0]['position'] == 1
    with pytest.raises(ActionError, match='место уже занято'):
        service.perform(1, {'action': 'choose_presentation_position', 'date': today,
                            'subject': subject, 'topicId': topics['Первый доклад']['id'],
                            'position': 1})
    service.perform(3, {'action': 'leave_presentation_queue', 'date': today,
                        'subject': subject, 'topicId': topics['Доклад с соавторами']['id']})
    assert all(item['position'] is None for item in service.state(2)['presentationQueues'][0]['reports'])
    service.perform(ADMIN, {'action': 'set_topic_active',
                            'topicId': topics['Доклад с соавторами']['id'], 'active': False})
    assert service.state(2)['presentationQueues'][0]['slotCount'] == 1
    service.perform(ADMIN, {'action': 'set_topic_active',
                            'topicId': topics['Первый доклад']['id'], 'active': False})
    assert service.state(2)['presentationQueues'] == []


def test_presentation_queue_requires_matching_lesson_and_deadline(service, monkeypatch):
    today = '14.12.2099'
    monkeypatch.setattr(Service, '_today_string', staticmethod(lambda: today))
    register(service, 1)
    today_subjects = {item['subject'] for item in service.catalog()['schedule']
                      if item['date'] == today}
    subject = next(item['subject'] for item in service.catalog()['schedule']
                   if item['subject'] not in today_subjects)
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Доклад без сегодняшней пары',
                            'subject': subject, 'deadline': today,
                            'isCommon': False, 'isMulti': False, 'group': 'МН-4-25-01'})
    topic = next(item for item in service.topics() if item['title'] == 'Доклад без сегодняшней пары')
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    assert service.state(1)['presentationQueues'] == []


def test_admin_uploads_material_and_students_can_download_it(client, headers):
    denied = client.post('/api/upload', data={'file': (io.BytesIO(b'hello'), 'homework.pdf')},
                         headers=headers(1), content_type='multipart/form-data')
    assert denied.status_code == 403
    response = client.post('/api/upload', data={'file': (io.BytesIO(b'hello'), 'Домашка.pdf')},
                           headers=headers(ADMIN), content_type='multipart/form-data')
    assert response.status_code == 200
    assert response.json['path'].startswith('/files/') and response.json['path'].endswith('.pdf')
    download = client.get(response.json['path'])
    assert download.status_code == 200 and download.data == b'hello'
    assert download.headers['Content-Disposition'].startswith('inline')
    invalid = client.post('/api/upload', data={'file': (io.BytesIO(b'bad'), 'script.exe')},
                          headers=headers(ADMIN), content_type='multipart/form-data')
    assert invalid.status_code == 400


def test_resource_links_archives_and_report_deadline_reminder(service):
    register(service, 1)
    subject = 'Управление бизнес-процессами'
    homework_url = 'https://example.edu/homework/1'
    service.perform(ADMIN, {'action': 'create_assignment', 'subject': subject,
                            'description': 'Архивное задание с материалами.',
                            'deadline': '01.01.2000', 'url': homework_url})
    assignment = service.catalog()['assignments'][-1]
    assert assignment['archived'] is True and assignment['url'] == homework_url
    updated_homework_url = 'https://example.edu/homework/updated'
    service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': assignment['id'],
                            'subject': subject, 'description': assignment['description'],
                            'deadline': assignment['deadline'], 'url': updated_homework_url})
    assert service.catalog()['assignments'][-1]['url'] == updated_homework_url

    archived_url = 'https://example.edu/reports/archive'
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Архивный доклад',
                            'subject': subject, 'group': 'МН-4-25-01',
                            'deadline': '01.01.2000', 'url': archived_url})
    archived = next(item for item in service.catalog(1, public=True)['topics']
                    if item['title'] == 'Архивный доклад')
    assert archived['archived'] is True and archived['url'] == archived_url
    assert archived['id'] not in {item['id'] for item in service.catalog()['topics']}
    with pytest.raises(ActionError, match='архиве'):
        service.perform(1, {'action': 'book_topic', 'topicId': archived['id']})

    report_url = 'https://example.edu/reports/active'
    service.perform(ADMIN, {'action': 'create_topic', 'title': 'Доклад с материалами',
                            'subject': subject, 'group': 'МН-4-25-01',
                            'deadline': '31.12.2099', 'url': report_url})
    topic = next(item for item in service.catalog()['topics']
                 if item['title'] == 'Доклад с материалами')
    edited_url = 'https://example.edu/reports/updated'
    service.perform(ADMIN, {'action': 'update_topic', 'topicId': topic['id'],
                            'title': topic['title'], 'subject': subject,
                            'group': 'МН-4-25-01', 'deadline': '31.12.2099',
                            'url': edited_url})
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    with service.db.connection() as conn:
        conn.execute('UPDATE notification_jobs SET sent_at=0 WHERE sent_at IS NULL')
    sent = []
    check_notifications(service, lambda uid, message: sent.append((uid, message)),
                        now=datetime(2099, 12, 30, 12, 0))
    assert sent == [(1, f'🔔 Срок сдачи завтра\nДоклад с материалами\n'
                        f'📅 31.12.2099\n🔗 Материалы: {edited_url}')]
    with pytest.raises(ActionError, match='HTTPS'):
        service.perform(ADMIN, {'action': 'create_assignment', 'subject': subject,
                                'description': 'Неверная ссылка.', 'deadline': '31.12.2099',
                                'url': 'http://example.edu/file'})
