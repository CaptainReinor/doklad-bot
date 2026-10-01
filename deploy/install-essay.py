"""One-time, repeat-safe creation of the November essay homework. Run inside the container."""
import sys
from pathlib import Path
from urllib.parse import quote, urlsplit

sys.path.insert(0, '/app')

from database import Database
from essay_assignment import DEADLINE, DESCRIPTION, SUBJECT
from service import Service
from settings import WEB_APP_URL


def main():
    db = Database()
    db.init()
    service = Service(db)
    matches = [a for a in db.get_assignments() if a['subject'] == SUBJECT and a['deadline'] == DEADLINE]
    if len(matches) > 1:
        raise SystemExit('Multiple matching assignments: choose one manually.')
    if matches:
        assignment = matches[0]
    else:
        source = Path('/tmp/essay-topics.pdf')
        if not source.is_file():
            raise SystemExit('The source PDF must be copied to /tmp/essay-topics.pdf first.')
        directory = db.path.parent / 'uploads'
        directory.mkdir(parents=True, exist_ok=True)
        import uuid
        destination = directory / (uuid.uuid4().hex + '.pdf')
        destination.write_bytes(source.read_bytes())
        origin = urlsplit(WEB_APP_URL)
        url = f'{origin.scheme}://{origin.netloc}/files/{destination.name}?name={quote("Темы для эссе.pdf")}'
        admin = min(service.admin_ids)
        service.perform(admin, {'action': 'create_assignment', 'subject': SUBJECT,
                               'description': DESCRIPTION, 'deadline': DEADLINE, 'url': url})
        assignment = next(a for a in db.get_assignments()
                          if a['subject'] == SUBJECT and a['deadline'] == DEADLINE)
    service.perform(min(service.admin_ids), {'action': 'attach_essay_options',
                                           'assignmentId': assignment['id']})
    choices = [o for o in db.get_assignment_options() if o['assignment_id'] == assignment['id']]
    assert len(choices) == 30
    print(f"Essay homework {assignment['id']}: 30 topics, deadline {assignment['deadline']}")


if __name__ == '__main__':
    main()
