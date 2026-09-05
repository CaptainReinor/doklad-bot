#!/bin/sh
set -eu

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y docker.io ca-certificates unzip
systemctl enable --now docker

install -d -m 0755 /opt/telegram-bot/docker-data
if [ ! -f /opt/telegram-bot/docker-data/schedule.db ]; then
    cp /opt/telegram-bot/telegram-bot-project/schedule.db \
       /opt/telegram-bot/docker-data/schedule.db
fi
cp /opt/telegram-bot/docker-data/schedule.db \
   "/root/schedule.db-before-docker-$(date +%Y%m%d-%H%M%S).bak"

echo "Server is ready for the Docker image build. The current bot is still running."
