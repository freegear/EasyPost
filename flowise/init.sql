-- EasyPost_USER 데이터베이스 생성
CREATE DATABASE "EasyPost_USER";

\c "EasyPost_USER";

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id            SERIAL PRIMARY KEY,
    username      VARCHAR(50) UNIQUE NOT NULL,
    password      VARCHAR(255) NOT NULL,
    email         VARCHAR(100),
    phone_number  VARCHAR(30),
    is_active     BOOLEAN NOT NULL DEFAULT TRUE,
    is_admin      BOOLEAN NOT NULL DEFAULT FALSE,
    last_login_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE posting_logs (
    id            BIGSERIAL PRIMARY KEY,
    user_id       INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    username      VARCHAR(50) NOT NULL,
    slot_id       INTEGER NOT NULL,
    slot_name     VARCHAR(255) NOT NULL,
    post_id       INTEGER,
    schedule_type VARCHAR(20),
    scheduled_for TIMESTAMPTZ NOT NULL,
    status        VARCHAR(20) NOT NULL,
    reason        TEXT,
    posted_url    TEXT,
    detail        JSONB NOT NULL DEFAULT '{}'::jsonb,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE (user_id, slot_id, scheduled_for)
);

CREATE INDEX posting_logs_user_created_idx ON posting_logs (user_id, created_at DESC);
