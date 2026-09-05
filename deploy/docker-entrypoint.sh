#!/bin/sh
set -eu

mkdir -p /data

if [ ! -f /data/schedule.db ]; then
    if [ ! -f /legacy/schedule.db ]; then
        echo "Initial schedule.db is missing; refusing to start with an empty database." >&2
        exit 1
    fi
    cp /legacy/schedule.db /data/schedule.db
    echo "Existing database copied to the persistent Docker data directory."
fi

if [ ! -f /app/config.py ]; then
    echo "The server config.py bind mount is missing." >&2
    exit 1
fi

exec "$@"
