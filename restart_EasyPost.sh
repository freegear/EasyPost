#!/bin/bash

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_IP=$(ip route get 1.1.1.1 | awk '{print $7; exit}')
FLOWISE_URL="http://$SERVER_IP:3991"

echo "Starting EasyPost services..."

echo "[Flowise] Restarting..."
docker compose -f "$SCRIPT_DIR/flowise/docker-compose.yml" down
docker compose -f "$SCRIPT_DIR/flowise/docker-compose.yml" up -d

echo "[Login] Restarting..."
docker compose -f "$SCRIPT_DIR/login/docker-compose.yml" down
FLOWISE_URL="$FLOWISE_URL" docker compose -f "$SCRIPT_DIR/login/docker-compose.yml" up -d --build

echo ""
echo "Done."
echo "  Login   : http://$SERVER_IP:3982"
echo "  Flowise : http://$SERVER_IP:3991"
