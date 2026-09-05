"""Deployment settings. The existing config.py and its token are unchanged."""
import os
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DATABASE_PATH = Path(os.getenv('DATABASE_PATH', str(BASE_DIR / 'schedule.db')))
if not DATABASE_PATH.is_absolute():
    DATABASE_PATH = BASE_DIR / DATABASE_PATH
_admin_ids = os.getenv('ADMIN_IDS', os.getenv('ADMIN_ID', '930703477,842525310'))
try:
    ADMIN_IDS = frozenset(int(value.strip()) for value in _admin_ids.split(',') if value.strip())
except ValueError as exc:
    raise RuntimeError('ADMIN_IDS must contain comma-separated Telegram user IDs.') from exc
if not ADMIN_IDS:
    raise RuntimeError('ADMIN_IDS must contain at least one Telegram user ID.')
# Kept for compatibility with integrations that still import the original setting.
ADMIN_ID = next(iter(ADMIN_IDS))
WEB_APP_URL = os.getenv('WEB_APP_URL', 'https://litvawasi-ops.github.io/my-app/index.html')
TELEGRAM_API_BASE = os.getenv('TELEGRAM_API_BASE', '').strip().rstrip('/')
ALLOWED_ORIGINS = {s.strip().rstrip('/') for s in os.getenv(
    'ALLOWED_ORIGINS', 'https://litvawasi-ops.github.io'
).split(',') if s.strip()}
APP_TIMEZONE = os.getenv('APP_TIMEZONE', 'Europe/Moscow')
INIT_DATA_MAX_AGE = 24 * 60 * 60
NOTIFICATION_INTERVAL = 60
TOPIC_NOTIFICATION_BATCH_DELAY = 60
