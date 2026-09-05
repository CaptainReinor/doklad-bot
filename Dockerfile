FROM python:3.12-slim

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

WORKDIR /app

COPY requirements.txt ./
RUN pip install --no-cache-dir --requirement requirements.txt

COPY auth.py bot.py catalog.py database.py notifications.py run.py server.py service.py settings.py ./
COPY webapp ./webapp
COPY deploy/docker-entrypoint.sh /usr/local/bin/telegram-bot-entrypoint
RUN chmod 0755 /usr/local/bin/telegram-bot-entrypoint

EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=4s --start-period=20s --retries=6 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:8080/health', timeout=3).read()"

ENTRYPOINT ["telegram-bot-entrypoint"]
CMD ["python", "run.py"]
