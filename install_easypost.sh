#!/usr/bin/env bash
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="${1:-install}"
VERSION="${EASYPOST_VERSION:-1.0.0}"
ARCHIVE_NAME="${EASYPOST_ARCHIVE:-easypost-images-${VERSION}.tar.gz}"
ARCHIVE_PATH="${SCRIPT_DIR}/${ARCHIVE_NAME}"
INSTALL_DIR="${EASYPOST_INSTALL_DIR:-/opt/easypost}"

LOGIN_IMAGE="easypost/login:${VERSION}"
ADMIN_IMAGE="easypost/admin:${VERSION}"
LOGIN_AGENT_IMAGE="easypost/naver-login-agent:${VERSION}"
CAFE_POSTER_IMAGE="easypost/naver-cafe-poster:${VERSION}"
FLOWISE_IMAGE="flowiseai/flowise:latest"
POSTGRES_IMAGE="postgres:16-alpine"

log() {
  printf '[EasyPost] %s\n' "$*"
}

die() {
  printf '[EasyPost] ERROR: %s\n' "$*" >&2
  exit 1
}

require_command() {
  command -v "$1" >/dev/null 2>&1 || die "'$1' 명령을 찾을 수 없습니다."
}

require_docker() {
  require_command docker
  docker info >/dev/null 2>&1 || die "Docker daemon에 연결할 수 없습니다."
  docker compose version >/dev/null 2>&1 || die "Docker Compose 플러그인이 필요합니다."
}

install_docker_if_needed() {
  if command -v docker >/dev/null 2>&1; then
    require_docker
    return
  fi

  [[ "$(id -u)" -eq 0 ]] || die "Docker 자동 설치에는 root 권한이 필요합니다."
  command -v apt-get >/dev/null 2>&1 ||
    die "Docker가 없습니다. Debian/Ubuntu 외 배포판에서는 Docker와 Compose 플러그인을 먼저 설치하세요."

  log "Docker를 설치합니다."
  apt-get update
  apt-get install -y ca-certificates curl
  curl -fsSL https://get.docker.com | sh
  systemctl enable --now docker >/dev/null 2>&1 || true
  require_docker
}

random_secret() {
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 24
  else
    tr -dc 'a-f0-9' </dev/urandom | head -c 48
  fi
}

package_images() {
  require_docker
  [[ -f "${SCRIPT_DIR}/login/server.js" ]] || die "EasyPost 프로젝트 루트에서 package 모드를 실행하세요."
  [[ -f "${SCRIPT_DIR}/admin/server.js" ]] || die "EasyPost 관리 서비스 소스를 찾을 수 없습니다."
  [[ -f "${SCRIPT_DIR}/html/index.html" ]] || die "대시보드 HTML을 찾을 수 없습니다."
  [[ -f "${SCRIPT_DIR}/css/style.css" ]] || die "대시보드 CSS를 찾을 수 없습니다."

  log "소스가 포함된 배포용 로그인 이미지를 빌드합니다."
  docker build \
    --tag "${LOGIN_IMAGE}" \
    --file - \
    "${SCRIPT_DIR}" <<'DOCKERFILE'
FROM node:20-slim
WORKDIR /app
RUN apt-get update && apt-get install -y \
    ca-certificates wget gnupg fonts-nanum fonts-noto-cjk \
    libasound2 libatk-bridge2.0-0 libatk1.0-0 libcairo2 libcups2 \
    libdbus-1-3 libdrm2 libexpat1 libfontconfig1 libgbm1 libglib2.0-0 \
    libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libx11-6 libx11-xcb1 \
    libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 \
    libxi6 libxkbcommon0 libxrandr2 libxrender1 libxss1 libxtst6 xdg-utils \
    --no-install-recommends && rm -rf /var/lib/apt/lists/*
COPY login/package.json ./
RUN npm install --omit=dev && npx playwright install chromium
COPY login/server.js ./server.js
COPY login/playwright ./playwright
COPY login/public ./public
COPY html ./html
COPY css ./css
CMD ["node", "server.js"]
DOCKERFILE

  log "네이버 자동화 이미지를 빌드합니다."
  docker build --tag "${ADMIN_IMAGE}" --file "${SCRIPT_DIR}/admin/Dockerfile" "${SCRIPT_DIR}"
  docker build --tag "${LOGIN_AGENT_IMAGE}" "${SCRIPT_DIR}/flowise/naver-login-agent"
  docker build --tag "${CAFE_POSTER_IMAGE}" "${SCRIPT_DIR}/flowise/naver-cafe-poster"

  log "기반 이미지를 준비합니다."
  docker pull "${FLOWISE_IMAGE}"
  docker pull "${POSTGRES_IMAGE}"

  log "이미지 묶음을 생성합니다: ${ARCHIVE_PATH}"
  docker save \
    "${LOGIN_IMAGE}" \
    "${ADMIN_IMAGE}" \
    "${LOGIN_AGENT_IMAGE}" \
    "${CAFE_POSTER_IMAGE}" \
    "${FLOWISE_IMAGE}" \
    "${POSTGRES_IMAGE}" | gzip -1 >"${ARCHIVE_PATH}"

  chmod 600 "${ARCHIVE_PATH}"
  log "패키징 완료"
  log "대상 서버로 다음 두 파일을 전달하세요:"
  log "  install_easypost.sh"
  log "  ${ARCHIVE_NAME}"
  log "대상 서버에서 실행: sudo ./install_easypost.sh install"
}

write_compose_file() {
  cat >"${INSTALL_DIR}/compose.yml" <<EOF
services:
  postgres:
    image: ${POSTGRES_IMAGE}
    container_name: easypost_postgres
    restart: unless-stopped
    environment:
      POSTGRES_USER: \${DB_USER}
      POSTGRES_PASSWORD: \${DB_PASSWORD}
      POSTGRES_DB: flowise
    volumes:
      - postgres_data:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U \${DB_USER}"]
      interval: 5s
      timeout: 5s
      retries: 20
    networks: [easypost]

  flowise:
    image: ${FLOWISE_IMAGE}
    container_name: flowise
    restart: unless-stopped
    ports:
      - "\${FLOWISE_PORT}:3000"
    environment:
      PORT: 3000
      FLOWISE_USERNAME: \${FLOWISE_USERNAME}
      FLOWISE_PASSWORD: \${FLOWISE_PASSWORD}
      APIKEY_PATH: /root/.flowise
      SECRETKEY_PATH: /root/.flowise
      LOG_PATH: /root/.flowise/logs
      STORAGE_TYPE: local
      BLOB_STORAGE_PATH: /root/.flowise/storage
      HTTP_SECURITY_CHECK: "false"
      DATABASE_TYPE: postgres
      DATABASE_HOST: postgres
      DATABASE_PORT: 5432
      DATABASE_USER: \${DB_USER}
      DATABASE_PASSWORD: \${DB_PASSWORD}
      DATABASE_NAME: flowise
      NAVER_LOGIN_AGENT_URL: http://naver-login-agent:3010
      MODEL_LIST_CONFIG_ALLOW_WEB_SCRAPER: "true"
      ALLOW_WEB_SCRAPER: "true"
    depends_on:
      postgres:
        condition: service_healthy
      naver-login-agent:
        condition: service_started
      naver-cafe-poster:
        condition: service_started
    volumes:
      - flowise_data:/root/.flowise
    networks: [easypost]

  naver-login-agent:
    image: ${LOGIN_AGENT_IMAGE}
    container_name: naver_login_agent
    restart: unless-stopped
    environment:
      PORT: 3010
      HEADLESS: "true"
      SESSION_DIR: /sessions
      NAVER_LOGIN_URL: https://nid.naver.com/nidlogin.login
    volumes:
      - naver_sessions:/sessions
    networks: [easypost]

  naver-cafe-poster:
    image: ${CAFE_POSTER_IMAGE}
    container_name: naver_cafe_poster
    restart: unless-stopped
    environment:
      PORT: 3011
      SESSION_DIR: /sessions
    volumes:
      - naver_sessions:/sessions
    networks: [easypost]

  login:
    image: ${LOGIN_IMAGE}
    container_name: easypost_login
    restart: unless-stopped
    ports:
      - "\${EASYPOST_PORT}:3000"
    environment:
      DB_HOST: postgres
      DB_USER: \${DB_USER}
      DB_PASSWORD: \${DB_PASSWORD}
      FLOWISE_URL: \${FLOWISE_URL}
      SESSION_SECRET: \${SESSION_SECRET}
      DATA_DIR: /app/data
    depends_on:
      postgres:
        condition: service_healthy
    volumes:
      - easypost_data:/app/data
    networks: [easypost]

  admin:
    image: ${ADMIN_IMAGE}
    container_name: easypost_admin
    restart: unless-stopped
    ports:
      - "\${EASYPOST_ADMIN_PORT}:3000"
    environment:
      DB_HOST: postgres
      DB_USER: \${DB_USER}
      DB_PASSWORD: \${DB_PASSWORD}
      SESSION_SECRET: \${ADMIN_SESSION_SECRET}
    depends_on:
      postgres:
        condition: service_healthy
    networks: [easypost]

networks:
  easypost:
    name: easypost
    driver: bridge

volumes:
  postgres_data:
    name: easypost_postgres_data
  flowise_data:
    name: flowise_data
  naver_sessions:
    name: easypost_naver_sessions
  easypost_data:
    name: easypost_data
EOF
}

write_env_file() {
  local server_ip="$1"
  local db_password="$2"
  local session_secret="$3"
  local flowise_password="$4"

  cat >"${INSTALL_DIR}/.env" <<EOF
DB_USER=easypost
DB_PASSWORD=${db_password}
SESSION_SECRET=${session_secret}
ADMIN_SESSION_SECRET=$(random_secret)
EASYPOST_PORT=${EASYPOST_PORT:-3982}
EASYPOST_ADMIN_PORT=${EASYPOST_ADMIN_PORT:-3978}
FLOWISE_PORT=${FLOWISE_PORT:-3991}
FLOWISE_URL=http://${server_ip}:${FLOWISE_PORT:-3991}
FLOWISE_USERNAME=${FLOWISE_USERNAME:-admin}
FLOWISE_PASSWORD=${flowise_password}
EOF
  chmod 600 "${INSTALL_DIR}/.env"
}

wait_for_postgres() {
  local attempts=0
  until docker exec easypost_postgres pg_isready -U easypost >/dev/null 2>&1; do
    attempts=$((attempts + 1))
    (( attempts < 60 )) || die "PostgreSQL 시작을 기다리다 시간 초과되었습니다."
    sleep 2
  done
}

initialize_database() {
  local admin_username="$1"
  local admin_password="$2"

  log "EasyPost 사용자 DB를 초기화합니다."
  docker exec easypost_postgres psql -U easypost -d postgres -v ON_ERROR_STOP=1 -tc \
    "SELECT 1 FROM pg_database WHERE datname = 'EasyPost_USER'" | grep -q 1 ||
    docker exec easypost_postgres createdb -U easypost EasyPost_USER

  docker exec -i easypost_postgres psql \
    -U easypost \
    -d EasyPost_USER \
    -v ON_ERROR_STOP=1 \
    --set=admin_username="${admin_username}" \
    --set=admin_password="${admin_password}" <<'SQL'
CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  username VARCHAR(50) UNIQUE NOT NULL,
  password VARCHAR(255) NOT NULL,
  email VARCHAR(100),
  phone_number VARCHAR(30),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  is_admin BOOLEAN NOT NULL DEFAULT FALSE,
  last_login_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);
ALTER TABLE users
ADD COLUMN IF NOT EXISTS email VARCHAR(100),
ADD COLUMN IF NOT EXISTS phone_number VARCHAR(30),
ADD COLUMN IF NOT EXISTS is_admin BOOLEAN NOT NULL DEFAULT FALSE;
INSERT INTO users (username, password, is_admin)
VALUES (:'admin_username', crypt(:'admin_password', gen_salt('bf')), TRUE)
ON CONFLICT (username) DO UPDATE SET is_admin = TRUE;
SQL
}

install_images() {
  [[ "$(id -u)" -eq 0 ]] || die "install 모드는 root 권한으로 실행하세요: sudo ./install_easypost.sh install"
  install_docker_if_needed
  [[ -f "${ARCHIVE_PATH}" ]] || die "이미지 묶음을 찾을 수 없습니다: ${ARCHIVE_PATH}"

  local server_ip="${SERVER_IP:-}"
  local admin_username="${EASYPOST_ADMIN_ID:-admin}"
  local admin_password="${EASYPOST_ADMIN_PASSWORD:-}"
  local db_password="${DB_PASSWORD:-$(random_secret)}"
  local session_secret="${SESSION_SECRET:-$(random_secret)}"
  local flowise_password="${FLOWISE_PASSWORD:-$(random_secret)}"

  if [[ -z "${server_ip}" ]]; then
    server_ip="$(ip route get 1.1.1.1 2>/dev/null | awk '{print $7; exit}')"
    server_ip="${server_ip:-127.0.0.1}"
  fi
  if [[ -z "${admin_password}" ]]; then
    read -r -s -p "EasyPost 관리자 비밀번호: " admin_password
    printf '\n'
    [[ -n "${admin_password}" ]] || die "관리자 비밀번호는 비워둘 수 없습니다."
  fi

  log "Docker 이미지 묶음을 로드합니다."
  gzip -dc "${ARCHIVE_PATH}" | docker load

  mkdir -p "${INSTALL_DIR}"
  chmod 700 "${INSTALL_DIR}"
  write_compose_file
  write_env_file "${server_ip}" "${db_password}" "${session_secret}" "${flowise_password}"

  log "PostgreSQL을 시작합니다."
  docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/compose.yml" up -d postgres
  wait_for_postgres
  initialize_database "${admin_username}" "${admin_password}"

  log "EasyPost 서비스를 시작합니다."
  docker compose --env-file "${INSTALL_DIR}/.env" -f "${INSTALL_DIR}/compose.yml" up -d

  log "설치 완료"
  log "  EasyPost: http://${server_ip}:${EASYPOST_PORT:-3982}"
  log "  Admin   : http://${server_ip}:${EASYPOST_ADMIN_PORT:-3978}"
  log "  Flowise : http://${server_ip}:${FLOWISE_PORT:-3991}"
  log "  관리자 ID: ${admin_username}"
  log "  설치 경로: ${INSTALL_DIR}"
  log "  상태 확인: docker compose --env-file ${INSTALL_DIR}/.env -f ${INSTALL_DIR}/compose.yml ps"
}

show_usage() {
  cat <<EOF
사용법:
  ./install_easypost.sh package
      개발 서버에서 소스 포함 Docker 이미지 묶음을 생성합니다.

  sudo ./install_easypost.sh install
      대상 서버에서 이미지 묶음을 설치합니다.

주요 환경변수:
  EASYPOST_VERSION, EASYPOST_ARCHIVE, EASYPOST_INSTALL_DIR
  EASYPOST_ADMIN_ID, EASYPOST_ADMIN_PASSWORD
  EASYPOST_PORT, EASYPOST_ADMIN_PORT, FLOWISE_PORT, SERVER_IP
EOF
}

case "${MODE}" in
  package) package_images ;;
  install) install_images ;;
  help|-h|--help) show_usage ;;
  *) show_usage; die "지원하지 않는 모드입니다: ${MODE}" ;;
esac
