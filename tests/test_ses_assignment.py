from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import ADMIN, register

from service import ActionError
from ses_assignment import OPTIONS, SUBJECT


def add_assignment(service):
    service.perform(ADMIN, {'action': 'create_assignment', 'subject': SUBJECT,
                            'description': 'Практическое задание № 3',
                            'deadline': '08.10.2026'})
    return service.db.get_assignments()[-1]['id']


def test_ses_options_attach_to_existing_homework_once_and_preserve_numbers(service):
    assignment_id = add_assignment(service)
    assert service.state(1)['assignmentOptions'] == []
    with pytest.raises(ActionError) as error:
        service.perform(1, {'action': 'attach_ses_options', 'assignmentId': assignment_id})
    assert error.value.status == 403

    service.perform(ADMIN, {'action': 'attach_ses_options', 'assignmentId': assignment_id})
    service.perform(ADMIN, {'action': 'attach_ses_options', 'assignmentId': assignment_id})
    options = service.state(1)['assignmentOptions']
    assert [(item['number'], item['title']) for item in options] == list(OPTIONS)
    assert len(options) == 39
    assert 33 not in {item['number'] for item in options}
    assert {item['assignmentId'] for item in options} == {assignment_id}
    assert len(service.db.get_assignments()) == 1


def test_ses_choice_is_shared_between_groups_and_each_student_has_one(service):
    assignment_id = add_assignment(service)
    service.perform(ADMIN, {'action': 'attach_ses_options', 'assignmentId': assignment_id})
    register(service, 1, 'МН-4-25-01')
    register(service, 2, 'МН-4-25-02')

    def choose(user_id):
        try:
            service.perform(user_id, {'action': 'choose_assignment_option',
                                      'assignmentId': assignment_id, 'number': 1})
            return True
        except ActionError as error:
            assert error.status == 409
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(choose, [1, 2]))
    assert outcomes.count(True) == 1
    winner = 1 if outcomes[0] else 2
    loser = 2 if winner == 1 else 1
    service.perform(winner, {'action': 'choose_assignment_option',
                             'assignmentId': assignment_id, 'number': 2})
    choices = service.state(loser)['assignmentOptions']
    assert next(item for item in choices if item['number'] == 1)['student'] == ''
    assert next(item for item in choices if item['number'] == 2)['student']
    assert sum(bool(item['student']) for item in choices) == 1
    service.perform(loser, {'action': 'choose_assignment_option',
                            'assignmentId': assignment_id, 'number': 1})
    with pytest.raises(ActionError) as error:
        service.perform(loser, {'action': 'release_assignment_option',
                                'assignmentId': assignment_id, 'number': 2})
    assert error.value.status == 409
    service.perform(ADMIN, {'action': 'admin_release_assignment_option',
                            'assignmentId': assignment_id, 'number': 2})
    assert sum(bool(item['student']) for item in service.state(1)['assignmentOptions']) == 1


def test_ses_options_follow_homework_lifecycle(service):
    assignment_id = add_assignment(service)
    service.perform(ADMIN, {'action': 'attach_ses_options', 'assignmentId': assignment_id})
    service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': assignment_id,
                            'subject': SUBJECT, 'description': 'Обновлено',
                            'deadline': '09.10.2026', 'url': ''})
    assert service.db.get_assignment(assignment_id)['deadline'] == '09.10.2026'
    service.perform(ADMIN, {'action': 'delete_assignment', 'assignmentId': assignment_id})
    assert service.state(1)['assignmentOptions'] == []
