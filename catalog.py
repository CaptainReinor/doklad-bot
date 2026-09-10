"""One source of learning data for the bot and the Mini App."""
import json

from settings import BASE_DIR

CATALOG_PATH = BASE_DIR / 'webapp' / 'catalog.json'
NOTIFICATION_DEFAULTS = {
    'assignments': True,
    'topics': True,
    'schedule': True,
    # Lesson reminders are opt-in so an update cannot unexpectedly message everyone.
    'lessons': False,
}


def load_catalog():
    return json.loads(CATALOG_PATH.read_text(encoding='utf-8'))
