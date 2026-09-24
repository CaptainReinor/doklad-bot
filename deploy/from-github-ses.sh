#!/bin/sh
set -eu

# One-time console fallback when SSH from the desktop is unavailable.
RELEASE_SHA=92278cbd7adc3f7348b718e5f723725286bb8a91
ROOT=/opt/telegram-bot
NEXT="$ROOT/release-next"

if [ "$(id -u)" -ne 0 ]; then
    echo 'Run this command as root in the VPS console.' >&2
    exit 1
fi
if [ ! -f "$ROOT/docker-data/schedule.db" ] || [ ! -f "$ROOT/telegram-bot-project/config.py" ]; then
    echo 'The current bot data or config is missing. Deployment was not started.' >&2
    exit 1
fi
if [ -L "$NEXT" ]; then
    echo 'Unexpected release-next symlink. Deployment was not started.' >&2
    exit 1
fi

TEMP_DIR=$(mktemp -d)
trap 'rm -rf "$TEMP_DIR"' EXIT
curl -fsSL --connect-timeout 15 --retry 3 \
    "https://api.github.com/repos/CaptainReinor/doklad-bot/tarball/$RELEASE_SHA" \
    -o "$TEMP_DIR/release.tar.gz"

mkdir "$TEMP_DIR/source"
tar -xzf "$TEMP_DIR/release.tar.gz" -C "$TEMP_DIR/source" --strip-components=1
if [ ! -f "$TEMP_DIR/source/Dockerfile" ] || [ ! -f "$TEMP_DIR/source/ses_assignment.py" ]; then
    echo 'The downloaded release is incomplete. Deployment was not started.' >&2
    exit 1
fi

rm -rf "$NEXT"
mkdir -p "$NEXT"
cp -R "$TEMP_DIR/source/." "$NEXT/"
sh "$NEXT/deploy/remote-deploy.sh" update
