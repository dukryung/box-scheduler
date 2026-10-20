# box-scheduler

하루 24시간을 10분 단위 박스(144칸)로 나눠 task를 배치하는 타임박싱 웹 앱.

## 구성

서비스(앱)와 관리자 콘솔은 서로 다른 프로세스·포트·DB 계정으로 돈다. 서비스에 트래픽이 몰려도 콘솔은 따로 살아 있고, 콘솔의 무거운 조회가 서비스를 느리게 하지 않는다.

| 서비스 | 기술 | 포트 |
|---|---|---|
| `web` | 앱 화면: React + Vite + TypeScript (nginx, `/api` → `api`) | http://localhost:3080 |
| `api` | 앱 서버: Go (`cmd/api`), DB 계정 `app_service` | http://localhost:8080 |
| `admin-web` | 관리자 콘솔 화면 (`admin-web/`, nginx, `/api` → `admin-api`) | http://localhost:3090 |
| `admin-api` | 관리자 서버: Go (`cmd/admin`), DB 계정 `app_admin`, 연결 5개 | http://localhost:8090 |
| `migrate` | 시작 전에 한 번: 마이그레이션 + DB 계정·권한 설정 (`cmd/migrate`) | – |
| `db` | PostgreSQL 16 | localhost:5433 |

```
[사용자] → web :3080 → api :8080 ─┐
                                   ├→ PostgreSQL (public: 앱 데이터 / admin: 관리자 계정·세션·기록)
[관리자] → admin-web :3090 → admin-api :8090 ─┘
```

- `app_service`는 `admin` 스키마에 접근할 수 없다. `app_admin`은 일정·할 일 테이블과 비밀번호 해시를 읽을 수 없고, `admin.user_accounts`·`admin.user_counts` 뷰로 계정 정보와 개수만 본다. 상태 변경·세션 삭제·재설정 링크 발급·계정 삭제만 허용된다.
- 테마 토큰은 두 화면이 `shared/theme.css`를 같이 쓴다.

## 실행

```sh
cp .env.example .env   # 필요 시 비밀번호 변경
docker compose up -d --build
```

`migrate`가 먼저 마이그레이션과 DB 계정(`SERVICE_DB_PASSWORD`, `ADMIN_DB_PASSWORD`, `.env`)을 적용한 뒤 `api`와 `admin-api`가 시작된다.

### AI 일정 제안 설정

기본값(`AI_PROVIDER=claude-cli`)은 Claude 구독으로 `claude -p`를 실행한다.

```sh
claude setup-token          # 1년짜리 토큰 발급 (Pro/Max 등 구독 필요)
# 발급된 토큰을 .env 의 CLAUDE_CODE_OAUTH_TOKEN= 에 넣고
docker compose up -d api
```

- 구독 사용량 한도를 Claude Code와 함께 쓴다. 개인용으로만 사용할 것.
- `ANTHROPIC_API_KEY`는 비워둔다. CLI 모드에서는 서버가 이 값을 지우고 실행하지만, 실수로 과금되지 않도록 비워두는 것이 안전하다.
- API 키 방식으로 바꾸려면 `AI_PROVIDER=anthropic-api` + `ANTHROPIC_API_KEY`를 설정한다.
- `AI_PROVIDER=fake`는 Claude를 부르지 않는 고정 응답(테스트용), `none`은 기능 끔.

AI는 할 일의 소요 시간 추정·분할·우선순위·선호 시간대만 정하고, 실제 배치는 서버의 `internal/scheduler`가 빈 시간에 겹치지 않게 한다.

### 시간표와 Brain Dump 연결

Brain Dump는 그날 할 일 전체 목록이고, 시간표는 그중 시간을 정한 일이다. 모든 블록은 Brain Dump 항목에 속한다 (`time_blocks.brain_dump_id NOT NULL`, migration 00004). 규칙은 `server/internal/store/sync.go`에서 블록·항목 변경과 같은 트랜잭션으로 지킨다.

- 시간표에서 바로 만든 블록 → 같은 이름의 항목이 자동으로 생긴다. Brain Dump에 먼저 적은 항목은 시간표에 넣을 때만 블록이 생긴다.
- 완료는 양방향: 블록을 모두 완료하면 항목 완료, 항목을 체크하거나 풀면 블록도 함께 바뀐다.
- 블록이 하나뿐인 항목은 이름과 날짜를 블록과 함께 바꾼다.
- 블록을 지우면 블록이 남지 않은 항목도 지운다(보관함 항목은 남김). 항목을 지우면 블록도 지운다.
- Brain Dump는 "아직 시간표에 없음(미배정) / 시간표에 있음 / 완료"로 묶여 보이고, 시간 칩을 누르면 시간표의 블록으로 이동한다.

### 할 일 보관함

날짜는 정하지 않았지만 꼭 해야 하는 일은 보관함(`brain_dump_items.date IS NULL`)에 둔다. 마감일(`due_date`), 중요도(`priority` 1 높음·2 보통·3 낮음), 메모(`note`)를 가질 수 있다.

- 빠른 입력: `계약서 검토 1시간 ~10/30 !` → 예상 1시간, 마감 10/30, 중요
- 일간 화면 왼쪽의 [보관함] 탭에서 시간표로 끌어다 놓거나(휴대폰은 "넣기") "오늘 하기"로 그날 Brain Dump로 가져온다. Brain Dump 항목은 "나중에"로 보관함에 보낼 수 있다.
- 일정을 넣어도 끝낼 때까지 보관함에 남고, 연결된 블록을 모두 완료해 예상 시간을 채우면 자동으로 완료된다.
- 오늘 화면 상단에 기한 지남·오늘·내일 마감 알림, 월간 달력에 마감일 표시.
- AI 일정 제안은 "보관함에서 마감이 가깝거나 중요한 일도 함께 넣기"(기본 켜짐)일 때 7일 안에 마감이거나 기한이 지났거나 중요한 항목을 후보로 함께 보낸다.

### 말로 요청하기

일간 화면 상단 입력창(⌘K) 또는 휴대폰 헤더의 마이크 버튼으로 "헬스장 8시로 미뤄줘", "내일 3시에 치과 1시간 넣어줘" 같은 요청을 글이나 음성(브라우저 음성 인식, ko-KR)으로 보낸다.
음성으로 말하면 말하는 동안 입력창에 바로 적히고, 말을 마치면(■ 또는 5초 침묵) 더 빠른 모델(`AI_TIDY_MODEL`, 기본 claude-haiku-5-5)이 군말·말 바꿈을 정리한 요청 문장으로 입력창 내용을 바꾼다(`POST /api/assistant/tidy`). "말한 그대로 보기"로 원문을 다시 볼 수 있고, 보내기(↑)는 항상 사용자가 직접 누른다.
Claude는 정해진 편집(블록 추가·이동·수정·삭제, Brain Dump 추가·수정·삭제)만 제안하고, `internal/assistant`가 대상 확인·10분 단위·겹침을 검사한 뒤 미리보기로 보여준다. 항상 확인 후 적용되며, 적용 직후 10초간 되돌리기가 가능하다.

### 계정과 어드민

- 누구나 이메일 + 비밀번호(8자 이상)로 가입하면 바로 쓸 수 있다. 비밀번호는 argon2id 해시로만 저장하고, 로그인은 서버 세션 쿠키(HttpOnly, SameSite=Lax, 30일)로 유지한다.
- 앱 계정에는 관리자 권한이 없다. 관리는 아래 관리자 콘솔에서 따로 한다.
- 계정을 넣기 전의 데이터는 **소유자 계정**으로 이어진다. 처음 실행하면 서버 로그에 한 번만 쓸 수 있는 설정 링크가 나온다: `docker compose logs api | grep setup`. 그 링크에서 이메일·비밀번호를 정하거나 "Google로 소유자 계정 만들기"를 누르면 소유자가 된다(서버를 다시 시작하면 링크가 바뀐다). 소유자는 서버의 Claude 구독으로 AI를 쓸 수 있는 앱 계정이다.
- **Google 로그인**: `.env`에 `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`을 넣으면 로그인·가입·소유자 설정 화면에 "Google로 계속하기"가 나타난다(OpenID Connect, PKCE + state 쿠키 + nonce). 설정 방법:
  1. [Google Cloud Console](https://console.cloud.google.com/) → API 및 서비스 → OAuth 동의 화면(외부, 앱 이름·이메일) → 범위는 기본(`openid`, `email`, `profile`)만.
  2. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 웹 애플리케이션 → 승인된 리디렉션 URI에 `http://localhost:3080/api/auth/google/callback` (배포 후에는 `PUBLIC_URL/api/auth/google/callback`도) 추가.
  3. 나온 클라이언트 ID·보안 비밀을 `.env`에 넣고 `docker compose up -d api`.
  - Google 이메일이 기존 비밀번호 계정과 같으면 자동으로 합치지 않는다(가입 이메일은 인증되지 않았으므로). 비밀번호로 로그인한 뒤 설정 → 로그인 방법에서 Google을 연결한다. Google로만 가입한 계정은 설정에서 비밀번호를 추가할 수 있고, 비밀번호가 있어야 Google 연결을 끊을 수 있다.
- 로그인 시도는 이메일당 15분 10회, IP당 15분 60회(`LOGIN_LIMIT_PER_IP`), 가입은 IP당 1시간 10회(`SIGNUP_LIMIT_PER_IP`)로 제한한다. 다른 사이트에서 오는 쓰기 요청은 막는다(JSON 요청만 허용 + `Sec-Fetch-Site`).
- HTTPS 뒤에서 운영할 때는 `COOKIE_SECURE=true`, 설정 링크 주소용으로 `PUBLIC_URL`을 지정한다.
- AI 기능은 계정마다 **내 AI**를 연결해 쓴다(아래). 소유자 계정은 서버의 Claude 구독도 고를 수 있다. 다른 사람의 구독 OAuth 토큰을 받아 쓰는 방식은 Anthropic 정책상 허용되지 않아 지원하지 않는다.

### 내 AI 연결 (설정 → AI 연결)

- **Anthropic API 키**: console.anthropic.com에서 만든 키 + 모델(Opus 5.5 / Sonnet 5.5 / Haiku 5.5). 비용은 그 계정으로 청구된다. 음성 정리는 이 키로 Haiku를 쓴다.
- **로컬 LLM**: OpenAI 호환 서버(Ollama `:11434`, LM Studio `:1234`) 주소 + 모델("모델 불러오기"로 목록에서 선택). 출력은 JSON 스키마로 강제하고, 지원하지 않는 서버는 JSON 모드로 다시 요청한다.
- 저장하기 전에 짧은 요청으로 연결을 확인한다. 기능별로(AI로 시간 정하기 · 말로 요청하기 · 음성 정리) 쓸 AI를 고르며, 처음 연결한 AI가 모든 기능에 기본으로 들어간다.
- 키는 `AI_SECRET_KEY`(64자리 hex, `openssl rand -hex 32`)로 AES-256-GCM 암호화해 저장하고, 화면·API·관리자 콘솔 어디에도 다시 나오지 않는다(끝 4자리만).
- 로컬 LLM 주소는 서버 내부망을 찌르지 못하게 루프백·사설·링크로컬(클라우드 메타데이터)·CGNAT 주소를 막고, DNS 조회 뒤 실제로 붙는 IP를 다시 확인하며 리디렉션은 따라가지 않는다. 집 네트워크의 Mac mini를 쓰려면 `.env`에 허용 목록을 넣는다: `AI_ALLOW_PRIVATE=192.168.0.0/16` 또는 `AI_ALLOW_PRIVATE=mac-mini.local`. 서버를 클라우드에 올리면 Tailscale·Cloudflare Tunnel 같은 주소를 쓴다.

### 관리자 콘솔 (http://localhost:3090)

- **관리자 계정은 화면에서 만들 수 없다.** 서버 명령으로만 만든다. 임시 비밀번호가 한 번 출력되고, 첫 로그인 때 12자 이상 새 비밀번호와 2단계 인증(TOTP: Google Authenticator, 1Password 등)을 설정해야 콘솔이 열린다.
  ```sh
  docker compose exec admin-api admin create --email you@example.com --name 이름 --role super
  docker compose exec admin-api admin list
  docker compose exec admin-api admin reset --email you@example.com     # 임시 비밀번호 재발급, 2단계 인증 초기화, 잠금 해제
  docker compose exec admin-api admin disable --email …  /  enable --email …
  ```
- 역할: **최고 관리자**(`super`, 관리자 계정 관리까지) / **운영자**(`operator`, 사용자 관리). 최고 관리자는 한 명 이상 남아야 한다.
- 화면: 대시보드(사용자·활동·가입·AI 사용, 30일 추이), 사용자(검색·필터·정렬·페이지), 사용자 상세(로그인 방법, 기기별 세션과 강제 로그아웃, 운영 메모, AI 사용, 정지·재설정 링크·삭제), 관리 기록(관리자 로그인 성공/실패 포함, IP), 관리자 계정(최고 관리자만).
- 보안: 세션 쿠키 `bs_admin`(SameSite=Strict, 8시간, 30분 미사용 시 만료), 비밀번호 5회 실패 시 15분 잠금, 2단계 코드 재사용 거부, 삭제·권한 변경 같은 작업은 비밀번호 재확인, 응답 `no-store`, 화면 `noindex`·프레임 금지. 앱 쿠키로는 관리자 API를, 관리자 쿠키로는 앱 API를 쓸 수 없다.
- 다른 사람의 일정·할 일 내용은 콘솔에서 보이지 않는다(DB 권한으로도 막혀 있음). 공개 배포 전까지 콘솔은 이 컴퓨터(127.0.0.1)에서만 열린다.

### 테스트 환경

브라우저 테스트(`e2e/`)는 가짜 Google(`e2e/fake-google.mjs`)과 함께 실제 데이터와 분리된 compose 프로젝트(앱 3180/8180, 콘솔 3190/8190, DB 5543, AI_PROVIDER=fake)에서만 실행한다. 스크립트는 다른 주소로는 실행을 거부한다.

```sh
cd e2e && npm install
npm run stack   # 테스트 전용 스택 빌드·실행 (e2e/test.env)
npm test        # *.test.mjs 전체 실행
npm run setup-check   # 새 DB의 임시 스택(boxsetup, :3280)에서 Google로 소유자 계정 만들기를 확인하고 지움
```

### 프론트엔드 개발 모드

```sh
docker compose up -d db api
cd web && npm install && npm run dev   # http://localhost:5173, /api는 :8080으로 프록시
```

## 화면 주소

| 주소 | 화면 |
|---|---|
| `/day/YYYY-MM-DD` | 일간 시간표 + Brain Dump |
| `/month/YYYY-MM` | 월간 달력 (날짜별 블록 요약, 보관함 마감일 표시, 클릭 시 일간으로 이동) |
| `/tasks` | 할 일 보관함 (날짜 없는 할 일, 마감·중요도별 묶음) |
| `/stats?range=7d` | 통계 (`7d`, `30d`, `month`, `last-month`) |
| `/login`, `/signup` | 로그인, 가입 |
| `/setup?token=…` | 첫 실행 때 소유자 계정 만들기 (서버 로그의 링크) |
| `/reset?token=…` | 어드민이 발급한 링크로 비밀번호 다시 정하기 |
| `/settings` | 내 계정, AI 연결, 화면 모드, 비밀번호, 로그아웃, 계정 삭제 |
| `/` | 오늘 일간 화면으로 이동 (로그인 안 했으면 로그인으로) |

## 슬롯 규칙

- 슬롯 = 10분, 하루 `0..143`. 예: 10:00 → 60, 10:20 → 62
- 블록은 `[startSlot, endSlot)` 반개구간. 10:00–10:20 = `{startSlot: 60, endSlot: 62}`
- 같은 날 블록 겹침은 DB의 `EXCLUDE` 제약으로 차단되며 API는 `409 Conflict`를 반환한다.

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스 체크 |
| POST | `/api/auth/signup` · `/login` · `/logout` | 가입(바로 로그인) · 로그인 · 로그아웃 |
| GET · PATCH · DELETE | `/api/auth/me` | 내 계정 보기 · 이름 바꾸기 · 계정 삭제(`{password}`) |
| POST | `/api/auth/password` | 비밀번호 변경 `{current, new}` (다른 기기는 로그아웃) |
| GET · POST | `/api/auth/setup` | 소유자 설정 필요 여부 · 설정 `{token, email, password, name}` |
| POST | `/api/auth/reset` | 재설정 링크로 새 비밀번호 `{token, password}` |
| GET | `/api/auth/providers` | 켜진 로그인 방법 `{google}` |
| GET | `/api/auth/google/start?next=&setup=&link=1` · `/api/auth/google/callback` | Google 로그인 시작(브라우저 이동) · Google에서 돌아오는 주소 |
| POST | `/api/auth/google/unlink` | Google 연결 끊기 (비밀번호가 있을 때만) |
| GET | `/api/days/{date}` | 하루치 블록 + Brain Dump + 메모 |
| PUT | `/api/days/{date}/note` | 하루 메모 저장 `{note}` |
| GET | `/api/tasks` | 할 일 보관함 목록 (날짜 없는 항목, 여러 날에 걸친 배정·완료 시간 포함) |
| POST | `/api/tasks` | 보관함에 추가 `{title, estimateBoxes?, dueDate?, priority?, note?}` |
| POST | `/api/brain-dump/{id}/move` | 항목을 날짜로(`{date}`) 또는 보관함으로(`{date: null}`) 옮김 |
| POST | `/api/days/{date}/carry-over` | 그날의 미완료(open) Brain Dump 항목을 `{to}` 날짜로 복사, 원본은 `carried` 처리 |
| POST | `/api/days/{date}/ai-suggest` | AI 일정 제안 `{fromSlot, toSlot}` (저장하지 않음) |
| POST | `/api/days/{date}/ai-apply` | 수락한 제안 블록 일괄 저장 (겹치면 전체 409) |
| GET | `/api/ai` | 내 AI 연결 목록(키 제외), 기능별 선택, 고를 수 있는 모델 |
| POST · DELETE | `/api/ai/connections` · `/api/ai/connections/{id}` | 연결 추가(확인 후 저장) `{kind: anthropic\|openai, model, apiKey?, baseUrl?, label?}` · 삭제 |
| POST | `/api/ai/connections/{id}/test` · `/api/ai/models` | 연결 다시 확인 · 로컬 서버의 모델 목록 `{baseUrl, apiKey?}` |
| PUT | `/api/ai/settings` | 기능별 AI `{plan, request, tidy}` (`server`(소유자만) · 연결 id · `''`) |
| POST | `/api/assistant/tidy` | 받아 적은 음성을 짧은 요청 문장으로 정리해 돌려줌 (보내기·저장 안 함) |
| POST | `/api/assistant/preview` | 말로 한 요청을 Claude가 편집 목록으로 바꾸고, 서버가 겹침을 검사해 미리보기로 돌려줌 (저장 안 함) |
| POST | `/api/assistant/apply` | 미리본 편집을 한 번에 적용하고 되돌리기용 편집 목록을 반환 (겹치면 전체 409) |
| GET | `/api/stats?from=YYYY-MM-DD&to=YYYY-MM-DD` | 기간 통계: 합계, 날짜별·시간대별 계획/완료, 상위 작업, Brain Dump 상태 수 (최대 1년) |
| GET | `/api/calendar?month=YYYY-MM` | 월간 요약 (날짜별 상위 3개 블록, 개수, 계획/완료 박스) |
| POST | `/api/blocks` | 블록 생성 `{date, startSlot, endSlot, title, color?, brainDumpId?}` |
| PATCH | `/api/blocks/{id}` | 블록 수정 (이동/리사이즈/완료) |
| DELETE | `/api/blocks/{id}` | 블록 삭제 |
| POST | `/api/brain-dump` | Brain Dump 추가 `{date, title, estimateBoxes?, priority?, category?}` |
| PATCH | `/api/brain-dump/{id}` | Brain Dump 수정 |
| DELETE | `/api/brain-dump/{id}` | Brain Dump 삭제 |

`/api/auth/signup`·`login`·`setup`·`reset`과 헬스 체크를 뺀 모든 API는 로그인이 필요하고, 데이터는 계정별로 나뉜다.

### 관리자 API (`admin-api`, :8090 — 앱 서버에는 없음)

| Method | Path | 설명 |
|---|---|---|
| POST | `/api/auth/login` · `/logout` | 관리자 로그인(다음 단계 `stage`: password · enroll · totp · ok) · 로그아웃 |
| GET · POST | `/api/auth/me` · `/api/auth/password` | 내 정보 · 비밀번호 변경 |
| POST | `/api/auth/totp/setup` · `/api/auth/totp/verify` | 2단계 인증 키 발급 · 코드 확인(설정 또는 로그인 완료) |
| GET | `/api/dashboard` | 합계와 30일 추이 |
| GET | `/api/users?q=&filter=&sort=&limit=&offset=` · `/api/users/{id}` | 사용자 목록 · 상세(세션, 메모, AI 사용) |
| PATCH · DELETE | `/api/users/{id}` | 정지/해제 `{status}` · 삭제 `{password}` |
| POST | `/api/users/{id}/sessions/revoke` · `/reset-link` · `/notes` | 강제 로그아웃 `{session?}` · 재설정 링크 · 메모 |
| GET | `/api/audit?q=&action=&target=` | 관리 기록 |
| GET · POST · PATCH | `/api/admins` · `/api/admins/{id}` · `/api/admins/{id}/reset` | 관리자 계정 (최고 관리자, 비밀번호 재확인) |
