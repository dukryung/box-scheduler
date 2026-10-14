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

### 말로 요청하기

일간 화면 상단 입력창(⌘K) 또는 휴대폰 헤더의 마이크 버튼으로 "헬스장 8시로 미뤄줘", "내일 3시에 치과 1시간 넣어줘" 같은 요청을 글이나 음성(브라우저 음성 인식, ko-KR)으로 보낸다.
Claude는 정해진 편집(블록 추가·이동·수정·삭제, Brain Dump 추가·수정·삭제)만 제안하고, `internal/assistant`가 대상 확인·10분 단위·겹침을 검사한 뒤 미리보기로 보여준다. 항상 확인 후 적용되며, 적용 직후 10초간 되돌리기가 가능하다.

### 테스트 환경

브라우저 테스트는 실제 데이터와 분리된 compose 프로젝트에서만 실행한다.

```sh
docker compose -p boxtest --env-file test.env up -d --build   # test.env: 다른 포트(예: 3180/8180/5543), AI_PROVIDER=fake
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
| `/month/YYYY-MM` | 월간 달력 (날짜별 블록 요약, 클릭 시 일간으로 이동) |
| `/stats?range=7d` | 통계 (`7d`, `30d`, `month`, `last-month`) |
| `/` | 오늘 일간 화면으로 이동 |

## 슬롯 규칙

- 슬롯 = 10분, 하루 `0..143`. 예: 10:00 → 60, 10:20 → 62
- 블록은 `[startSlot, endSlot)` 반개구간. 10:00–10:20 = `{startSlot: 60, endSlot: 62}`
- 같은 날 블록 겹침은 DB의 `EXCLUDE` 제약으로 차단되며 API는 `409 Conflict`를 반환한다.

## API

| Method | Path | 설명 |
|---|---|---|
| GET | `/api/health` | 헬스 체크 |
| GET | `/api/days/{date}` | 하루치 블록 + Brain Dump + 메모 |
| PUT | `/api/days/{date}/note` | 하루 메모 저장 `{note}` |
| POST | `/api/days/{date}/carry-over` | 그날의 미완료(open) Brain Dump 항목을 `{to}` 날짜로 복사, 원본은 `carried` 처리 |
| POST | `/api/days/{date}/ai-suggest` | AI 일정 제안 `{fromSlot, toSlot}` (저장하지 않음) |
| POST | `/api/days/{date}/ai-apply` | 수락한 제안 블록 일괄 저장 (겹치면 전체 409) |
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

현재는 단일 사용자 모드(시드된 기본 사용자)로 동작한다.
