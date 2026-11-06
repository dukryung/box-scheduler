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

### AI로 세분화 (보관함)

보관함의 큰 일(예: "API 문서화", 마감 10/31, 예상 20시간)을 AI가 하위 업무로 나누고, 서버가 날짜별로 배분한 뒤 확인을 받아 각 날짜의 Brain Dump에 넣는다.

- **AI 몫**: 3~8개의 하위 업무(순서, 예상 시간, 이유)와 메모. 예상 시간이 정해진 일이면 AI 합계를 비율 그대로 예상 시간에 맞춘다(작은 모델은 합계를 자주 놓침). AI는 "AI로 시간 정하기"와 같은 AI 설정을 따른다.
- **서버 몫**(`internal/breakdown`): 근무 09:00–18:00, 점심 11:00–12:00 제외 → 하루 8시간. 한 일은 하루 최대 2시간, 최소 10분. 월~금만. 그날 이미 있는 블록(근무 시간과 겹치는 만큼)과 아직 배치 안 한 할 일의 예상 시간을 빼고 남는 시간에만 넣는다. 오늘은 지금 이후 근무 시간만, 퇴근 1시간 전부터는 내일부터. 하위 업무 순서대로 앞날부터 채우고(순서대로 채우기), 근무일이 4일 이상이면 마지막 근무일은 여유로 남겼다가 모자랄 때만 쓴다. 못 넣은 시간은 "부족"으로 보여 준다.
- 미리보기에서 하위 업무 이름·시간·포함 여부·순서를 고치면 바로 다시 배분한다(AI 없이). 확인하면 날짜마다 "API 문서화 · 로그인 API 문서 작성" 같은 항목이 Brain Dump에 생기고(마감일 포함, `세분화` 배지), 원래 보관함 항목은 그대로 남아 조각들의 블록 시간으로 진행률이 오른다.
- 다시 세분화하면 아직 시간표에 없는 이전 조각만 바꾸고, 블록이 있거나 끝낸 조각은 둔다.

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
- AI 기능은 기본으로 **서비스 AI**(관리자가 등록한 로컬 LLM)를 쓰고, 원하면 **내 Anthropic API 키**를 연결한다(아래). 소유자 계정은 서버의 Claude 구독도 고를 수 있다. 다른 사람의 구독 OAuth 토큰을 받아 쓰는 방식은 Anthropic 정책상 허용되지 않아 지원하지 않는다.

### 서비스 AI (관리자 콘솔 → 서비스 AI)

서비스가 가진 로컬 LLM(예: Mac mini의 Ollama)을 모든 계정이 기본 AI로 쓴다. 사용자는 아무것도 연결하지 않아도 된다.

- 최고 관리자가 콘솔에서 서버 주소(OpenAI 호환, 예: `http://192.168.0.23:11434`), 기능별 모델, 동시 처리 수, 사용자별 하루 한도를 정한다. 저장할 때 모델 목록과 짧은 요청으로 연결을 확인하고, 비밀번호를 다시 묻고, 관리 기록에 남긴다. 키가 있으면 `AI_SECRET_KEY`로 암호화해 저장한다.
- **하루 한도**(기본 30회, 세 기능 합계, 한국 시간 자정에 초기화): 넘으면 `429 ai_limit`과 함께 내 API 키를 연결하라고 안내한다. 소유자 계정은 서버 Claude 구독을 쓰므로 한도가 없다.
- **대기열**: 앱 서버가 서비스 AI로 가는 요청을 동시 처리 수만큼만 보내고, 나머지는 최대 20건·2분까지 줄을 세운다(`GET /api/ai/queue`로 화면에 "AI 대기 중 · 앞에 n건"). 넘치면 `503 ai_busy`. 앱 서버를 여러 대로 늘리면 대기열은 서버마다 따로 돈다.
- 모든 AI 호출은 `ai_calls`(출처: service · own · server, 걸린 시간, 대기 시간, 성공)에 남아 한도와 콘솔 통계(24시간 호출·성공률·평균 응답·한도 다 쓴 사람, 14일 추이)에 쓰인다. 90일 지나면 지운다.
- Qwen3 모델은 생각 단계를 끄고(`/no_think`), 답에 `<think>`가 섞여 와도 걷어 낸다. JSON 스키마 출력을 지원하지 않는 서버에는 JSON 모드로 다시 요청한다.
- **Mac mini (M4 16GB) 준비**: `ollama pull qwen3:8b`(약 5GB) 하나로 세 기능을 모두 쓰고, `launchctl setenv OLLAMA_HOST 0.0.0.0`, `OLLAMA_NUM_PARALLEL 1`, `OLLAMA_KEEP_ALIVE 24h` 뒤 Ollama 재시작, 잠자기 방지. 콘솔의 동시 처리 수는 1. 공개 서비스에는 상업적 이용이 허용된 모델(Qwen·Gemma·Mistral 등)을 쓰고, 일정 내용이 이 컴퓨터로 간다는 점을 개인정보처리방침에 적는다.

### 내 API 키 (설정 → AI 연결, 선택)

- 서비스 AI 한도를 넘었거나 더 큰 모델이 필요하면 각자 Anthropic API 키(console.anthropic.com)를 연결한다. 비용은 그 계정에 청구되고, 음성 정리는 이 키로 Haiku를 쓴다. 저장 전에 짧은 요청으로 확인하며, 처음 연결하면 모든 기능이 그 키로 바뀐다(기능별로 다시 고를 수 있음).
- 키는 `AI_SECRET_KEY`(64자리 hex, `openssl rand -hex 32`)로 AES-256-GCM 암호화해 저장하고, 화면·API·콘솔 어디에도 다시 나오지 않는다(끝 4자리만).
- 사용자가 자기 로컬 LLM 주소를 넣는 기능은 없앴다(서비스 AI로 대신). 남은 내부 주소 차단(`internal/netguard`, `AI_ALLOW_PRIVATE`)은 사용자 입력 주소에만 쓰인다.

### 팀

- 모든 계정에는 **내 공간**(개인 시간표·Brain Dump·보관함)이 있고, 팀은 그 위에 만들거나 초대받아 들어간다. 한 사람이 여러 팀에 속할 수 있고, 헤더의 공간 전환(내 공간 ▾)이나 설정 → 내 팀에서 오간다.
- 새 계정은 처음 한 번 "혼자 쓸게요 / 팀을 만들게요 / 초대받았어요"를 고른다(`/welcome`). 초대로 들어오면 묻지 않는다.
- 역할: **owner**(팀당 1명, 팀 이름·삭제, 역할 변경, owner 넘기기) · **매니저**(초대·초대 취소·다시 보내기, 일반 멤버 내보내기) · **일반**. 팀원이 아닌 사람에게는 팀이 있는지도 보이지 않는다(404). owner는 owner를 넘긴 뒤에만 나갈 수 있다.
- **이메일 초대**: 여러 주소를 한 번에, 역할(매니저/일반)을 정해 보낸다. 링크는 7일, 한 번만 쓸 수 있고, **초대받은 이메일로 로그인(또는 가입, Google 포함)한 계정만** 수락할 수 있다. 다시 보내면 예전 링크는 더 이상 쓸 수 없다. 메일은 SMTP로 보낸다(`.env`의 `SMTP_HOST`·`SMTP_PORT`·`SMTP_USER`·`SMTP_PASS`·`MAIL_FROM`). 설정하기 전에는 초대 결과에 링크가 나와 직접 전달한다.
- 팀 업무·담당자·팀 월간 일정·일별 배분은 다음 단계에서 팀 화면(`/team/{id}`)에 붙는다.

### 회의 (팀 → 회의)

- 회의 내용을 붙여 넣거나 녹음하면, 서비스 AI가 백그라운드에서 회의록(요약·논의·결정)을 쓰고 맡은 할 일을 찾는다. 매니저가 담당자를 정해 확정하면 팀 업무가 된다. Mac mini의 모델은 4096토큰까지만 읽으므로 긴 회의는 1,800자씩 나눠 정리한 뒤 합친다.
- **녹음**: 브라우저가 15초 조각으로 바로 올린다(`MEETING_AUDIO_DIR`, Docker 볼륨 `meeting-audio`). 브라우저 음성 인식이 실시간 자막을 회의 내용에 30초마다 저장한다. 마이크는 `https` 주소나 `localhost`에서만 켜진다.
- **받아쓰기(화자 분리)**: 녹음이 끝나면 Mac mini가 Whisper large-v3-turbo(MLX, GPU)로 다시 받아쓰고, sherpa-onnx(pyannote segmentation + 3D-Speaker)로 화자를 나눈다. 회의 녹음 1분에 약 15~20초, 1시간이면 15분쯤 걸린다. "화자 1·2…"가 누구인지 고른 뒤 "회의 내용으로 쓰기"를 누르면 `이름: 말` 줄이 되어, AI가 할 일을 그 사람에게 준다. "끝내고 AI로 정리"는 받아쓰기가 끝나는 대로 회의록까지 이어서 만든다. 녹음 파일은 우리 서버와 Mac mini에만 가고, Mac mini에서는 처리 후 지운다.
- **Mac mini 받아쓰기 서버 설치** (`stt/`): Mac mini에서 `cd stt && ./install.sh`를 실행한다. 모델 약 1.7GB를 받고, `~/box-stt`에 설치하며, 로그인할 때 `127.0.0.1:11435`로 켜지는 LaunchAgent(`com.boxscheduler.stt`)를 등록한다. 이 MacBook의 SSH 터널에 `-L 127.0.0.1:11435:127.0.0.1:11435`를 더하고 `.env`에 `STT_URL=http://host.docker.internal:11435`를 넣는다. `STT_URL`이 비어 있으면 실시간 자막만 쓴다.
- **GPU 없는 리눅스 서버에 받아쓰기 설치** (`stt/Dockerfile`): Whisper를 CPU(faster-whisper, int8)로 돌린다. 모델은 이미지에 들어 있어 실행 중에는 인터넷이 필요 없다. `docker build -t box-stt stt` 후 `docker run -d --name box-stt --restart unless-stopped -p <사내망 IP>:11435:11435 box-stt`로 띄우고, 같은 네트워크의 `.env`에 `STT_URL=http://<사내망 IP>:11435`를 넣는다. 인증이 없으니 사내망 IP에만 연다. 사내 서버 107(Ryzen 9 7900X)에서는 32초짜리 녹음이 12초 걸렸다.

### 관리자 콘솔 (http://localhost:3090)

- **관리자 계정은 화면에서 만들 수 없다.** 서버 명령으로만 만든다. 임시 비밀번호가 한 번 출력되고, 첫 로그인 때 12자 이상 새 비밀번호와 2단계 인증(TOTP: Google Authenticator, 1Password 등)을 설정해야 콘솔이 열린다.
  ```sh
  docker compose exec admin-api admin create --email you@example.com --name 이름 --role super
  docker compose exec admin-api admin list
  docker compose exec admin-api admin reset --email you@example.com     # 임시 비밀번호 재발급, 2단계 인증 초기화, 잠금 해제
  docker compose exec admin-api admin disable --email …  /  enable --email …
  ```
- 역할: **최고 관리자**(`super`, 관리자 계정 관리까지) / **운영자**(`operator`, 사용자 관리). 최고 관리자는 한 명 이상 남아야 한다.
- 화면: 대시보드(사용자·활동·가입·AI 사용, 30일 추이), 서비스 AI(설정·상태·통계), 사용자(검색·필터·정렬·페이지), 사용자 상세(로그인 방법, 기기별 세션과 강제 로그아웃, 운영 메모, AI 사용, 정지·재설정 링크·삭제), 관리 기록(관리자 로그인 성공/실패 포함, IP), 관리자 계정(최고 관리자만).
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
| `/settings` | 내 계정, 내 팀, AI 연결, 화면 모드, 비밀번호, 로그아웃, 계정 삭제 |
| `/welcome` | 가입 후 한 번: 혼자 / 팀 만들기 / 초대받음 |
| `/teams/new` · `/team/{id}` | 팀 만들기 · 팀 홈(멤버, 이메일 초대, 대기 중인 초대, 설정) |
| `/invite/{token}` | 초대 메일의 링크: 가입·로그인 후 참여 |
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
| GET · POST | `/api/teams` | 내 팀 목록 · 팀 만들기 `{name}` (만든 사람이 owner) |
| GET · PATCH · DELETE | `/api/teams/{id}` | 팀 보기(멤버, 매니저 이상은 대기 중인 초대) · 이름 바꾸기 · 삭제 `{confirm: 팀 이름}` (owner) |
| POST | `/api/teams/{id}/invites` · `/invites/{inviteId}/resend` | 이메일 초대 `{emails, role}` · 다시 보내기 (매니저 이상) |
| DELETE | `/api/teams/{id}/invites/{inviteId}` | 초대 취소 (매니저 이상) |
| PATCH · DELETE | `/api/teams/{id}/members/{userId}` | 역할 변경 (owner) · 내보내기/나가기 |
| POST | `/api/teams/{id}/transfer` | owner 넘기기 `{userId}` |
| GET · POST | `/api/invites/{token}` · `/api/invites/{token}/accept` | 초대 정보(로그인 없이) · 수락(초대받은 이메일 계정만) |
| GET | `/api/auth/providers` | 켜진 로그인 방법 `{google}` |
| GET | `/api/auth/google/start?next=&setup=&link=1` · `/api/auth/google/callback` | Google 로그인 시작(브라우저 이동) · Google에서 돌아오는 주소 |
| POST | `/api/auth/google/unlink` | Google 연결 끊기 (비밀번호가 있을 때만) |
| GET | `/api/days/{date}` | 하루치 블록 + Brain Dump + 메모 |
| PUT | `/api/days/{date}/note` | 하루 메모 저장 `{note}` |
| GET | `/api/tasks` | 할 일 보관함 목록 (날짜 없는 항목, 여러 날에 걸친 배정·완료 시간 포함) |
| POST | `/api/tasks` | 보관함에 추가 `{title, estimateBoxes?, dueDate?, priority?, note?}` |
| POST | `/api/tasks/{id}/breakdown` · `/breakdown/allocate` · `/breakdown/apply` | AI 세분화 제안+배분 `{today, now, dueDate?}` · 고친 하위 업무 다시 배분 `{…, subtasks}` · 확인 후 Brain Dump에 추가 `{…, subtasks, replace}` |
| POST | `/api/brain-dump/{id}/move` | 항목을 날짜로(`{date}`) 또는 보관함으로(`{date: null}`) 옮김 |
| POST | `/api/days/{date}/carry-over` | 그날의 미완료(open) Brain Dump 항목을 `{to}` 날짜로 복사, 원본은 `carried` 처리 |
| POST | `/api/days/{date}/ai-suggest` | AI 일정 제안 `{fromSlot, toSlot}` (저장하지 않음) |
| POST | `/api/days/{date}/ai-apply` | 수락한 제안 블록 일괄 저장 (겹치면 전체 409) |
| GET | `/api/ai` | 내 AI 연결 목록(키 제외), 기능별 선택, 고를 수 있는 모델 |
| POST · DELETE | `/api/ai/connections` · `/api/ai/connections/{id}` | 내 API 키 연결(확인 후 저장) `{kind: anthropic, model, apiKey, label?}` · 삭제 |
| POST | `/api/ai/connections/{id}/test` | 연결 다시 확인 |
| PUT | `/api/ai/settings` | 기능별 AI `{plan, request, tidy}` (`service` · `server`(소유자만) · 연결 id · `''`) |
| GET | `/api/ai/queue` | 서비스 AI 대기열 `{running, waiting}` |
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
| GET · PUT | `/api/service-ai` | 서비스 AI 설정과 통계 · 저장(최고 관리자, 확인 후 저장, 비밀번호 재확인) |
| POST | `/api/service-ai/test` · `/api/service-ai/models` | 지금 연결 확인 · 서버의 모델 목록 |
