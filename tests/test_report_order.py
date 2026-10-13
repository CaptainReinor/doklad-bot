import pytest
from conftest import ADMIN, register

from service import ActionError


def test_legacy_report_queue_is_hidden_and_cannot_be_changed(service):
    register(service)
    topic = service.topics()[0]
    service.perform(1, {'action': 'book_topic', 'topicId': topic['id']})
    service.db.set_presentation_position('14.09.2026', topic['subject'], topic['id'], 1, 1, 1)
    before = service.db.get_presentation_positions('14.09.2026', topic['subject'])
    assert service.state(1)['presentationQueues'] == []
    for action in ('choose_presentation_position', 'leave_presentation_queue'):
        with pytest.raises(ActionError, match='отключён') as error:
            service.perform(1, {'action': action, 'date': '14.09.2026',
                                'topicId': topic['id'], 'subject': topic['subject'], 'position': 1})
        assert error.value.status == 409
    assert service.db.get_presentation_positions('14.09.2026', topic['subject']) == before
    assert service.db.get_all_bookings()


@pytest.mark.parametrize('subject', ['Управление бизнес-процессами',
                                    'Методы реализации научно-исследовательских проектов'])
def test_zolotukhin_lesson_list_still_accepts_presentations(service, subject):
    register(service)
    service.perform(ADMIN, {'action': 'create_lesson', 'date': '15.09.2026',
                            'time': '18:30-21:20', 'type': 'ПЗ', 'subject': subject,
                            'teacher': 'Золотухин В.А.', 'room': 'СДО', 'group': ''})
    lesson = max((item for item in service.catalog()['schedule'] if item['subject'] == subject),
                 key=lambda item: item['id'])
    service.perform(1, {'action': 'save_student_presentation', 'lessonId': lesson['id'],
                        'topic': 'Моя тема выступления', 'position': 7})
    queue = next(q for q in service.state(1)['studentPresentations'] if q['lessonId'] == lesson['id'])
    assert queue['editable'] and queue['entries'][0]['position'] == 7
    assert queue['entries'][0]['isMine']
    assert service.state(1)['presentationQueues'] == []
