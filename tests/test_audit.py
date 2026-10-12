from datetime import datetime

import pytest
from conftest import ADMIN, register

from database import BookingConflict
from notifications import check_notifications, send_notification
from service import ActionError


def test_malformed_origin_is_rejected(client, headers):
    response = client.get('/api/state', headers={**headers(), 'Origin': 'http://[invalid'})
    assert response.status_code == 403


@pytest.mark.parametrize('action', [None, [], {}, 123, True])
def test_malformed_action_returns_400(client, headers, action):
    response = client.post('/api/action', json={'action': action}, headers=headers(ADMIN))
    assert response.status_code == 400


@pytest.mark.parametrize('time', [[], {}, 123, True])
def test_malformed_lesson_time_returns_400(client, headers, time):
    response = client.post('/api/action', headers=headers(ADMIN), json={
        'action': 'create_lesson', 'date': '20.09.2026', 'time': time,
        'subject': 'Управление бизнес-процессами', 'teacher': 'Золотухин И.В.',
        'room': 'СДО', 'type': 'ПЗ', 'group': ''})
    assert response.status_code == 400


def test_pending_homework_notification_is_updated_and_deleted(service):
    register(service)
    item = service.db.create_assignment('Управление бизнес-процессами', 'Старое', '25.09.2026')
    service.db.update_assignment(item['id'], item['subject'], 'Новое', '26.09.2026')
    sent = []
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 12))
    assert len(sent) == 1 and 'Новое' in sent[0] and '26.09.2026' in sent[0]
    item = service.db.create_assignment(item['subject'], 'Удалённое', '25.09.2026')
    service.db.delete_assignment(item['id'])
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 12))
    assert len(sent) == 1


def test_lesson_retry_after_all_classes_is_discarded(service):
    register(service)
    service.db.set_notification(1, 'lessons', True)
    sent = []
    def offline(uid, text):
        raise ConnectionError()
    check_notifications(service, offline, now=datetime(2026, 9, 5, 14))
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 5, 23))
    assert sent == []
    assert service.db.claim_notifications(now=datetime(2026, 9, 6).timestamp()) == []


def test_rescheduled_lesson_retry_waits_for_new_start(service):
    register(service)
    service.db.set_notification(1, 'lessons', True)
    data = {'date': '14.09.2026', 'day': 'Понедельник', 'time': '13:00-14:20',
            'type': 'ПЗ', 'subject': 'Управление бизнес-процессами',
            'teacher': 'Золотухин И.В.', 'room': 'СДО', 'group': '', 'url': ''}
    lesson = service.db.create_lesson(data)
    def offline(uid, text):
        raise ConnectionError()
    check_notifications(service, offline, now=datetime(2026, 9, 14, 12))
    service.db.update_lesson(lesson['id'], {**data, 'time': '18:00-19:20',
                             'teacher': 'Новый преподаватель', 'url': 'https://meet.example/new'})
    sent = []
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 12, 10))
    assert sent == []
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 17))
    assert len(sent) == 1 and '18:00' in sent[0] and 'Новый преподаватель' in sent[0]
    assert 'https://meet.example/new' in sent[0]


def test_notification_chunks_keep_links_and_unicode_intact():
    messages = []
    text = ('Большой список <тем> & заданий\n' * 400 +
            'Материалы: https://example.edu/file.pdf?x=1&y=2\n' + '🧑' * 3000)
    send_notification(lambda uid, message, **kwargs: messages.append((message, kwargs)), 1, text)
    assert len(messages) > 2
    assert sum('href=' in msg for msg, _ in messages) == 1
    assert any('x=1&amp;y=2' in msg for msg, _ in messages)
    assert all(kwargs == {'parse_mode': 'HTML', 'disable_web_page_preview': True}
               for _, kwargs in messages)
    # HTML entities are longer on the wire; Telegram counts the parsed text.
    assert all(len(msg.replace('&lt;', '<').replace('&gt;', '>').replace('&amp;', '&').encode('utf-16-le')) // 2
               <= 3600 for msg, _ in messages)


def test_editing_topic_with_same_deadline_keeps_morning_reminder(service):
    register(service)
    topic = service.db.create_topic('Доклад до правки', 'Управление бизнес-процессами', True, False, '')
    service.db.set_deadline('topics', topic['id'], '15.09.2026')
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    with service.db.connection() as conn:
        conn.execute('UPDATE notification_jobs SET sent_at=0')
    sent = []
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 0, 1))
    assert sent == []
    service.db.update_topic(topic['id'], 'Доклад после правки', topic['subject'], True, False, '')
    service.db.set_deadline('topics', topic['id'], '15.09.2026')
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 9))
    assert len(sent) == 1 and 'Доклад после правки' in sent[0]
    assert 'Доклад до правки' not in sent[0]


def test_editing_homework_refreshes_pending_deadline_message(service):
    register(service)
    item = service.db.create_assignment('Управление бизнес-процессами', 'Старая домашка', '15.09.2026')
    with service.db.connection() as conn:
        conn.execute('UPDATE notification_jobs SET sent_at=0')
    sent = []
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 0, 1))
    service.db.update_assignment(item['id'], item['subject'], 'Новая домашка', '15.09.2026')
    check_notifications(service, lambda uid, text: sent.append(text), now=datetime(2026, 9, 14, 9))
    assert len(sent) == 1 and 'Новая домашка' in sent[0]


def test_booking_rechecks_topic_within_transaction(service, monkeypatch):
    register(service)
    topic = service.topics()[0]
    original = service.db.book
    def archive_before_booking(data, uid, **kwargs):
        service.db.set_topic_active(topic['id'], False)
        return original(data, uid, **kwargs)
    monkeypatch.setattr(service.db, 'book', archive_before_booking)
    with pytest.raises(ActionError, match='архиве'):
        service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    assert service.db.get_all_bookings() == []


def test_option_deadline_race_preserves_previous_choice(service):
    register(service)
    item = service.db.create_assignment('Управление бизнес-процессами', 'Выбор', '25.09.2026')
    service.db._attach_assignment_options(item['id'], item['subject'], [(1, 'Первая', ''), (2, 'Вторая', '')])
    service.db.choose_assignment_option(item['id'], 1, 1, today='14.09.2026')
    service.db.update_assignment(item['id'], item['subject'], item['description'], '13.09.2026')
    with pytest.raises(BookingConflict, match='прошёл'):
        service.db.choose_assignment_option(item['id'], 2, 1, today='14.09.2026')
    with service.db.connection() as conn:
        assert conn.execute('SELECT option_number FROM assignment_options WHERE claimed_by=1').fetchone()[0] == 1
