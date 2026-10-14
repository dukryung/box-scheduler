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

### 프론트엔드 개발 모드

```sh
docker compose up -d db api
cd web && npm install && npm run dev   # http://localhost:5173, /api는 :8080으로 프록시
```

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
| GET | `/api/calendar?month=YYYY-MM` | 월간 요약 (날짜별 상위 3개 블록, 개수, 계획/완료 박스) |
| POST | `/api/blocks` | 블록 생성 `{date, startSlot, endSlot, title, color?, brainDumpId?}` |
| PATCH | `/api/blocks/{id}` | 블록 수정 (이동/리사이즈/완료) |
| DELETE | `/api/blocks/{id}` | 블록 삭제 |
| POST | `/api/brain-dump` | Brain Dump 추가 `{date, title, estimateBoxes?, priority?, category?}` |
| PATCH | `/api/brain-dump/{id}` | Brain Dump 수정 |
| DELETE | `/api/brain-dump/{id}` | Brain Dump 삭제 |

현재는 단일 사용자 모드(시드된 기본 사용자)로 동작한다.
