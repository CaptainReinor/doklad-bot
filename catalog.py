"""One source of learning data for the bot and the Mini App."""
import copy
import json
from functools import lru_cache

from settings import BASE_DIR

CATALOG_PATH = BASE_DIR / 'webapp' / 'catalog.json'
NOTIFICATION_DEFAULTS = {
    'assignments': True,
    'topics': True,
    'schedule': True,
    'announcements': True,
    # Lesson reminders are opt-in so an update cannot unexpectedly message everyone.
    'lessons': False,
}


@lru_cache(maxsize=1)
def _cached_catalog():
    return json.loads(CATALOG_PATH.read_text(encoding='utf-8'))


def load_catalog():
    # Callers enrich the result, so return an isolated copy of the cached JSON.
    return copy.deepcopy(_cached_catalog())
