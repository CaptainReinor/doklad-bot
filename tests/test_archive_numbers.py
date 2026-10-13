from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import ADMIN, register

from database import Database
from service import ActionError

SUBJECT = 'Управление бизнес-процессами'


def create(service, title, number, deadline='30.09.2026'):
    service.perform(ADMIN, {'action': 'create_topic', 'title': title, 'number': number,
                            'subject': SUBJECT, 'deadline': deadline, 'group': 'МН-4-25-01'})
    return next(item for item in service.topics(include_inactive=True) if item['title'] == title)


@pytest.mark.parametrize('explicit', [True, False])
def test_drafts_reuse_manual_and_expired_archive_numbers(service, explicit):
    register(service)
    manual = create(service, 'Архив вручную', 1)
    service.perform(1, {'action': 'book_topic', 'topicId': manual['id']})
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': manual['id'], 'active': False})
    expired = create(service, 'Архив по сроку', 2, '13.09.2026')
    bookings = service.db.get_all_bookings()
    payload = {'action': 'add_topic_drafts', 'titles': ['Новая первая', 'Новая вторая', 'Новая третья'],
               'subject': SUBJECT, 'deadline': '30.09.2026', 'group': 'МН-4-25-01'}
    if explicit:
        payload['startNumber'] = 1
    service.perform(ADMIN, payload)
    service.perform(ADMIN, {'action': 'publish_topic_drafts'})
    current = [item for item in service.topics() if item['subject'] == SUBJECT]
    assert [(item['number'], item['title']) for item in current] == [
        (1, 'Новая первая'), (2, 'Новая вторая'), (3, 'Новая третья')]
    assert service.find_topic(manual['id'], include_inactive=True)['number'] == 1
    assert service.find_topic(expired['id'], include_inactive=True)['number'] == 2
    assert service.db.get_all_bookings() == bookings
    assert service.state(ADMIN)['topicDrafts'] == []
    Database(service.db.path).init()
    assert service.find_topic(manual['id'], include_inactive=True)['number'] == 1
    assert len([item for item in service.topics() if item['subject'] == SUBJECT]) == 3


def test_draft_collision_with_current_topic_rolls_back_entire_batch(service):
    create(service, 'Занятая третья', 3)
    service.perform(ADMIN, {'action': 'add_topic_drafts', 'titles': ['Первая из пакета', 'Вторая из пакета'],
                            'subject': SUBJECT, 'deadline': '30.09.2026', 'startNumber': 2,
                            'group': 'МН-4-25-01'})
    drafts = service.state(ADMIN)['topicDrafts']
    jobs = service.db.claim_notifications(now=0)
    with pytest.raises(ActionError, match='уже есть тема с таким номером'):
        service.perform(ADMIN, {'action': 'publish_topic_drafts'})
    assert service.state(ADMIN)['topicDrafts'] == drafts
    assert not any(item['title'] == 'Первая из пакета' for item in service.topics(include_inactive=True))
    assert service.db.claim_notifications(now=0) == jobs


def test_current_number_conflicts_remain_protected_when_restoring_archive(service):
    old = create(service, 'Старая тема', 1)
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': old['id'], 'active': False})
    create(service, 'Новая тема', 1)
    with pytest.raises(ActionError, match='уже есть тема с таким номером'):
        service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': old['id'], 'active': True})
    assert service.find_topic(old['id'], include_inactive=True)['archived']
    service.perform(ADMIN, {'action': 'update_topic', 'topicId': old['id'], 'title': old['title'],
                            'subject': SUBJECT, 'number': 2, 'group': 'МН-4-25-01'})
    service.perform(ADMIN, {'action': 'set_topic_active', 'topicId': old['id'], 'active': True})
    assert {item['number'] for item in service.topics() if item['subject'] == SUBJECT} == {1, 2}


def test_expired_topic_deadline_cannot_create_current_duplicate_or_partial_edit(service):
    old = create(service, 'Прошедшая тема', 1, '13.09.2026')
    create(service, 'Текущая тема', 1)
    with pytest.raises(ActionError):
        service.perform(ADMIN, {'action': 'set_deadline', 'kind': 'topics',
                                'itemId': old['id'], 'deadline': '30.09.2026'})
    with pytest.raises(ActionError):
        service.perform(ADMIN, {'action': 'update_topic', 'topicId': old['id'],
                                'title': 'Не сохранять частично', 'subject': SUBJECT,
                                'number': 1, 'deadline': '30.09.2026', 'group': 'МН-4-25-01'})
    assert service.find_topic(old['id'], include_inactive=True)['title'] == old['title']
    assert service.find_topic(old['id'], include_inactive=True)['deadline'] == '13.09.2026'


def test_two_parallel_draft_publications_cannot_take_the_same_current_number(service):
    payload = {'action': 'add_topic_drafts', 'subject': SUBJECT, 'deadline': '30.09.2026',
               'startNumber': 1, 'group': 'МН-4-25-01'}
    service.perform(ADMIN, {**payload, 'titles': ['Первая публикация']})
    service.db.add_topic_drafts(901, [{'title': 'Вторая публикация', 'subject': SUBJECT,
        'deadline': '30.09.2026', 'display_number': 1, 'group_name': 'МН-4-25-01',
        'is_common': False, 'is_multi': False}])
    def publish(actor):
        try:
            service.db.publish_topic_drafts(actor, today='14.09.2026')
            return True
        except ValueError:
            return False
    with ThreadPoolExecutor(max_workers=2) as pool:
        assert sum(pool.map(publish, [ADMIN, 901])) == 1
    assert len([item for item in service.topics() if item['subject'] == SUBJECT]) == 1
