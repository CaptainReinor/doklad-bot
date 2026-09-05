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
from service import ActionError, Service, clean_group


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


def test_duplicate_and_legacy_payload_are_idempotent(service):
    register(service)
    topic = load_catalog()['topics'][0]
    for value in [topic, topic['title']]:
        service.perform(1, {'action': 'book_topic', 'topic': value})
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
    topic = db.get_topic(1)
    assert topic['is_common'] is True and topic['is_multi'] is False
    assert len(db.get_all_bookings()) == 2
    assert sqlite3.connect(path).execute('PRAGMA user_version').fetchone()[0] == 9


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
    check_notifications(service, sender, now=datetime(2026, 9, 14, 19))
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
    # 21:30 UTC is already September 14 in Moscow.
    check_notifications(service, lambda uid, msg: sent.append((uid, msg)),
                        now=datetime(2026, 9, 13, 21, 30, tzinfo=timezone.utc))
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


def test_topic_additions_are_group_scoped_batched_and_edits_are_silent(service):
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
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': topic['id'], 'active': False})
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': topic['id'], 'active': True})
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    service.perform(1, {'action': 'cancel_topic', 'topicId': topic['id']})
    assert service.db.claim_notifications() == []


def test_only_three_notification_toggles_and_homework_edits_are_silent(service):
    register(service)
    assert service.db.get_notification_settings(1) == {
        'assignments': True, 'topics': True, 'schedule': True}
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


def test_schedule_change_notification_only_after_change(db):
    db.save_user(1, 'Иван', 'Иванов', 'МН-4-25-01')
    db.set_notification(1, 'schedule', True)
    db.observe_schedule('one')
    db.observe_schedule('one')
    assert db.claim_notifications() == []
    db.observe_schedule('two')
    assert len(db.claim_notifications()) == 1


def test_homework_is_admin_only_validated_persistent_and_removable(service):
    payload = {'action': 'create_assignment',
               'subject': 'Управление бизнес-процессами',
               'description': 'Подготовить схему бизнес-процесса.',
               'deadline': '21.09.2026'}
    with pytest.raises(ActionError) as error:
        service.perform(1, payload)
    assert error.value.status == 403
    service.perform(ADMIN, payload)
    assignment = service.catalog()['assignments'][0]
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


def test_multiple_admins_can_manage_topics(db):
    service = Service(db, admin_ids={ADMIN, 842525310})
    service.perform(842525310, {'action': 'create_topic', 'title': 'Тема второго администратора',
                                'subject': 'Управление бизнес-процессами'})
    assert service.state(842525310)['isAdmin'] is True
    assert service.catalog()['topics'][-1]['subject'] == 'Управление бизнес-процессами'


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
              'room': 'СДО', 'group': 'мн - 4 - 25 - 01',
              'url': 'https://example.edu/lesson/123'}
    with pytest.raises(ActionError) as forbidden:
        service.perform(1, {'action': 'create_lesson', **lesson})
    assert forbidden.value.status == 403
    service.perform(ADMIN, {'action': 'create_lesson', **lesson})
    created = next(item for item in service.catalog()['schedule'] if item['subject'] == 'Новая дисциплина')
    assert created['day'] == 'Пн.' and created['time'] == '18.30–19.50'
    assert created['group'] == 'МН-4-25-01'
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


@pytest.mark.parametrize('payload', [None, [], 'abc', {'action': 'book_topic', 'topic': {}},
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
