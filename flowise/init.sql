-- EasyPost_USER 데이터베이스 생성
CREATE DATABASE "EasyPost_USER";

\c "EasyPost_USER";

CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
    id        SERIAL PRIMARY KEY,
    username  VARCHAR(50)  UNIQUE NOT NULL,
    password  VARCHAR(255) NOT NULL,
    email     VARCHAR(100),
    is_active BOOLEAN   DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 기본 사용자: freegear / gundam
INSERT INTO users (username, password)
VALUES ('freegear', crypt('gundam', gen_salt('bf')));
