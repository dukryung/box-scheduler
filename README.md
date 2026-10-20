# box-scheduler

하루 24시간을 10분 단위 박스(144칸)로 나눠 task를 배치하는 타임박싱 웹 앱.

## 구성

| 서비스 | 기술 | 포트 |
|---|---|---|
| `web` | React + Vite + TypeScript (nginx로 서빙, `/api` 프록시) | http://localhost:3080 |
| `api` | Go (chi, pgx, goose) | http://localhost:8080 |
| `db` | PostgreSQL 16 | localhost:5433 |

## 실행

```sh
cp .env.example .env   # 필요 시 비밀번호 변경
docker compose up -d --build
```

DB 마이그레이션은 `api`가 시작할 때 자동으로 적용된다.

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
- 계정을 넣기 전의 데이터는 **소유자 계정**으로 이어진다. 처음 실행하면 서버 로그에 한 번만 쓸 수 있는 설정 링크가 나온다: `docker compose logs api | grep setup`. 그 링크에서 이메일·비밀번호를 정하거나 "Google로 소유자 계정 만들기"를 누르면 소유자 겸 첫 어드민이 된다(서버를 다시 시작하면 링크가 바뀐다).
- **Google 로그인**: `.env`에 `GOOGLE_CLIENT_ID`·`GOOGLE_CLIENT_SECRET`을 넣으면 로그인·가입·소유자 설정 화면에 "Google로 계속하기"가 나타난다(OpenID Connect, PKCE + state 쿠키 + nonce). 설정 방법:
  1. [Google Cloud Console](https://console.cloud.google.com/) → API 및 서비스 → OAuth 동의 화면(외부, 앱 이름·이메일) → 범위는 기본(`openid`, `email`, `profile`)만.
  2. 사용자 인증 정보 → OAuth 클라이언트 ID 만들기 → 웹 애플리케이션 → 승인된 리디렉션 URI에 `http://localhost:3080/api/auth/google/callback` (배포 후에는 `PUBLIC_URL/api/auth/google/callback`도) 추가.
  3. 나온 클라이언트 ID·보안 비밀을 `.env`에 넣고 `docker compose up -d api`.
  - Google 이메일이 기존 비밀번호 계정과 같으면 자동으로 합치지 않는다(가입 이메일은 인증되지 않았으므로). 비밀번호로 로그인한 뒤 설정 → 로그인 방법에서 Google을 연결한다. Google로만 가입한 계정은 설정에서 비밀번호를 추가할 수 있고, 비밀번호가 있어야 Google 연결을 끊을 수 있다.
- 어드민(`/admin`): 사용자 검색, 정지·해제, 어드민 권한, 비밀번호 재설정 링크(24시간, 1회), 삭제, 관리 기록. 다른 사람의 일정·할 일 내용은 보이지 않고 개수만 보인다. 소유자 계정과 자기 계정은 여기서 바꿀 수 없다.
- 로그인 시도는 이메일당 15분 10회, IP당 15분 60회(`LOGIN_LIMIT_PER_IP`), 가입은 IP당 1시간 10회(`SIGNUP_LIMIT_PER_IP`)로 제한한다. 다른 사이트에서 오는 쓰기 요청은 막는다(JSON 요청만 허용 + `Sec-Fetch-Site`).
- HTTPS 뒤에서 운영할 때는 `COOKIE_SECURE=true`, 설정 링크 주소용으로 `PUBLIC_URL`을 지정한다.
- AI 기능은 지금 소유자 계정만 서버의 Claude 구독으로 쓸 수 있다. 다른 계정은 다음 단계에서 본인 Anthropic API 키나 로컬 LLM을 연결해 쓰게 된다(구독 OAuth 토큰을 받아 쓰는 방식은 Anthropic 정책상 허용되지 않음).

### 테스트 환경

브라우저 테스트(`e2e/`)는 가짜 Google(`e2e/fake-google.mjs`)과 함께 실제 데이터와 분리된 compose 프로젝트(포트 3180/8180/5543, AI_PROVIDER=fake)에서만 실행한다. 스크립트는 다른 주소로는 실행을 거부한다.

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
| `/admin` | 사용자 관리 (어드민만) |
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
| GET | `/api/admin/users?q=` · `/api/admin/stats` · `/api/admin/audit` | 사용자 목록(개수만) · 현황 · 관리 기록 (어드민) |
| PATCH · DELETE | `/api/admin/users/{id}` | 권한·상태 변경 `{role?, status?}` · 계정 삭제 (어드민) |
| POST | `/api/admin/users/{id}/reset-link` | 비밀번호 재설정 링크 발급 (어드민) |
| GET | `/api/days/{date}` | 하루치 블록 + Brain Dump + 메모 |
| PUT | `/api/days/{date}/note` | 하루 메모 저장 `{note}` |
| GET | `/api/tasks` | 할 일 보관함 목록 (날짜 없는 항목, 여러 날에 걸친 배정·완료 시간 포함) |
| POST | `/api/tasks` | 보관함에 추가 `{title, estimateBoxes?, dueDate?, priority?, note?}` |
| POST | `/api/brain-dump/{id}/move` | 항목을 날짜로(`{date}`) 또는 보관함으로(`{date: null}`) 옮김 |
| POST | `/api/days/{date}/carry-over` | 그날의 미완료(open) Brain Dump 항목을 `{to}` 날짜로 복사, 원본은 `carried` 처리 |
| POST | `/api/days/{date}/ai-suggest` | AI 일정 제안 `{fromSlot, toSlot}` (저장하지 않음) |
| POST | `/api/days/{date}/ai-apply` | 수락한 제안 블록 일괄 저장 (겹치면 전체 409) |
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
