# EasyPost.md

# 1.0 설치

모든 것은 docker의 container기반의 서비스로 구축한다.
- Flowise를 설치한다.

## 1.1 Flowise 설치

### 파일 구조
```
flowise/
├── docker-compose.yml
└── .env.example
```

### 실행 방법

```bash
cd flowise

# .env 파일 생성 후 비밀번호 설정
cp .env.example .env
vi .env

# 실행
docker compose up -d

# 로그 확인
docker compose logs -f

# 중지
docker compose down
```

### 접속
- URL: http://localhost:3991
- 기본 계정: `.env` 파일의 `FLOWISE_USERNAME` / `FLOWISE_PASSWORD`


# 2. Login 화면

# 2.1 Login 화면
  
  - 로그인 화면에서 ID/PW를 넣으면 로그인이 된다. 
  - 다수의 사용자가 존재할 수 있으므로 PostgreSQL DB를 설치해서 진행한다.
  - DB는 EasyPost_USER db를 기반으로 진행한다.
    만약 EasyPost_USER 가 없으면 생성한다.
  - 기본 ID는 
    id : freegear 
    pw : gundam 
  - 로그인 화면은 
    포트가 3982 로 해서 들어가는 로그인 창을 만들어줘
    

  - User ID 와 PW 는 PostgreSQL로 저장 된다.
    

# 3 네이버 까페

https://cafe.naver.com/amoapt

jylim3
Gundam11!!


# 4 Agentic AI

agentic AI를 4개를 만들 것인데

# 4.1 Naver Login A.AI

첫번째가 flowise를 사용하여 네이버를 로그인하려고 한다. 
구성을 만들어줘
