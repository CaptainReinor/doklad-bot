from datetime import datetime, timezone

import pytest
from conftest import ADMIN, register

from attendance import DATES, GROUP, SETTINGS_KEY, SUBJECT, default_settings
from database import Database
from notifications import check_notifications, notification_html
from service import ActionError


def students(service):
    register(service, 1, 'МН-4-25-01')
    register(service, 2, GROUP)
    register(service, 3, GROUP)


def save(service, **changes):
    value = {**default_settings(), **changes}
    service.perform(ADMIN, {'action': 'save_attendance_reminder', 'settings': value})
    return value


@pytest.mark.parametrize('day', DATES)
def test_only_group_two_once_on_each_verified_date_at_1900(service, day):
    students(service)
    date = datetime.strptime(day, '%d.%m.%Y')
    sent = []
    def sender(uid, text):
        sent.append((uid, text))
    check_notifications(service, sender, now=date.replace(hour=18, minute=59, second=59))
    assert sent == []
    check_notifications(service, sender, now=date.replace(hour=19))
    assert [uid for uid, _ in sent] == [2, 3]
    assert all(SUBJECT in text and 'Кучина О.В.' in text and 'СДО' in text for _, text in sent)
    check_notifications(service, sender, now=date.replace(hour=19, minute=1))
    check_notifications(service, sender, now=date.replace(hour=23, minute=59))
    service.db.init()
    check_notifications(service, sender, now=date.replace(hour=23, minute=59))
    assert len(sent) == 2


@pytest.mark.parametrize('day', ['01.10.2026', '15.10.2026', '22.10.2026', '29.10.2026',
                                 '05.11.2026', '19.11.2026', '24.11.2026', '01.12.2026',
                                 '16.10.2026', '09.01.2027'])
def test_shared_first_group_and_other_subject_dates_are_excluded(service, day):
    students(service)
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid),
                        now=datetime.strptime(day, '%d.%m.%Y').replace(hour=19))
    assert sent == []


def test_time_is_moscow_and_independent_of_lesson_preferences(service):
    students(service)
    service.perform(3, {'action': 'notification_settings', 'type': 'attendance', 'enabled': False})
    assert service.db.get_notification_settings(2)['lessons'] is False
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid),
                        now=datetime(2026, 10, 17, 15, 59, tzinfo=timezone.utc))
    assert sent == []
    check_notifications(service, lambda uid, text: sent.append(uid),
                        now=datetime(2026, 10, 17, 16, tzinfo=timezone.utc))
    assert sent == [2]
    with pytest.raises(ActionError) as denied:
        service.perform(1, {'action': 'notification_settings', 'type': 'attendance', 'enabled': True})
    assert denied.value.status == 403


def test_admin_can_change_time_dates_link_and_persist_after_restart(service):
    students(service)
    value = save(service, time='20:15', dates=['17.10.2026'], url='https://sdo.example.edu/course?id=1&x=2')
    again = Database(service.db.path)
    again.init()
    assert again.get_attendance_settings() == value
    sent = []
    def sender(uid, text):
        sent.append((uid, text))
    check_notifications(service, sender, now=datetime(2026, 10, 17, 19))
    assert sent == []
    check_notifications(service, sender, now=datetime(2026, 10, 17, 20, 15))
    assert len(sent) == 2
    assert 'href="https://sdo.example.edu/course?id=1&amp;x=2">Открыть СДО</a>' in notification_html(sent[0][1])
    check_notifications(service, sender, now=datetime(2026, 10, 24, 20, 15))
    assert len(sent) == 2
    save(service, enabled=False)
    check_notifications(service, sender, now=datetime(2026, 10, 31, 20))
    assert len(sent) == 2


def test_settings_are_admin_only_and_first_group_never_receives_attendance(service, client, headers):
    students(service)
    response = client.post('/api/action', headers=headers(2), json={
        'action': 'save_attendance_reminder', 'settings': default_settings()})
    assert response.status_code == 403
    assert 'attendanceReminder' not in service.state(2)
    assert 'attendanceReminder' in service.state(ADMIN)
    assert service.db.get_notification_settings(1)['attendance'] is False
    stat = next(row for row in service.db.get_admin_stats()['notifications'] if row['kind'] == 'attendance')
    assert stat == {'kind': 'attendance', 'enabled': 2, 'eligibleUsers': 2, 'percent': 100}


@pytest.mark.parametrize('changes', [{'enabled': 'yes'}, {'time': '24:00'}, {'time': {}},
    {'dates': ['01.10.2026']}, {'dates': ['15.10.2026']}, {'dates': ['24.11.2026']},
    {'dates': ['17.10.2026'] * 2}, {'dates': {}}, {'url': 'javascript:alert(1)'},
    {'url': 'https://login:password@example.edu'}, {'url': ['https://example.edu']}])
def test_invalid_configuration_does_not_change_saved_settings(service, changes):
    before = service.db.get_attendance_settings()
    with pytest.raises(ActionError):
        save(service, **changes)
    assert service.db.get_attendance_settings() == before


def test_retries_follow_admin_changes_and_do_not_leak_after_group_change(service):
    register(service, 2, GROUP)
    def offline(uid, text):
        raise ConnectionError()
    check_notifications(service, offline, now=datetime(2026, 10, 17, 19))
    save(service, time='20:00')
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 19, 30))
    assert sent == []
    service.db.save_user(2, 'Иван', 'Иванов', 'МН-4-25-01')
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 20))
    assert sent == []


def test_failed_reminder_is_cancelled_by_disabling_or_removing_date(service):
    register(service, 2, GROUP)
    def offline(uid, text):
        raise ConnectionError()
    check_notifications(service, offline, now=datetime(2026, 10, 17, 19))
    save(service, dates=['24.10.2026'])
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 20))
    assert sent == []
    save(service, enabled=False)
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 24, 20))
    assert sent == []


def test_delayed_retry_is_not_delivered_on_the_next_day(service):
    register(service, 2, GROUP)
    def offline(uid, text):
        raise ConnectionError()
    check_notifications(service, offline, now=datetime(2026, 10, 17, 23, 59))
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 18, 0, 5))
    assert sent == []


def test_rescheduling_after_success_cannot_send_twice(service):
    register(service, 2, GROUP)
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 19))
    save(service, time='20:00')
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 20))
    assert sent == [2]


def test_group_is_rechecked_after_claim_and_shared_calendar_does_not_drive_attendance(service, monkeypatch):
    register(service, 2, GROUP)
    with service.db.connection() as conn:
        conn.execute('UPDATE lessons SET active=0')
    original = service.db.claim_notifications
    def change_group(**kwargs):
        jobs = original(**kwargs)
        service.db.save_user(2, 'Иван', 'Иванов', 'МН-4-25-01')
        return jobs
    monkeypatch.setattr(service.db, 'claim_notifications', change_group)
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 19))
    assert sent == []


def test_corrupted_settings_fail_closed_and_can_be_repaired(service):
    with service.db.connection() as conn:
        conn.execute('UPDATE app_meta SET value=? WHERE key=?', ('broken', SETTINGS_KEY))
    assert service.db.get_attendance_settings()['enabled'] is False
    save(service)
    assert service.db.get_attendance_settings() == default_settings()


def test_shared_timetable_does_not_drive_attendance(service):
    register(service, 2, GROUP)
    with service.db.connection() as conn:
        conn.execute('UPDATE lessons SET active=0')
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid), now=datetime(2026, 10, 17, 19))
    assert sent == [2]


def test_slow_delivery_cannot_cross_midnight(service, monkeypatch):
    from zoneinfo import ZoneInfo
    register(service, 2, GROUP)
    times = iter([datetime(2026, 10, 17, 23, 59, tzinfo=ZoneInfo('Europe/Moscow')),
                  datetime(2026, 10, 18, 0, 0, tzinfo=ZoneInfo('Europe/Moscow'))])
    monkeypatch.setattr('notifications.study_now', lambda: next(times))
    sent = []
    check_notifications(service, lambda uid, text: sent.append(uid))
    assert sent == []


def test_admin_reschedule_during_delivery_keeps_daily_deduplication(service):
    students(service)
    sent = []
    def sender(uid, text):
        sent.append(uid)
        if len(sent) == 1:
            save(service, time='20:00')
    check_notifications(service, sender, now=datetime(2026, 10, 17, 19))
    assert sent == [2]
    check_notifications(service, sender, now=datetime(2026, 10, 17, 20))
    assert sent == [2, 3]
