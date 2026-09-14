"""Authenticated API and static Mini App. Importing this module starts nothing."""
import sqlite3
import uuid
from pathlib import Path
from urllib.parse import urlsplit

from flask import Flask, g, jsonify, request, send_from_directory
from werkzeug.exceptions import HTTPException

from auth import validate_init_data
from database import Database
from service import ActionError, Service
from settings import ALLOWED_ORIGINS, BASE_DIR, DATABASE_PATH

ALLOWED_UPLOAD_SUFFIXES = {
    '.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx',
    '.odt', '.ods', '.txt', '.png', '.jpg', '.jpeg', '.zip'
}
MAX_UPLOAD_BYTES = 10 * 1024 * 1024


def create_app(*, token=None, db_path=DATABASE_PATH, service=None, upload_dir=None):
    if token is None:
        from config import BOT_TOKEN
        token = BOT_TOKEN
    if service is None:
        db = Database(db_path)
        db.init()
        service = Service(db)
    upload_dir = Path(upload_dir or (Path(service.db.path).parent / 'uploads')).resolve()
    app = Flask(__name__, static_folder=None)
    app.config['MAX_CONTENT_LENGTH'] = 12 * 1024 * 1024
    app.json.ensure_ascii = False
    app.extensions['service'] = service

    @app.before_request
    def authenticate():
        if not request.path.startswith('/api/'):
            return None
        origin = request.headers.get('Origin')
        # HTTPS may terminate at a reverse proxy; it must preserve the Host header.
        same_host = origin and urlsplit(origin).scheme in ('http', 'https') and urlsplit(origin).netloc == request.host
        if origin and origin not in ALLOWED_ORIGINS and not same_host:
            return jsonify(error='Источник запроса не разрешён.'), 403
        if request.method == 'OPTIONS':
            return '', 204
        header = request.headers.get('Authorization', '')
        if request.path == '/api/catalog' and not header:
            return None
        raw = header[4:] if header.startswith('tma ') else ''
        try:
            g.telegram_user = validate_init_data(raw, token)
        except ValueError as exc:
            return jsonify(error=str(exc)), 401
        return None

    @app.after_request
    def headers(response):
        origin = request.headers.get('Origin')
        if origin in ALLOWED_ORIGINS:
            response.headers['Access-Control-Allow-Origin'] = origin
            response.headers['Vary'] = 'Origin'
            response.headers['Access-Control-Allow-Headers'] = 'Authorization, Content-Type'
            response.headers['Access-Control-Allow-Methods'] = 'GET, POST, OPTIONS'
        response.headers['X-Content-Type-Options'] = 'nosniff'
        response.headers['Referrer-Policy'] = 'no-referrer'
        response.headers['Cache-Control'] = 'no-store' if request.path.startswith('/api/') else 'no-cache'
        return response

    @app.errorhandler(ActionError)
    def action_error(exc):
        return jsonify(error=str(exc)), exc.status

    @app.errorhandler(sqlite3.Error)
    def database_error(exc):
        app.logger.error('Database request failed: %s', type(exc).__name__)
        return jsonify(error='База данных временно недоступна. Повторите действие.'), 503

    @app.errorhandler(HTTPException)
    def http_error(exc):
        return jsonify(error='Некорректный запрос.' if exc.code != 404 else 'Адрес не найден.'), exc.code

    @app.get('/health')
    def health():
        with service.db.connection() as conn:
            conn.execute('SELECT 1')
        return jsonify(status='ok')

    @app.get('/api/catalog')
    def catalog():
        user = getattr(g, 'telegram_user', None)
        return jsonify(service.catalog(user['id'] if user else None, public=True))

    @app.get('/api/state')
    def state():
        return jsonify(service.state(g.telegram_user['id']))

    @app.post('/api/visit')
    def visit():
        service.record_visit(g.telegram_user['id'])
        return jsonify(status='ok')

    @app.post('/api/action')
    def action():
        data = request.get_json(silent=True)
        user_id = g.telegram_user['id']
        service.record_visit(user_id)
        message = service.perform(user_id, data, g.telegram_user)
        return jsonify(message=message, state=service.state(user_id),
                       catalog=service.catalog(user_id, public=True))

    @app.post('/api/upload')
    def upload():
        if not service.is_admin(g.telegram_user['id']):
            raise ActionError('Загружать материалы может только администратор.', 403)
        uploaded = request.files.get('file')
        original_name = Path((uploaded.filename or '').replace('\\', '/')).name.strip() if uploaded else ''
        suffix = Path(original_name).suffix.lower()
        if (not uploaded or not original_name or len(original_name) > 200 or
                any(ord(char) < 32 for char in original_name) or suffix not in ALLOWED_UPLOAD_SUFFIXES):
            raise ActionError('Выберите PDF, документ, таблицу, презентацию, изображение, TXT или ZIP.')
        upload_dir.mkdir(parents=True, exist_ok=True)
        stored_name = f'{uuid.uuid4().hex}{suffix}'
        destination = upload_dir / stored_name
        uploaded.save(destination)
        size = destination.stat().st_size
        if not 0 < size <= MAX_UPLOAD_BYTES:
            destination.unlink(missing_ok=True)
            raise ActionError('Файл должен быть непустым и не больше 10 МБ.')
        return jsonify(path=f'/files/{stored_name}', name=original_name, size=size)

    @app.get('/files/<path:filename>')
    def uploaded_file(filename):
        return send_from_directory(upload_dir, filename, as_attachment=True)

    @app.get('/')
    @app.get('/<path:filename>')
    def static_file(filename='index.html'):
        # Never serve config.py, the database or anything above webapp/.
        return send_from_directory(BASE_DIR / 'webapp', filename)

    return app


if __name__ == '__main__':
    import os

    from waitress import serve
    serve(create_app(), host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', '8080')))
