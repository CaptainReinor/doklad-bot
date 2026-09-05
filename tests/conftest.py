import hashlib
import hmac
import json
import time
from urllib.parse import urlencode

import pytest

from database import Database
from server import create_app
from service import Service

TEST_TOKEN = '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghi'
ADMIN = 900


def signed_data(user_id=1, *, token=TEST_TOKEN, auth_date=None, **extra):
    fields = {'auth_date': str(int(time.time()) if auth_date is None else auth_date),
              'user': json.dumps({'id': user_id, 'first_name': 'Тест', 'username': f'user{user_id}'}), **extra}
    check = '\n'.join(f'{k}={v}' for k, v in sorted(fields.items()))
    secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
    fields['hash'] = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
    return urlencode(fields)


@pytest.fixture
def db(tmp_path):
    instance = Database(tmp_path / 'schedule.db')
    instance.init()
    return instance


@pytest.fixture
def service(db):
    return Service(db, admin_id=ADMIN)


@pytest.fixture
def client(service):
    app = create_app(token=TEST_TOKEN, service=service)
    app.config['TESTING'] = True
    return app.test_client()


@pytest.fixture
def headers():
    return lambda user_id=1: {'Authorization': 'tma ' + signed_data(user_id)}


def register(service, user_id=1, group='МН-4-25-01', first='Иван', last='Иванов'):
    return service.perform(user_id, {'action': 'register', 'user': {
        'first_name': first, 'last_name': last, 'group_name': group}})
