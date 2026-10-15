"""Verified, group-specific SDO attendance calendar; independent of the shared timetable."""
import re
from datetime import datetime
from urllib.parse import urlsplit

GROUP = 'МН-4-25-02'
SUBJECT = 'Развитие компетенций руководителя проекта и проектных команд'
TEACHER = 'Кучина О.В.'
SETTINGS_KEY = 'attendance_reminder_settings'
# Verified against the course screenshots supplied on 15 October 2026.
# The website's 24.11 row is a typo: the course shows Saturday, 24 October.
# The shared lecture on 1 October is deliberately excluded.
DATES = ('17.10.2026', '24.10.2026', '31.10.2026',
         '03.11.2026', '17.11.2026', '26.11.2026')


def default_settings():
    return {'enabled': True, 'time': '19:00', 'dates': list(DATES), 'url': ''}


def validate_settings(data):
    if not isinstance(data, dict) or type(data.get('enabled')) is not bool:
        raise ValueError('Укажите, включены ли напоминания об отметках.')
    time = data.get('time')
    if not isinstance(time, str) or not re.fullmatch(r'(?:[01]\d|2[0-3]):[0-5]\d', time):
        raise ValueError('Укажите время напоминания в формате ЧЧ:ММ.')
    dates = data.get('dates')
    if (not isinstance(dates, list) or len(dates) > len(DATES) or
            any(not isinstance(day, str) or day not in DATES for day in dates) or
            len(set(dates)) != len(dates)):
        raise ValueError('Выберите отдельные дни второй группы из списка.')
    url = data.get('url', '')
    if not isinstance(url, str) or len(url) > 1000 or any(char.isspace() for char in url):
        raise ValueError('Укажите корректную ссылку на СДО.')
    try:
        parsed = urlsplit(url)
        if url and (parsed.scheme != 'https' or not parsed.hostname or parsed.username or parsed.password):
            raise ValueError()
    except ValueError as exc:
        raise ValueError('Ссылка на СДО должна начинаться с https://.') from exc
    return {'enabled': data['enabled'], 'time': time,
            'dates': sorted(dates, key=lambda value: datetime.strptime(value, '%d.%m.%Y')),
            'url': url}


def message(settings):
    link = f"\nСДО: {settings['url']}" if settings.get('url') else ''
    return (f'Отметьтесь в СДО\n{SUBJECT}\n{TEACHER}\n'
            f'Сегодня занятие вашей группы. Не забудьте отметить посещаемость.{link}')
