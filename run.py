"""Start the HTTP server and bot together: python run.py."""
import logging
import os
import threading
import time

from waitress import create_server

from bot import run_bot
from database import Database
from server import create_app
from service import Service


def main():
    logging.basicConfig(level=logging.INFO)
    db = Database()
    db.init()
    service = Service(db)
    server = create_server(create_app(service=service),
                           host=os.getenv('HOST', '127.0.0.1'), port=int(os.getenv('PORT', '8080')))
    thread = threading.Thread(target=server.run, name='http', daemon=True)
    thread.start()
    try:
        # Keep the Mini App available even if Telegram is temporarily
        # unreachable. The bot reconnects in the background retry loop.
        while True:
            try:
                run_bot(service)
            except KeyboardInterrupt:
                break
            except Exception:
                logging.exception('Telegram connection failed; retrying in 5 seconds.')
                time.sleep(5)
    finally:
        server.close()
        thread.join(timeout=5)


if __name__ == '__main__':
    main()
