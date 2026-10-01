from concurrent.futures import ThreadPoolExecutor

import pytest
from conftest import ADMIN, register

from essay_assignment import DEADLINE, DESCRIPTION, OPTIONS, SUBJECT
from service import ActionError
from ses_assignment import SUBJECT as SES_SUBJECT


def create(service, subject, action):
    assignment = service.db.create_assignment(subject, DESCRIPTION, DEADLINE)
    service.perform(ADMIN, {'action': action, 'assignmentId': assignment['id']})
    return assignment['id']


def test_essay_and_ses_lists_coexist_and_attach_is_idempotent(service):
    ses = create(service, SES_SUBJECT, 'attach_ses_options')
    essay = create(service, SUBJECT, 'attach_essay_options')
    service.perform(ADMIN, {'action': 'attach_essay_options', 'assignmentId': essay})
    options = service.state(1)['assignmentOptions']
    essays = [o for o in options if o['assignmentId'] == essay]
    assert [(o['number'], o['title'], o['details']) for o in essays] == list(OPTIONS)
    assert [o['number'] for o in essays] == list(range(1, 31))
    assert len([o for o in options if o['assignmentId'] == ses]) == 39
    with pytest.raises(ActionError) as error:
        service.perform(1, {'action': 'attach_essay_options', 'assignmentId': essay})
    assert error.value.status == 403
    with pytest.raises(ActionError):
        service.perform(ADMIN, {'action': 'attach_essay_options', 'assignmentId': ses})


def test_essay_choices_are_atomic_shared_and_independent_of_ses(service):
    essay = create(service, SUBJECT, 'attach_essay_options')
    ses = create(service, SES_SUBJECT, 'attach_ses_options')
    register(service, 1, 'МН-4-25-01')
    register(service, 2, 'МН-4-25-02')

    def choose(user):
        try:
            service.perform(user, {'action': 'choose_assignment_option', 'assignmentId': essay, 'number': 1})
            return True
        except ActionError as error:
            assert error.status == 409
            return False

    with ThreadPoolExecutor(max_workers=2) as pool:
        outcomes = list(pool.map(choose, [1, 2]))
    assert sum(outcomes) == 1
    winner = 1 if outcomes[0] else 2
    loser = 3 - winner
    service.perform(winner, {'action': 'choose_assignment_option', 'assignmentId': ses, 'number': 1})
    service.perform(winner, {'action': 'choose_assignment_option', 'assignmentId': essay, 'number': 30})
    choices = service.state(winner)['assignmentOptions']
    assert {(o['assignmentId'], o['number']) for o in choices if o['isMine']} == {(ses, 1), (essay, 30)}
    with pytest.raises(ActionError):
        service.perform(loser, {'action': 'release_assignment_option', 'assignmentId': essay, 'number': 30})
    service.perform(ADMIN, {'action': 'admin_release_assignment_option', 'assignmentId': essay, 'number': 30})
    assert sum(o['isMine'] for o in service.state(winner)['assignmentOptions']) == 1


def test_essay_edit_and_expiration(service):
    essay = create(service, SUBJECT, 'attach_essay_options')
    register(service)
    service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': essay,
                            'subject': SUBJECT, 'description': DESCRIPTION, 'deadline': '01.01.2020'})
    with pytest.raises(ActionError) as error:
        service.perform(1, {'action': 'choose_assignment_option', 'assignmentId': essay, 'number': 1})
    assert error.value.status == 409
    with pytest.raises(ActionError):
        service.perform(ADMIN, {'action': 'update_assignment', 'assignmentId': essay,
                                'subject': SES_SUBJECT, 'description': DESCRIPTION, 'deadline': DEADLINE})
    service.perform(ADMIN, {'action': 'delete_assignment', 'assignmentId': essay})
    assert service.state(1)['assignmentOptions'] == []


def test_upgrade_preserves_existing_ses_choices(service):
    ses = create(service, SES_SUBJECT, 'attach_ses_options')
    register(service)
    service.db.choose_assignment_option(ses, 1, 1)
    with service.db.connection() as conn:
        conn.execute('ALTER TABLE assignment_options DROP COLUMN details')
        conn.execute('PRAGMA user_version=17')
    service.db.init()
    selected = next(o for o in service.state(1)['assignmentOptions'] if o['isMine'])
    assert selected['assignmentId'] == ses
    assert selected['number'] == 1
    assert selected['details'] == ''
