"""Local UI fixture with a dummy token. Never runs the actual Telegram bot."""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from waitress import create_server

from database import Database
from server import create_app
from service import Service


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--db', type=Path, required=True)
    parser.add_argument('--port', type=int, default=8765)
    args = parser.parse_args()
    if args.db.exists():
        raise SystemExit('Use a new database path for every UI test run.')
    db = Database(args.db)
    db.init()
    for user_id, name, group in [(101, 'Анна', '01'), (102, 'Борис', '02'),
                                 (103, 'Вера', '01'), (900, 'Администратор', '01')]:
        db.save_user(user_id, name, 'Тестовый', f'МН-4-25-{group}')
    service = Service(db, admin_id=900)
    service.perform(900, {'action': 'create_topic', 'title': 'Общий тестовый доклад',
                          'subject': 'Управление бизнес-процессами', 'isCommon': True,
                          'isMulti': False, 'group': ''})
    service.perform(900, {'action': 'create_topic', 'title': 'Доклад только второй группы',
                          'subject': 'Управление бизнес-процессами', 'isCommon': False,
                          'isMulti': False, 'group': 'МН-4-25-02'})
    app = create_app(token='123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi', service=service)
    server = create_server(app, host='127.0.0.1', port=args.port)
    print(f'READY http://127.0.0.1:{server.effective_port}', flush=True)
    server.run()


if __name__ == '__main__':
    main()
