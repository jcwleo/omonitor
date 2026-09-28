# omonitor

내 컴퓨터에서 실행 중인 [omo](https://github.com/code-yeongyu/oh-my-openagent) 세션을 브라우저에서 보고 관리하는 로컬 대시보드입니다. 기본 실행은 **실제 omo app-server**에 연결합니다. 시뮬레이터는 별도 명령으로만 실행합니다.

## 시작하기

[Bun](https://bun.sh) 1.1 이상과 `omo`가 필요합니다. 의존성 설치나 빌드 단계는 없습니다.

```sh
# 소스를 내려받습니다.
git clone https://github.com/jcwleo/omonitor.git
cd omonitor

# 터미널 1: 로컬 omo app-server를 시작합니다 (이미 실행 중이면 그대로 둡니다).
omo app-server daemon start
omo app-server daemon status

# 터미널 2: 같은 저장소에서 대시보드를 실행합니다.
bun start
```

브라우저에서 <http://127.0.0.1:4800>을 엽니다. 종료할 때는 `bun start`가 실행 중인 터미널에서 Ctrl-C를 누릅니다. 별도로 시작한 app-server를 종료하려면 `omo app-server daemon stop`을 사용합니다.

연결에 실패하면 상단 배너에 사유와 재시도 상태가 표시됩니다. `omo app-server daemon status`로 서버를 확인하세요. 기본 주소는 `ws://127.0.0.1:18800`이며, 연결할 때마다 `~/.omo/agent/app-server/ws-token`을 읽습니다.

| 변수 | 기본값 | 용도 |
| --- | --- | --- |
| `PORT` | `4800` | 대시보드 포트 |
| `OMO_APP_SERVER_URL` | `ws://127.0.0.1:18800` | omo app-server 주소 |
| `OMO_WS_TOKEN_FILE` | `~/.omo/agent/app-server/ws-token` | app-server 인증 토큰 파일 |

예: 다른 포트의 app-server에 붙이려면 `OMO_APP_SERVER_URL=ws://127.0.0.1:18990 bun start`를 사용하고, app-server의 `--ws-auth` 토큰 경로가 다르면 `OMO_WS_TOKEN_FILE`도 지정합니다.

시연용 데이터를 보려면 **별도로** `bun run mock`을 실행합니다. `bun start`는 연결 실패 시 시뮬레이터로 전환하지 않습니다.

## 실제 세션 사용

- 보드에서 과거 세션을 누르면 백엔드가 세션 파일(`~/.omo/agent/sessions/…jsonl`)을 **직접 읽어** 대화·도구 호출·todo를 보여 줍니다. app-server의 `thread/read`는 세션을 로드하므로 쓰지 않습니다. 보드를 열거나 세션을 보는 것만으로는 어떤 세션도 app-server에 로드되지 않습니다.
- 이미 app-server 프로세스에 로드된 세션은 자동으로 구독합니다. 새 활동이 생긴 세션도 구독하며 승인·질문은 인박스에 표시합니다.
- 로드되지 않은 세션에 메시지를 보내거나 구독하면 확인 창을 거친 뒤 `thread/resume`으로 로드합니다. 터미널 omo에서 같은 세션이 열려 있으면 두 프로세스가 같은 파일에 기록하니 먼저 종료하세요.
- **목표(goal)나 끝나지 않은 todo가 있는 세션은 app-server에 로드되는 순간 omo가 자동으로 이어서 작업할 수 있습니다.** 대시보드가 구독 중이면 진행 상황과 질문이 화면에 보이지만, 원치 않으면 로드하기 전에 터미널에서 `/stop-continuation`으로 멈추세요.
- 기록은 세션 파일에서 읽으므로 omo app-server를 재시작해도 대화·도구 호출·todo가 그대로 보입니다. 추론 요약과 파일 diff 같은 세부 아이템은 지금 app-server가 실행한 턴에만 표시됩니다.
- 승인·질문은 서버에서 **구독한 연결에만** 전달됩니다. 대시보드를 닫은 동안 승인은 자동 거절되었을 수 있습니다.
- 명령·파일 승인 요청(`item/commandExecution/requestApproval`, `item/fileChange/requestApproval`)이 오면 인박스와 세션 화면에 승인 카드로 표시합니다. 다만 omo의 기본 권한 설정(`full-access`)은 승인을 묻지 않고, 2026-09-28 기준 omo app-server 세션에서는 프로젝트 `.omo/settings.json`에 `{"permission": {"edit": "ask"}}`를 넣어도 승인 요청이 오지 않는 것을 확인했습니다. `eval` 안에서 실행하는 셸 명령은 omo 권한 검사 대상도 아닙니다.
- 에이전트 탭과 컨텍스트 사용량은 세션 파일에서 계산합니다(`task` 실행·완료 기록, 마지막 응답의 토큰 사용량 ÷ 모델 컨텍스트 창). app-server가 이 정보를 보내지 않기 때문이며, 턴과 서브에이전트 호출이 끝날 때마다 갱신합니다.
- 대시보드 서버를 다시 시작해도 열린 탭이 새 세션 키를 받아 자동으로 다시 연결합니다.
- 세션 작성창이나 새 세션 창에 이미지를 붙여넣거나(⌘V) 끌어다 놓거나 "이미지" 버튼으로 고르면(png·jpeg·gif·webp, 20MB 이하) `~/.omonitor/uploads/`에 저장하고, 메시지에 파일 경로를 붙여 보냅니다. 클립보드에 텍스트가 함께 있으면 텍스트만 붙여넣습니다. 지금 omo app-server는 턴 입력으로 이미지를 받지 않아서, 에이전트가 `read` 도구로 그 파일을 열어 봅니다. 이미지를 지원하지 않는 모델에서는 이미지가 빠집니다. 저장된 파일은 자동으로 지우지 않습니다.

## 구조와 보안

브라우저는 `127.0.0.1:4800/ws`에 연결합니다. Bun 백엔드(`server.ts`)가 토큰이 필요한 `omo app-server` WebSocket에 일대일로 중계합니다. 브라우저에는 app-server 토큰을 전달하지 않습니다. 대시보드는 정적 런타임 파일만 서빙하며 `/ws`, `/api/*`에 로컬 Origin과 실행별 세션 키를 요구합니다. 붙여넣은 이미지(`/uploads/<무작위 UUID>`)는 `<img>`로 불러오도록 키 없이 서빙하며, 추측할 수 없는 이름으로만 열립니다.

이 앱은 **로컬 전용**으로 `127.0.0.1`에 바인딩됩니다. 인터넷이나 공용 Wi-Fi에 직접 노출하지 마세요. omo는 셸 실행과 파일 수정을 수행할 수 있으므로, 이 대시보드에 접근할 수 있는 사람은 로컬 사용자 권한으로 작업할 수 있습니다.

화면 런타임(`support.js`)의 React와 Google Fonts는 외부 CDN에서 내려받습니다. 완전한 오프라인 앱은 아닙니다.

| 파일 | 역할 |
| --- | --- |
| `server.ts` | 정적 파일·API·인증된 WebSocket 중계 |
| `Mission Control.dc.html`, `Mc*.dc.html` | 대시보드와 UI 컴포넌트 |
| `app/real-client.js`, `app/store.js` | 실제 클라이언트와 화면 상태 |
| `app/mock-client.js` | 명시적 시뮬레이터용 클라이언트 |
| `src/` | 프로토콜 타입과 상태 로직 참고 소스 |

개발용 디자인 탐색 파일(`Board Options.dc.html` 등)은 서버에서 공개되지 않습니다.
