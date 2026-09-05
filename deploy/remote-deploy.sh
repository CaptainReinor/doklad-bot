#!/bin/sh
set -eu

MODE="${1:-update}"
ROOT=/opt/telegram-bot
NEXT="$ROOT/release-next"
CURRENT="$ROOT/release"
PREVIOUS="$ROOT/release-previous"
DATA="$ROOT/docker-data"
LEGACY="$ROOT/telegram-bot-project"
CONTAINER=telegram-bot
LATEST=telegram-bot-local:latest
CANDIDATE=telegram-bot-local:candidate
ROLLBACK=telegram-bot-local:rollback

run_container() {
    image="$1"
    docker run -d \
        --name "$CONTAINER" \
        --restart unless-stopped \
        --env-file "$NEXT/deploy/docker.env" \
        -p 127.0.0.1:8080:8080 \
        -v "$DATA:/data" \
        -v "$LEGACY/schedule.db:/legacy/schedule.db:ro" \
        -v "$LEGACY/config.py:/app/config.py:ro" \
        --log-driver json-file \
        --log-opt max-size=10m \
        --log-opt max-file=3 \
        "$image"
}

restore_previous() {
    docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
    if docker image inspect "$ROLLBACK" >/dev/null 2>&1; then
        echo "Restoring the previous Docker image..."
        run_container "$ROLLBACK"
        docker image tag "$ROLLBACK" "$LATEST"
    elif systemctl list-unit-files telegram-bot.service >/dev/null 2>&1; then
        echo "Restoring the previous systemd service..."
        systemctl enable --now telegram-bot.service
    fi
}

[ -f "$NEXT/Dockerfile" ] || { echo "Uploaded release is incomplete." >&2; exit 1; }
[ "$MODE" = first ] || [ "$MODE" = update ] || { echo "Unknown deployment mode: $MODE" >&2; exit 1; }
[ -f "$LEGACY/config.py" ] || { echo "Server config.py is missing." >&2; exit 1; }
[ -f "$DATA/schedule.db" ] || { echo "Persistent schedule.db is missing." >&2; exit 1; }

cp "$DATA/schedule.db" "/root/schedule.db-before-deploy-$(date +%Y%m%d-%H%M%S).bak"

if docker image inspect "$LATEST" >/dev/null 2>&1; then
    docker image tag "$LATEST" "$ROLLBACK"
fi

echo "Building the candidate image while the current bot stays online..."
docker build -t "$CANDIDATE" "$NEXT"

if [ "$MODE" = "first" ]; then
    systemctl disable --now telegram-bot.service
fi
docker rm -f "$CONTAINER" >/dev/null 2>&1 || true

if ! run_container "$CANDIDATE"; then
    restore_previous
    exit 1
fi

status=starting
attempt=0
while [ "$attempt" -lt 40 ]; do
    status=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$CONTAINER" 2>/dev/null || true)
    [ "$status" = healthy ] && break
    [ "$status" = unhealthy ] && break
    attempt=$((attempt + 1))
    sleep 2
done

if [ "$status" != healthy ]; then
    echo "The candidate container is not healthy. Recent logs:"
    docker logs --tail 100 "$CONTAINER" || true
    restore_previous
    exit 1
fi

docker image tag "$CANDIDATE" "$LATEST"
rm -rf "$PREVIOUS"
if [ -d "$CURRENT" ]; then
    mv "$CURRENT" "$PREVIOUS"
fi
mv "$NEXT" "$CURRENT"

echo "Container is healthy:"
docker ps --filter "name=^/${CONTAINER}$"
