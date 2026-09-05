"""Telegram chat interface. Nothing is sent or started on import."""
import json
import logging
import socket
import threading
from urllib.parse import urlparse

import telebot
import urllib3.util.connection
from telebot import apihelper

from database import Database
from service import ActionError, Service, clean_group, clean_name
from settings import TELEGRAM_API_BASE, WEB_APP_URL

logger = logging.getLogger(__name__)


def configure_telegram_api(base_url=TELEGRAM_API_BASE):
    """Route Bot API calls through an optional trusted HTTPS reverse proxy."""
    if base_url and not base_url.startswith('https://'):
        raise RuntimeError('TELEGRAM_API_BASE must be an HTTPS URL.')
    base_url = base_url.rstrip('/') if base_url else ''
    apihelper.API_URL = f'{base_url}/bot{{0}}/{{1}}' if base_url else None
    apihelper.FILE_URL = f'{base_url}/file/bot{{0}}/{{1}}' if base_url else None


def split_message(text, limit=3500):
    # Stay below Telegram's UTF-16 length limit even for names containing emoji.
    part, size = [], 0
    for char in text:
        char_size = len(char.encode('utf-16-le')) // 2
        if size + char_size > limit:
            yield ''.join(part)
            part, size = [], 0
        part.append(char)
        size += char_size
    if part:
        yield ''.join(part)


def create_bot(service, token, *, threaded=True, web_app_url=WEB_APP_URL):
    client = telebot.TeleBot(token, threaded=threaded)
    registration = {}
    registration_lock = threading.RLock()

    def send(chat_id, text, **kwargs):
        for part in split_message(text):
            client.send_message(chat_id, part, **kwargs)

    def private(message):
        if message.chat.type != 'private' or not message.from_user:
            send(message.chat.id, 'Откройте личный чат с ботом и отправьте /start.')
            return False
        return True

    def admin(message):
        if not private(message):
            return False
        if not service.is_admin(message.from_user.id):
            send(message.chat.id, '⛔ У вас нет прав.')
            return False
        return True

    def open_app(chat_id, prompt='📱 Откройте приложение:'):
        parsed = urlparse(web_app_url)
        if parsed.scheme != 'https' or not parsed.netloc:
            send(chat_id, 'Администратору нужно указать HTTPS-адрес приложения в WEB_APP_URL.')
            return
        try:
            client.set_chat_menu_button(
                chat_id=chat_id,
                menu_button=telebot.types.MenuButtonWebApp(
                    type='web_app', text='Открыть приложение',
                    web_app=telebot.types.WebAppInfo(url=web_app_url)))
        except Exception as exc:
            logger.warning('Could not update the chat menu button: %s', type(exc).__name__)
        markup = telebot.types.InlineKeyboardMarkup()
        markup.add(telebot.types.InlineKeyboardButton(
            '🚀 Открыть приложение', web_app=telebot.types.WebAppInfo(url=web_app_url)))
        send(chat_id, prompt, reply_markup=markup)

    @client.message_handler(commands=['start', 'app'])
    def welcome(message):
        if not private(message):
            return
        user_id = message.from_user.id
        with registration_lock:
            registration.pop(user_id, None)
            if service.db.get_user(user_id):
                open_app(message.chat.id)
                return
        open_app(message.chat.id, '👋 Добро пожаловать! Откройте приложение и зарегистрируйтесь во вкладке «Кабинет».')

    @client.message_handler(commands=['register'])
    def begin_registration(message):
        if not private(message):
            return
        user_id = message.from_user.id
        if service.db.get_user(user_id):
            open_app(message.chat.id, 'Вы уже зарегистрированы. Откройте приложение:')
            return
        with registration_lock:
            registration[user_id] = {'step': 'first_name'}
        send(message.chat.id, '👋 Добро пожаловать!\nДля регистрации введите ваше имя.\nОтмена: /cancel')

    @client.message_handler(commands=['cancel'])
    def cancel_registration(message):
        if not private(message):
            return
        with registration_lock:
            registration.pop(message.from_user.id, None)
        send(message.chat.id, 'Регистрация отменена. Начать заново: /register или через «Кабинет» в приложении.')

    @client.message_handler(commands=['help'])
    def help_command(message):
        if not private(message):
            return
        text = ('/start — открыть приложение\n/app — открыть приложение\n'
                '/register — запасная регистрация сообщениями\n/cancel — отменить регистрацию')
        if service.is_admin(message.from_user.id):
            text += '\n/users — студенты\n/stats — статистика'
        send(message.chat.id, text)

    @client.message_handler(commands=['users'])
    def list_users(message):
        if not admin(message):
            return
        rows = service.db.get_all_users()
        text = '📋 Зарегистрированные студенты:\n\n' + '\n'.join(
            f"{i}. {u['first_name']} {u['last_name']} ({u['group_name']}) — ID: {u['user_id']}"
            for i, u in enumerate(rows, 1))
        send(message.chat.id, text + f'\n\nВсего: {len(rows)}')

    @client.message_handler(commands=['stats'])
    def stats(message):
        if not admin(message):
            return
        users, bookings = service.db.get_all_users(), service.db.get_all_bookings()
        groups = sorted({u['group_name'] for u in users})
        booked_topics = {row['topic'] for row in bookings}
        text = (f'📊 Студентов: {len(users)}\nТем: {len(service.catalog()["topics"])}\n'
                f'Занятых тем: {len(booked_topics)}\nВыступающих: {len(bookings)}\n')
        for group in groups:
            group_bookings = [row for row in bookings if row['group_name'] == group]
            text += (f'\n{group}: студентов {sum(u["group_name"] == group for u in users)}, '
                     f'занятых тем {len({row["topic"] for row in group_bookings})}, '
                     f'выступающих {len(group_bookings)}')
        send(message.chat.id, text)

    @client.message_handler(content_types=['web_app_data'])
    def web_app_data(message):
        if not private(message):
            return
        try:
            data = json.loads(message.web_app_data.data)
            result = service.perform(message.from_user.id, data, message.from_user.to_dict())
            send(message.chat.id, result)
        except (ValueError, TypeError) as exc:
            send(message.chat.id, str(exc) if isinstance(exc, ActionError) else 'Некорректные данные приложения.')
        except Exception as exc:
            logger.error('Web App action failed: %s', type(exc).__name__)
            send(message.chat.id, 'Не удалось выполнить действие. Повторите позже.')

    # Specific commands must be registered before the text fallback.
    @client.message_handler(content_types=['text'], func=lambda m: bool(m.text) and not m.text.startswith('/'))
    def register(message):
        if not private(message):
            return
        user_id = message.from_user.id
        with registration_lock:
            data = registration.get(user_id)
            if not data:
                send(message.chat.id, 'Открыть приложение или зарегистрироваться: /start')
                return
            step = data['step']
            try:
                if step == 'first_name':
                    data['first_name'] = clean_name(message.text, 'имя')
                    data['step'] = 'last_name'
                    send(message.chat.id, 'Теперь введите фамилию:')
                elif step == 'last_name':
                    data['last_name'] = clean_name(message.text, 'фамилию')
                    data['step'] = 'group_name'
                    markup = telebot.types.ReplyKeyboardMarkup(resize_keyboard=True, one_time_keyboard=True)
                    markup.row(telebot.types.KeyboardButton('МН-4-25-01'),
                               telebot.types.KeyboardButton('МН-4-25-02'))
                    send(message.chat.id, 'Выберите учебную группу:', reply_markup=markup)
                else:
                    data['group_name'] = clean_group(message.text)
                    service.perform(user_id, {'action': 'register', 'user': data}, message.from_user.to_dict())
                    del registration[user_id]
                    send(message.chat.id,
                         f"✅ Регистрация завершена.\n{data['first_name']} {data['last_name']}\nГруппа: {data['group_name']}",
                         reply_markup=telebot.types.ReplyKeyboardRemove())
                    open_app(message.chat.id)
            except ActionError as exc:
                send(message.chat.id, str(exc))
            except Exception as exc:
                logger.error('Registration failed: %s', type(exc).__name__)
                send(message.chat.id, 'Не удалось завершить регистрацию. Повторите действие или отправьте /start.')

    @client.message_handler(content_types=['text'], func=lambda m: bool(m.text) and m.text.startswith('/'))
    def unknown_command(message):
        send(message.chat.id, 'Неизвестная команда. Список команд: /help')

    return client


def run_bot(service=None):
    # Some VPS networks publish an IPv6 route but cannot actually reach it.
    # Telegram also has IPv4 addresses, so make requests/urllib3 use that
    # working route instead of repeatedly crashing on ENETUNREACH.
    urllib3.util.connection.allowed_gai_family = lambda: socket.AF_INET
    from config import BOT_TOKEN
    from notifications import start_notification_thread
    configure_telegram_api()
    if service is None:
        db = Database()
        db.init()
        service = Service(db)
    client = create_bot(service, BOT_TOKEN)
    # Detect a competing webhook before starting notification delivery.
    if client.get_webhook_info().url:
        raise RuntimeError('У бота установлен webhook. Отключите его перед запуском polling.')
    stop, thread = start_notification_thread(service, client.send_message)
    try:
        logger.info('Бот запущен.')
        client.infinity_polling(allowed_updates=['message'])
    finally:
        stop.set()
        client.stop_polling()
        thread.join(timeout=5)


if __name__ == '__main__':
    logging.basicConfig(level=logging.INFO)
    run_bot()
