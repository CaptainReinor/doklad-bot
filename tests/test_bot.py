from unittest.mock import Mock

import pytest
from conftest import ADMIN, TEST_TOKEN, register
from telebot import types

from bot import configure_telegram_api, create_bot, split_message


def message(text=None, user_id=1, *, group=False, payload=None):
    data = {'message_id': 1, 'date': 1700000000,
            'chat': {'id': -1000 if group else user_id, 'type': 'group' if group else 'private'},
            'from': {'id': user_id, 'is_bot': False, 'first_name': 'Тест'}}
    if text is not None:
        data['text'] = text
    if payload is not None:
        data['web_app_data'] = {'data': payload, 'button_text': 'App'}
    return types.Message.de_json(data)


@pytest.fixture
def bot(service, monkeypatch):
    client = create_bot(service, TEST_TOKEN, threaded=False)
    client.send_message = Mock()
    client.set_chat_menu_button = Mock()
    import telebot.apihelper
    monkeypatch.setattr(telebot.apihelper, '_make_request', Mock(side_effect=AssertionError('No live Telegram in tests')))
    return client


def dispatch(bot, text=None, **kwargs):
    bot.process_new_messages([message(text, **kwargs)])
    return '\n'.join(call.args[1] for call in bot.send_message.call_args_list)


def test_admin_commands_reachable_and_not_registration_input(bot, service):
    assert 'Кабинет' in dispatch(bot, '/start', user_id=ADMIN)
    bot.send_message.reset_mock()
    text = dispatch(bot, '/users', user_id=ADMIN)
    assert 'Зарегистрированные студенты' in text
    bot.send_message.reset_mock()
    dispatch(bot, '/register', user_id=ADMIN)
    dispatch(bot, 'Иван', user_id=ADMIN)
    dispatch(bot, 'Иванов', user_id=ADMIN)
    dispatch(bot, 'МН-4-25-01', user_id=ADMIN)
    assert service.db.get_user(ADMIN)['first_name'] == 'Иван'
    assert 'Регистрация завершена' in '\n'.join(c.args[1] for c in bot.send_message.call_args_list)


def test_users_stats_and_removed_deadline_command(bot, service):
    register(service)
    assert 'нет прав' in dispatch(bot, '/users')
    bot.send_message.reset_mock()
    assert 'Студентов: 1' in dispatch(bot, '/stats', user_id=ADMIN)
    bot.send_message.reset_mock()
    assert 'Неизвестная команда' in dispatch(bot, '/deadline topic 1 30.09.2026', user_id=ADMIN)


def test_group_chat_cannot_register_or_read_students(bot, service):
    text = dispatch(bot, '/start', group=True)
    assert 'личный чат' in text
    dispatch(bot, '/users', user_id=ADMIN, group=True)
    assert not service.db.get_all_users()
    assert not any('Зарегистрированные студенты' in c.args[1] for c in bot.send_message.call_args_list)


def test_cancel_and_restart_registration(bot, service):
    dispatch(bot, '/register')
    dispatch(bot, 'Иван')
    dispatch(bot, '/cancel')
    dispatch(bot, 'Иванов')
    assert service.db.get_user(1) is None
    dispatch(bot, '/register')
    assert 'только буквы' in dispatch(bot, 'Пётр_[*')
    dispatch(bot, 'Пётр')
    dispatch(bot, 'Петров')
    dispatch(bot, 'МН-4-25-01')
    assert service.db.get_user(1)['first_name'] == 'Пётр'
    assert all(not c.kwargs.get('parse_mode') for c in bot.send_message.call_args_list)


def test_start_uses_inline_app_without_personal_url_parameters(bot, service):
    register(service)
    dispatch(bot, '/start')
    markup = bot.send_message.call_args.kwargs['reply_markup'].to_dict()
    url = markup['inline_keyboard'][0][0]['web_app']['url']
    assert url.startswith('https://') and '?' not in url
    assert bot.set_chat_menu_button.call_args.kwargs['menu_button'].web_app.url == url


def test_old_web_app_payload_and_unknown_commands(bot, service):
    register(service)
    dispatch(bot, payload='{"action":"book_topic","topic":{"id":1}}')
    assert len(service.db.get_all_bookings()) == 1
    dispatch(bot, payload='[]')
    assert 'Неизвестная команда' in dispatch(bot, '/unknown')


def test_telegram_message_splitting_with_unicode():
    source = 'Студент 👤 ' * 1000
    pieces = list(split_message(source))
    assert ''.join(pieces) == source
    assert all(len(p.encode('utf-16-le')) // 2 <= 3500 for p in pieces)


def test_optional_telegram_api_proxy(monkeypatch):
    import telebot.apihelper
    monkeypatch.setattr(telebot.apihelper, 'API_URL', None)
    monkeypatch.setattr(telebot.apihelper, 'FILE_URL', None)
    configure_telegram_api('https://proxy.example/key/')
    assert telebot.apihelper.API_URL == 'https://proxy.example/key/bot{0}/{1}'
    assert telebot.apihelper.FILE_URL == 'https://proxy.example/key/file/bot{0}/{1}'
    configure_telegram_api('')
    assert telebot.apihelper.API_URL is None and telebot.apihelper.FILE_URL is None
    with pytest.raises(RuntimeError, match='HTTPS'):
        configure_telegram_api('http://proxy.example')
