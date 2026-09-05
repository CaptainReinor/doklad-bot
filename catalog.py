"""One source of learning data for the bot and the Mini App."""
import json

from settings import BASE_DIR

CATALOG_PATH = BASE_DIR / 'webapp' / 'catalog.json'
NOTIFICATION_DEFAULTS = {'assignments': True, 'topics': True, 'schedule': True}


def load_catalog():
    return json.loads(CATALOG_PATH.read_text(encoding='utf-8'))


def find_topic(value):
    # Compatibility with payloads sent by the old Mini App.
    if isinstance(value, dict):
        value = value.get('id')
    for topic in load_catalog()['topics']:
        if (type(value) is int and topic['id'] == value) or value == topic['title']:
            return topic
    return None
