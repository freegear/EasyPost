# Agent 1: Naver Login with Flowise

## Architecture

Flowise should orchestrate the agent, and the browser login work should run in the dedicated `naver-login-agent` service.

```text
Flowise Agent
  -> HTTP Tool: POST http://naver-login-agent:3010/login
  -> Playwright browser automation
  -> /sessions/<naver-id>.json
```

The login worker does not bypass captcha, OTP, or other manual verification. If Naver asks for additional verification, the worker returns `verification_required`.

## Run

```bash
cd /root/EasyPost/flowise
docker compose up -d --build
```

Flowise:

```text
http://localhost:3991
```

Health check from inside the Docker network:

```bash
docker exec flowise wget -qO- http://naver-login-agent:3010/health
```

## Flowise Tool

Create an HTTP Request Tool in Flowise.

Name:

```text
naver_login
```

Method:

```text
POST
```

URL:

```text
http://naver-login-agent:3010/login
```

Body:

```json
{
  "username": "{{naver_id}}",
  "password": "{{naver_pw}}"
}
```

Expected success response:

```json
{
  "ok": true,
  "status": "logged_in",
  "sessionFile": "/sessions/example.json",
  "message": "Naver login session was saved."
}
```

Expected manual verification response:

```json
{
  "ok": false,
  "status": "verification_required",
  "reason": "additional_verification_required",
  "message": "Manual verification may be required. Captcha or 2-step verification is not bypassed."
}
```

## Recommended Agent Prompt

```text
You are the Naver login agent for EasyPost.
Use the naver_login tool only when the user explicitly requests login or posting preparation.
Never guess credentials.
If the tool returns verification_required, tell the user that manual Naver verification is required.
If login succeeds, report that the Naver browser session has been saved.
```

## API

Login:

```bash
docker exec flowise node -e "fetch('http://naver-login-agent:3010/login', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ username: 'NAVER_ID', password: 'NAVER_PASSWORD' })
}).then(r => r.text()).then(console.log)"
```

The service is not exposed to the host by default. It is intended to be called by Flowise over the `easypost` Docker network.

Delete saved session:

```bash
docker exec naver_login_agent wget -qO- --method=DELETE http://localhost:3010/sessions/NAVER_ID
```
