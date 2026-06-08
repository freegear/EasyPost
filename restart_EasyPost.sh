#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SERVER_IP="${SERVER_IP:-}"

log() {
  printf '[EasyPost] %s\n' "$*"
}

die() {
  printf '[EasyPost] ERROR: %s\n' "$*" >&2
  exit 1
}

require_docker() {
  command -v docker >/dev/null 2>&1 || die "docker 명령을 찾을 수 없습니다."
  docker info >/dev/null 2>&1 || die "Docker daemon에 연결할 수 없습니다."
  docker compose version >/dev/null 2>&1 || die "Docker Compose 플러그인이 필요합니다."
}

detect_server_ip() {
  if [[ -n "${SERVER_IP}" ]]; then
    printf '%s\n' "${SERVER_IP}"
    return
  fi
  ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}'
}

compose_down_if_exists() {
  local compose_file="$1"
  [[ -f "${compose_file}" ]] || return 0
  docker compose -f "${compose_file}" down --remove-orphans
}

compose_up_if_exists() {
  local compose_file="$1"
  shift
  [[ -f "${compose_file}" ]] || return 0
  docker compose -f "${compose_file}" up -d "$@"
}

restart_optional_docusaurus() {
  local docusaurus_dir="${SCRIPT_DIR}/docusaurus"
  local compose_file="${docusaurus_dir}/docker-compose.yml"
  local alt_compose_file="${docusaurus_dir}/compose.yml"

  if [[ -f "${compose_file}" ]]; then
    log "[Docusaurus] Restarting with docker-compose.yml..."
    docker compose -f "${compose_file}" down --remove-orphans
    docker compose -f "${compose_file}" up -d --build
    return
  fi

  if [[ -f "${alt_compose_file}" ]]; then
    log "[Docusaurus] Restarting with compose.yml..."
    docker compose -f "${alt_compose_file}" down --remove-orphans
    docker compose -f "${alt_compose_file}" up -d --build
    return
  fi

  if [[ -f "${docusaurus_dir}/package.json" ]]; then
    log "[Docusaurus] package.json exists, but no compose file was found. Skipping automatic restart."
  fi
}

main() {
  require_docker

  local server_ip
  server_ip="$(detect_server_ip)"
  server_ip="${server_ip:-127.0.0.1}"

  local flowise_url="http://${server_ip}:3991"
  local flowise_compose="${SCRIPT_DIR}/flowise/docker-compose.yml"
  local login_compose="${SCRIPT_DIR}/login/docker-compose.yml"

  log "Starting EasyPost services..."

  log "[Flowise] Restarting..."
  compose_down_if_exists "${flowise_compose}"
  compose_up_if_exists "${flowise_compose}"

  log "[EasyPost API/Admin/Redis/Worker] Restarting..."
  compose_down_if_exists "${login_compose}"
  FLOWISE_URL="${flowise_url}" compose_up_if_exists "${login_compose}" --build

  restart_optional_docusaurus

  log ""
  log "Done."
  log "  Login   : http://${server_ip}:3982"
  log "  Admin   : http://${server_ip}:3978"
  log "  Flowise : http://${server_ip}:3991"
  log "  Worker  : easypost_posting_worker"
  log "  Redis   : easypost_redis"
}

main "$@"
