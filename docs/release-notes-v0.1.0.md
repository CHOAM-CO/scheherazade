# v0.1.0 (DRAFT — branch feat/attach-topology, not yet cut)

> 버전 컷/번호는 미노 판단 대기. 이 문서는 브랜치 내용의 릴리즈 노트 초안.
> 빌드는 `npm run dist` (build 아님), dmg 컷 ≠ 설치 (춘식 박스 스왑은 수동).

## Attach topology (design-0016 O2) — 에이전트가 앱 밖에서 산다

TCC 권한이 릴리즈마다 깨지는 근본 원인(ad-hoc 서명 = 릴리즈마다 cdhash
변경)을 토폴로지로 우회한다. 에이전트 런타임을 사용자 터미널에서 부트스트랩한
tmux 세션(`-L scheherazade`, 세션 `agent`)으로 옮기고, 앱은 얇은 attach
클라이언트가 된다.

- **불변식: 앱은 절대 tmux 서버를 만들지 않는다.** 앱이 만든 서버는 TCC
  귀속이 앱 서명으로 다시 묶여서 조용히 원점 회귀한다. 코드 레벨 강제:
  `attach-topology.cjs`의 verb allowlist가 `new-session`/`start-server`를
  차단.
- 부트스트랩 = 설정 페이지가 건네주는 한 줄을 사용자가 자기 터미널에서 실행
  (터미널 계보 = 리허설로 검증된 귀속 레인; launchd 레인은 리허설에서 사망).
- 앱 재시작/종료가 에이전트를 죽이지 않는다. 죽은 pane은 `respawn-pane`으로
  부활 (원래 커맨드 재사용, run.sh가 .agent-config 재소싱 → 모델 스왑 동작).
- `exit-empty off` + `remain-on-exit on`이 하중을 받는다 (라이브 프로브로
  발견: 기본값은 마지막 세션과 함께 서버가 죽음).
- 설정 UI: 토폴로지 선택(의도) + 상태 줄(현실) + 부트스트랩 커맨드 복사 카드.
- 기존 spawn 레인은 그대로 폴백 (AGENT_TOPOLOGY 기본값 spawn, 가역).

## sudo containment (P4)

- 비밀번호는 설정에서 한 번 입력 → safeStorage 금고 (Keychain 백엔드,
  라운드트립 검증, 디스크 평문 없음).
- 복호화는 오직 `GET /api/sudo/password`, 이중 게이트: 부팅마다 새로 뽑는
  랜덤 토큰(0600 파일) AND 설정 토글(기본 OFF).
- 에이전트는 `sudo -A` + 렌더된 askpass 헬퍼(curl --max-time 10)로 사용.
- 정직한 경계: 앱이 꺼져 있으면 sudo도 안 된다. 이벤트만 로깅, 값은 절대.

## Tests

attach 스위트 35/35 신설 + 회귀 344 green (supervisor 125 / packaging 36 /
hooks-port 61 / channel-connect 19 / log-buffer 33 / context-gauge 28 /
journal 35 / hook-lane-path 7).

## Gated

- 춘식 step3 (부트스트랩 귀속 축복 확인, 미노 손) — 본체는 step3 무관,
  부트스트랩 레인의 grant 동작만 대기.
