# Custom provider registration: agent operability gaps (Mino's Sera agent report, 2026-10-12 18:35 KST)

Source: Mino forwarded his in-app agent's report in idea home. Request: "에이전트가 앱 직접 조작할 수 있게 풀어줘" (let the agent drive provider registration itself). Verbatim content below, Korean.

## 0. 한 줄 요약
에이전트는 크레덴셜 스토어와 lane 설정 파일에는 쓸 수 있지만, 앱 UI의 provider 카탈로그에는 접근할 방법이 없어서, "등록돼 있지만 셀렉터에는 안 보이는" 반쪽 상태가 된다. 비밀값(키)의 주입 경로가 에이전트에게 전면 차단되어 있어서 UI 경로도 자가완결이 불가능하다.

## 1. 하려던 것
Google AI Studio 무료 티어 Gemini API 키 발급(성공) -> Scheherazade에 Gemini provider 등록 -> 사용.

## 2. 성공한 경로 (lane 레벨)
- 키를 `.dsh-lane-home/.credentials.yaml`에 `GEMINI_API_KEY`로 기록 (dsh-credentials-local chokidar 핫퍼블리시 확인).
- `lane.patch.yml`의 `llm-pi-ai -> providers`에 `gemini` 블록 추가: baseURL `https://generativelanguage.googleapis.com/v1beta/openai/`, models gemini-3.6-flash / gemini-3.8-flash.
- 실호출: GET models 200(62개), gemini-3.6-flash chat 200. 3.8은 503, gemma-4-31b-it 500 (서버 사정).

## 3. 막힌 경로
### 3.1 앱 UI 폼은 열고 채울 수 있지만 API key 필드에 값을 넣을 방법이 에이전트에게 없음
- 클립보드 읽기 권한 거부; CDP evaluate로 읽으면 키가 에이전트 로그에 노출(금지); 페이지 간 전달(fetch/sendBeacon HTTPS->http localhost) 브라우저 차단; postMessage 브리지도 키가 에이전트 가독 경로에 떨어져 기각.
### 3.2 lane 레벨 provider가 세션 모델 셀렉터에 안 뜸
- 등록 완료 후 미노 확인: 세션 시작 모델 드랍다운에 gemini 없음. 셀렉터는 앱 UI 레벨 provider 카탈로그만 읽음. 재시작과 무관(리스팅 소스가 UI 스토어로 고정).

## 4. 제안 (우선순위)
- P1. 커스텀 프로바이더 폼 API key 필드에 "파일 경로 참조" 옵션. 에이전트는 경로만 넘기고 앱이 파일을 읽어 크레덴셜 스토어에 시더.
- P2. `lane.patch.yml` providers에 등록된 모델도 세션 시작 모델 셀렉터에 표시.
- P3. `dsh credentials set KEY` / `dsh providers list` 최소 CLI.
- P4. (외부 콘솔 얘기, 대상 아님) copy 버튼 성공/실패가 접근성 트리에 남게.
- P5. SCHEHERAZADE_MANUAL.md에 provider 등록 두 경로(UI vs lane.patch.yml)와 각각 어디에 보이는지 명시.

## 5. 남은 일
1. 앱 UI 등록 -> 셀렉터 gemini 표출 확인 -> 실사 턴. 2. gemma-4-31b-it 500 재시도. 3. 발급 계정 RPM/TPM/RPD 확인.
