"""Validate Telegram Mini App initData on the server only."""
import hashlib
import hmac
import json
import time
from urllib.parse import parse_qsl

from settings import INIT_DATA_MAX_AGE


def validate_init_data(raw, token, *, now=None, max_age=INIT_DATA_MAX_AGE):
    if not isinstance(raw, str) or not raw or len(raw) > 16384:
        raise ValueError('Откройте приложение через кнопку бота в Telegram.')
    try:
        pairs = parse_qsl(raw, keep_blank_values=True, strict_parsing=True, max_num_fields=30)
        fields = dict(pairs)
        if len(fields) != len(pairs):
            raise ValueError('Duplicate fields')
        supplied_hash = fields.pop('hash')
        check = '\n'.join(f'{key}={value}' for key, value in sorted(fields.items()))
        secret = hmac.new(b'WebAppData', token.encode(), hashlib.sha256).digest()
        expected = hmac.new(secret, check.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected, supplied_hash):
            raise ValueError('Invalid signature')
        age = (time.time() if now is None else now) - int(fields['auth_date'])
        if age < -30 or age > max_age:
            raise ValueError('Expired session')
        user = json.loads(fields['user'])
        if not isinstance(user, dict) or type(user.get('id')) is not int or user['id'] <= 0:
            raise ValueError('Invalid user')
        return user
    except (KeyError, TypeError, ValueError) as exc:
        raise ValueError('Сессия недействительна. Закройте приложение и откройте его через бота.') from exc
