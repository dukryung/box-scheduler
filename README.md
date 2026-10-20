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

### 테스트 환경

브라우저 테스트(`e2e/`)는 실제 데이터와 분리된 compose 프로젝트(포트 3180/8180/5543, AI_PROVIDER=fake)에서만 실행한다. 스크립트는 다른 주소로는 실행을 거부한다.

```sh
cd e2e && npm install
npm run stack   # 테스트 전용 스택 빌드·실행 (e2e/test.env)
npm test        # *.test.mjs 전체 실행
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

현재는 단일 사용자 모드(시드된 기본 사용자)로 동작한다.
