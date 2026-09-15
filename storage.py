"""Lifecycle management for materials uploaded to the local server."""
import re
import threading
import time
from pathlib import Path
from urllib.parse import unquote, urlsplit

UPLOAD_NAME = re.compile(r'^[a-f0-9]{32}\.[a-z0-9]+$')
CLEANUP_INTERVAL_SECONDS = 60 * 60
ORPHAN_GRACE_SECONDS = 60 * 60
_cleanup_lock = threading.Lock()
_last_cleanup = {}


def uploaded_filename(url):
    if not isinstance(url, str) or not url:
        return None
    try:
        path = unquote(urlsplit(url).path)
    except ValueError:
        return None
    if not path.startswith('/files/'):
        return None
    name = Path(path).name
    return name if UPLOAD_NAME.fullmatch(name) else None


def cleanup_uploads(service, upload_dir=None, *, force=False, now=None,
                    orphan_grace=ORPHAN_GRACE_SECONDS, removed_urls=()):
    """Remove archived attachments and stale unreferenced uploads."""
    directory = Path(upload_dir or (service.db.path.parent / 'uploads')).resolve()
    current_time = time.time() if now is None else float(now)
    key = str(service.db.path)
    with _cleanup_lock:
        if not force and current_time - _last_cleanup.get(key, 0) < CLEANUP_INTERVAL_SECONDS:
            return {'detached': 0, 'deleted': 0, 'skipped': True}
        _last_cleanup[key] = current_time
    try:
        expired = []
        for item in service.assignments():
            if item['archived'] and uploaded_filename(item.get('url')):
                expired.append(('assignments', item['id'], item['url']))
        for item in service.topics(include_inactive=True):
            if item['archived'] and uploaded_filename(item.get('url')):
                expired.append(('topics', item['id'], item['url']))
        detached = service.db.clear_material_urls(expired) if expired else 0
        keep = {name for url in service.db.material_urls()
                if (name := uploaded_filename(url))}
        expired_names = {uploaded_filename(url) for _, _, url in expired}
        expired_names.update(name for url in removed_urls
                             if (name := uploaded_filename(url)))
        deleted = 0
        if directory.is_dir():
            for path in directory.iterdir():
                if not path.is_file() or not UPLOAD_NAME.fullmatch(path.name) or path.name in keep:
                    continue
                if path.name in expired_names or current_time - path.stat().st_mtime >= orphan_grace:
                    path.unlink(missing_ok=True)
                    deleted += 1
        return {'detached': detached, 'deleted': deleted, 'skipped': False}
    except Exception:
        with _cleanup_lock:
            _last_cleanup.pop(key, None)
        raise
