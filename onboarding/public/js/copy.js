// copy.js — single source of truth for every user-facing string in the
// onboarding wizard + memory pane. Sourced VERBATIM from:
//   ~/Documents/MAGI_Memory/projects/scheherazade_onboarding_copy_v0_2026-07-03.md
//   ~/Documents/MAGI_Memory/projects/scheherazade_pane_copy_opener_criteria_2026-07-03.md §A
// Register: 간결 존댓말, no 이모지, no 느낌표, no cheerleading.
//
// Only the 제목:/본문:/버튼: lines and the code→copy table rows from the
// source file are copy. Everything else in that file (🔒 notes, >-quoted
// PO annotations, ⚠️ flags, parenthetical implementation notes) is PO
// scaffolding, not shipped text -- it must not appear here.
//
// Strings marked "AUTHORED (not in copy file)" below are new UI surfaces the
// copy files did not specify (settings page, generic infra-error banner).
// Written in the same register, flagged here so they are easy to find and
// replace if Idea/PO writes real copy for them later.

// getOnboardToken() -- reads the per-launch localhost-auth token that
// onboarding/http-server.cjs's serveStatic() injects into every page's
// <head> as a <meta name="onboard-token"> tag (security review,
// 2026-07-03). Every page's local api() helper (wizard.js/memory.js/
// settings.js) attaches this as the X-Onboard-Token header on mutating
// (POST/DELETE) requests -- GET requests don't need it. Loaded here (in
// copy.js, which every page includes first) so all four pages share one
// definition instead of four copies.
window.getOnboardToken = function () {
  const meta = document.querySelector('meta[name="onboard-token"]')
  return meta ? meta.getAttribute('content') : null
}

window.COPY = {
  step0: {
    title: '설정을 시작합니다',
    // Full-autonomy disclosure (Mino 2026-07-04 16:26 "에이전트한테 권한 다
    // 주기" + 2026-07-05 02:12 "권한 최대한 열어주기, 반박 안받음"): the old
    // macOS-protected-folders sentence was REMOVED on Mino's direct order --
    // onboarding now requests Documents/Downloads/Desktop TCC grants, so
    // that sentence would be false. The folder line below states the new
    // reality honestly. FDA: no longer deferred -- requested at setup via
    // the Step-0 card below (Mino 2026-07-07 16:58 "full disk access도
    // 온보딩중에 그냥 설정창 켜버리고 받아버리셈"). Source doc §Step 0
    // updated in the same pass -- keep verbatim-synced.
    body: '3분이면 끝납니다. 모든 정보는 이 컴퓨터에만 저장됩니다. 완성된 에이전트는 매번 허락을 묻지 않고 스스로 일합니다. 문서, 다운로드, 데스크톱 폴더는 에이전트가 직접 읽고 씁니다.',
    button: '시작',
    // AUTHORED (not in copy source file) -- Full Disk Access card
    // (2026-07-07, Mino directive above). Honest about the two macOS
    // constraints: the toggle itself must be clicked by the user (no
    // programmatic grant exists), and the grant needs an app restart
    // (TCC caches at process launch).
    fda: {
      title: '전체 디스크 접근',
      bodyMissing: '에이전트가 Mac의 파일을 제대로 다루려면 전체 디스크 접근 권한이 필요합니다. 버튼을 누르면 설정 화면이 열립니다. 목록에서 Scheherazade를 켜주세요.',
      bodyGrantedPendingRestart: '권한이 켜진 것 같습니다. 적용하려면 앱을 다시 시작해야 합니다.',
      bodyGranted: '전체 디스크 접근이 켜져 있습니다.',
      openButton: '설정 열기',
      relaunchButton: '앱 다시 시작',
      skipHint: '나중에 설정에서도 켤 수 있습니다.',
    },
  },

  // Step 1 v2 (source file §Step 1, 2026-07-04 01:20 redesign): each
  // provider's PRIMARY path is now account login (subscription billing),
  // API key is a folded-away fallback. Ground: key issuance was the
  // highest-friction point in onboarding, and the wrong billing axis for
  // Max/Plus subscribers -- Mino himself dropped off at Step 1 (01:09) and
  // NEO logs showed existing subscription OAuth silently beating an
  // injected key anyway.
  //
  // UI-SCOPE NOTE (2026-07-04 06:xx, Idea/Melchior): the backend's
  // ROUTER_WIRED flag flipped true overnight (own-infra-first found no
  // router build is needed, direct env wiring suffices) -- but that is a
  // BACKEND capability fact, separate from the 22:02 Mino-approved UI scope
  // lock (Claude-only ships v1, chatgpt/ollama = v1.1). Do not wire tab
  // visibility straight off GET /api/config's routerWired field. Both the
  // real primary-path copy AND the disabled/coming-soon copy are included
  // below for every tab so wizard.js can render whichever the UI-scope
  // decision calls for without another copy pass either way.
  step1: {
    title: '사용할 모델을 연결하세요',
    body: '쓰고 있는 계정으로 로그인하면 됩니다. 구독 요금제가 그대로 적용되고, 로그인 정보는 이 Mac에만 저장됩니다.',
    // Zero-auth consent card (2026-07-13). Shown only when this Mac already has
    // a Claude Code CLI login. Three rules baked into this copy:
    //   1. Say what we did NOT do (no copy, no store, no read) -- the whole
    //      value of detect-and-reuse is that it touches nothing.
    //   2. `cost` is MANDATORY and never softened: reusing the login spends the
    //      user's own subscription quota. A "we found it, we'll just use it"
    //      framing that omits this is a lie by omission.
    //   3. `alt` keeps the other paths visible. A found login is an offer, not
    //      a fait accompli.
    foundLogin: {
      title: '이 Mac에 이미 Claude Code 로그인이 있습니다',
      body: '그 로그인을 그대로 쓸 수 있습니다. 복사하지 않고, 따로 저장하지 않고, 내용을 열어보지도 않습니다 (있는지만 확인했습니다). 붙여넣을 키도 없습니다.',
      cost: '사용량은 회원님의 Claude 구독에서 차감됩니다.',
      use: '이 로그인 그대로 쓰기',
      alt: '다른 계정을 쓰고 싶다면 아래에서 직접 연결하세요.',
      // Expired-login disclosure, placed HERE on purpose (red-team 2026-07-13,
      // axis "false availability"). We check only that the login file exists,
      // never what is in it -- so an expired login still reads as available and
      // the agent then fails to start with a generic error.
      //
      // The two ways to fail faster were both rejected: reading the credential
      // to inspect its expiry is exactly the promise this mode makes ("내용을
      // 열어보지도 않습니다"), and firing a validation call through the CLI
      // spends the user's quota before they have agreed to spend any. So the
      // honest move is to spend one sentence, at the moment of consent, telling
      // the user what the failure will look like and how to fix it.
      staleHint: '로그인이 만료된 상태라면 에이전트가 시작되지 않습니다. 그때는 터미널에서 claude 를 한 번 실행해 다시 로그인한 뒤 재시도해주세요.',
    },
    tabs: [
      {
        id: 'claude',
        label: 'Claude',
        // v1 = paste flow (confirmed 2026-07-04 03:2x): earlier copy
        // promised an in-app browser launch ("브라우저가 한 번 열립니다 / 키
        // 입력 불필요"), but the actual mechanism is a terminal command +
        // paste. Same "don't imply one-click" principle as the Ollama
        // honesty note below -- copy corrected to match implementation.
        primary: {
          // validating/failure (2026-07-04 06:4x, Melchior's wizard.js gate
          // caught this): the submit handler is shared between this
          // sub-mode (provider=claude-subscription, pasting an OAuth token)
          // and the fallback sub-mode (provider=claude, pasting an x-api-key)
          // -- wizard.js had nothing under step1.tabs[claude].primary to
          // reach for and reused step1.fallback.validating/failure for both,
          // which says "키" (key). Wrong noun for a token. Branch wizard.js's
          // handler on state.provider === 'claude-subscription' to pull
          // these instead of fallback.*; fallback.* stays correct as-is for
          // the actual key-paste path. success stays shared (fallback.success
          // = plain '연결됐습니다', no wrong noun in it either way) --
          // step1-level loginSuccess below is NOT currently wired to
          // anything (no {plan} field confirmed on the validate response
          // yet); leaving it in place for whenever that lands, not a v1
          // blocker.
          validating: '토큰을 확인하는 중입니다',
          failure: (reason) => `토큰이 거부됐습니다 (원인: ${reason}). 명령어를 다시 실행해 새 토큰을 붙여넣어주세요.`,
          precondition: 'Claude Pro 또는 Max 구독과 claude 명령어 설치가 필요합니다.',
          steps: [
            '터미널에서 claude setup-token을 실행하세요',
            '브라우저에서 Claude 계정으로 로그인하세요',
            '터미널에 표시된 토큰을 아래 칸에 붙여넣으세요',
          ],
          copyCommand: 'claude setup-token',
          subtext: 'API 키 발급이 필요 없습니다. 구독이 그대로 적용되고, 토큰은 이 Mac의 키체인에만 저장됩니다.',
          button: '연결 확인',
        },
      },
      {
        id: 'chatgpt',
        label: 'ChatGPT',
        disabledLabel: 'ChatGPT (곧 지원)',
        primary: {
          button: '로컬 Codex에 연결',
          precondition: 'Codex 설치와 codex login (ChatGPT 계정 브라우저 인증)이 필요합니다.',
          subtext: '이 Mac의 Codex가 계정 인증을 대신합니다. 앱에 키를 저장하지 않습니다.',
        },
      },
      {
        id: 'ollama',
        label: 'Ollama Cloud',
        disabledLabel: 'Ollama Cloud (곧 지원)',
        primary: {
          button: '로컬 Ollama에 연결 (클라우드 모델)',
          precondition: 'Ollama 앱이 설치되어 있고 ollama signin을 마친 상태여야 합니다.',
          subtext: '이 Mac의 Ollama가 계정 서명을 대신합니다. 앱에 키를 저장하지 않습니다.',
          // Honesty note (source file): Path A is friction-moved, not
          // friction-removed (install+signin happen outside the app) --
          // copy must not imply one-click. In-app signin (Path B) = v1.1.
          failures: {
            not_running: 'Ollama가 실행 중이 아닙니다. Ollama 앱을 켜고 다시 시도해주세요.',
            not_signed_in: 'Ollama 계정 로그인이 안 되어 있습니다. 터미널에서 ollama signin을 실행한 뒤 다시 시도해주세요.',
          },
        },
      },
    ],
    loginWaiting: '브라우저에서 로그인을 마치면 이 화면이 바뀝니다.',
    loginSuccess: (plan) => `연결됐습니다. ${plan} 요금제로 동작합니다.`,
    loginFailure: '로그인이 완료되지 않았습니다. 다시 시도하거나, 아래에서 API 키로 연결할 수 있습니다.',
    // AUTHORED (not in copy source file) -- in-app login shell-out UI
    // strings (Path B, 2026-07-07): the app now runs `codex login` /
    // `ollama signin` itself, so these tabs show a login button instead of
    // a key field. The precondition strings above describe the old Path-A
    // (Terminal pre-run) flow and are superseded inside the login area;
    // kept untouched for a future copy pass to reconcile. Flagged per the
    // COPY_BUTTON_LABEL precedent (wizard.js).
    login: {
      chatgpt: {
        button: 'ChatGPT 계정으로 로그인',
        lead: '버튼을 누르면 브라우저에서 ChatGPT 로그인이 열립니다. 키를 붙여넣을 필요가 없습니다.',
      },
      ollama: {
        button: 'Ollama 계정으로 로그인',
        lead: '버튼을 누르면 Ollama 계정 로그인이 진행됩니다. 키를 붙여넣을 필요가 없습니다.',
        modelLabel: '사용할 클라우드 모델',
        modelPlaceholder: '모델 이름을 입력하세요',
        modelHint: 'ollama.com의 모델 목록에서 이름을 복사해 넣으세요.',
      },
      successNoPlan: '연결됐습니다. 로그인 정보는 이 Mac에만 저장됩니다.',
      starting: '로그인을 시작하는 중입니다',
      cancelled: '로그인을 취소했습니다. 다시 시도할 수 있습니다.',
      timeout: '로그인 대기 시간이 지났습니다. 다시 시도해주세요.',
      reloginLabel: '다른 계정으로 로그인',
      // Lazy dependency install (2026-07-07): shown INSTEAD of the login
      // button when the provider's CLI is not on this Mac yet -- the app
      // downloads and verifies it itself (Apple 서명 확인), no Terminal,
      // no admin password.
      install: {
        needed: (name) => `${name} 구성 요소가 이 Mac에 아직 없습니다. 자동으로 설치할 수 있습니다.`,
        button: '자동 설치',
        downloading: (pct) => (pct == null ? '내려받는 중입니다' : `내려받는 중입니다 (${pct}%)`),
        installing: '설치하고 확인하는 중입니다',
        done: '설치됐습니다. 이제 로그인할 수 있습니다.',
        failed: '설치에 실패했습니다. 네트워크를 확인하고 다시 시도해주세요.',
        retryButton: '다시 시도',
        // Windows v1 = detection-only (managed install is mac-only): the
        // wizard shows link + re-detect instead of the download button.
        manualNeeded: (name) => `${name} 구성 요소가 이 PC에 아직 없습니다. Windows에서는 공식 설치 페이지에서 직접 설치한 뒤 다시 확인해주세요.`,
        manualOpenButton: '설치 페이지 열기',
        manualOpened: '브라우저에서 설치 페이지를 열었습니다. 설치가 끝나면 "다시 확인"을 눌러주세요.',
        redetectButton: '다시 확인',
        stillMissing: (name) => `${name}을(를) 아직 찾지 못했습니다. 설치를 마친 뒤 다시 확인해주세요.`,
      },
    },
    // Folded-away fallback path. Field-level hint text is unchanged from
    // the pre-v2 copy (still accurate -- only its position in the flow
    // moved from primary to fallback).
    fallback: {
      toggleLabel: 'API 키로 연결하기',
      // Sirin red-team #5: verification itself is a real POST to the
      // provider's server, so "외부로 전송되지 않습니다" was a false claim.
      // This is the corrected/honest version.
      body: 'API 키가 있다면 직접 연결할 수 있습니다. 키는 macOS 키체인에만 저장됩니다. 입력한 제공사에 인증을 확인하는 것 외에는 어디로도 보내거나 수집하지 않습니다.',
      tabs: [
        { id: 'claude', hint: 'console.anthropic.com에서 발급. sk-ant-로 시작합니다.' },
        { id: 'chatgpt', hint: 'platform.openai.com에서 발급. sk-로 시작합니다.' },
        { id: 'ollama', hint: 'ollama.com 계정 설정에서 발급.' },
      ],
      validating: '키를 확인하는 중입니다',
      success: '연결됐습니다',
      failure: (reason) => `키가 거부됐습니다 (원인: ${reason}). 키를 다시 확인하거나 다른 제공사를 선택하세요.`,
    },
    // Shown beneath a tab whenever that tab is rendered disabled (UI-scope
    // decision, not directly the routerWired field -- see note above). Same
    // subtext for either disabled tab, per the source file's 폴백 B copy --
    // no date promise, no implying a choice was made.
    routerDisabledNote: '다음 업데이트에서 연결됩니다. 지금은 Claude로 시작할 수 있습니다.',
    button: '다음',
  },

  step2: {
    title: '에이전트의 이름을 지으세요',
    body: '이 이름으로 대화하게 됩니다. 나중에 설정에서 바꿀 수 있습니다.',
    defaultName: '세헤라자드',
    button: '다음',
  },

  step3: {
    title: '세 가지만 정합니다',
    q1Label: '말투',
    q1Options: [
      { value: 'casual', label: '반말' },
      { value: 'formal', label: '존댓말' },
    ],
    q2Label: '주로 시킬 일',
    q2Chips: ['코드 리뷰', '일정 관리', '리서치', '글 정리', '기타'],
    q3Label: '먼저 말 걸어도 됩니까',
    q3YesPrefix: '예,',
    q3YesSuffix: '사이에만',
    q3No: '아니요',
    // Flag-follows-copy (Idea copy spec, her lines 46-48): the note has an ON
    // and an OFF version, and it must track the proactive-feature flag so no
    // landing lies. That flag ships default OFF (proactive cycle is not wired
    // this build; only routerWired is in the API surface), so the OFF copy is
    // the truthful landing. Earlier build shipped the ON copy, which promised
    // proactive contact the build will not perform.
    q3Note: '지금은 동의만 저장됩니다. 먼저 연락하는 기능이 켜지면 이 설정을 그대로 따릅니다. 설정에서 언제든 바꿀 수 있습니다.',
    button: '다음',
  },

  step4: {
    title: '대화할 곳을 연결하세요',
    body: (name) => `${name}는 Discord에서 대화합니다. 봇을 하나 만들어 연결합니다. 5분 걸립니다.`,
    // Mino 07-13 click-test: three platform buttons, each a redirect.
    // Discord keeps the real flow (opens the dev portal AND enters the
    // existing tutorial -- redirect alone would kill the guided steps,
    // 2FA warning and Sirin's friction fixes included). Slack/Telegram
    // have NO backend yet (settings.js Slack placeholder is the only
    // trace), so their shared note says so -- otherwise the user makes
    // a token and finds no field to paste it into.
    connectDiscord: 'Connect Discord',
    connectDiscordNote: '봇 만들기 페이지가 열리고, 여기에 단계별 안내가 시작됩니다',
    connectSlack: 'Connect Slack',
    connectTelegram: 'Connect Telegram',
    supportSoonNote: '봇 만들기 페이지만 열립니다 — 연결은 지원 예정',
    links: {
      discord: 'https://discord.com/developers/applications',
      slack: 'https://api.slack.com/apps',
      telegram: 'https://t.me/botfather',
    },
    // De-lied (source file, Step 4 note): no local-chat fallback exists
    // (Mino rejected it 13:55; localhost is onboarding-only). This button
    // only saves settings and parks the user on the waiting screen.
    laterButton: '나중에 하기 — 설정만 저장하고 대기',
  },

  discordTutorial: {
    // Shown once, before step 1 of 6 (Sirin #2) -- not a numbered step
    // itself, so wizard.js renders it at tutorialIndex === -1.
    preWarning: 'Discord 계정에 2단계 인증(2FA)이 켜져 있으면 중간에 인증번호를 요구합니다. 인증 기기를 준비해 두세요.',
    steps: [
      { text: (name) => `discord.com/developers/applications 접속 → New Application → 이름 입력 (아무거나, 예: ${name})`, shot: true },
      { text: () => '왼쪽 Bot 탭 → Reset Token → 토큰 복사. 이 토큰은 비밀번호입니다. 다른 곳에 붙여넣지 마세요.', shot: true },
      {
        // Sirin #3: switching the toggle alone does not persist it.
        text: () =>
          '같은 화면에서 Privileged Gateway Intents 중 MESSAGE CONTENT INTENT 켜기 → 화면 하단에 나타나는 초록색 Save Changes 버튼을 눌러야 저장됩니다. 스위치만 켜고 나가면 저장되지 않습니다.',
        shot: true,
      },
      {
        // Mino 07-13 click-test: the bare oauth2/authorize link (no scope,
        // no permissions) doesn't install correctly, and the URL Generator
        // dance was the most error-prone part of the old tutorial (Sirin #1
        // was a symptom of it). The invite URL is now minted in-app from the
        // pasted token -- client_id derives from the token itself, and the
        // permissions (View Channel, Send Messages, Read Message History,
        // Add Reactions, Attach Files, Embed Links) ride along in the URL.
        text: () =>
          '복사한 토큰을 아래 칸에 붙여넣으면 초대 링크가 만들어집니다 → 초대 링크 열기 → 봇을 넣을 서버 선택 (서버가 없으면: Discord 앱에서 + 버튼으로 개인 서버를 하나 만드세요) → 연결 확인',
        shot: false,
      },
    ],
    tokenFieldLabel: '봇 토큰',
    inviteButton: '초대 링크 열기',
    inviteHint: '권한이 미리 담긴 초대 링크입니다',
    validateButton: '연결 확인',
    validating: '연결을 확인하는 중입니다',
    success: (name) => `${name}가 서버에 들어왔습니다. Discord에서 확인하세요.`,
    failures: {
      invalid_token: '토큰이 거부됐습니다. 2번 단계에서 Reset Token 후 새 토큰을 복사했는지 확인하세요.',
      intent_off: '메시지를 읽을 수 없는 상태입니다. 3번 단계의 MESSAGE CONTENT INTENT가 켜져 있는지 확인하세요.',
      not_invited: '봇이 아직 어느 서버에도 없습니다. 4번 단계의 초대 링크를 다시 여세요.',
    },
    prevButton: '이전',
    nextButton: '다음',
  },

  // ── Step 5: 3-state handoff (connecting / live / failed) ────────────
  // Gated on the real liveness signal (channel.mjs's ClientReady marker),
  // not on ONBOARDING_COMPLETE -- see wizard.js's pollAgentStatus(). The
  // "failed" cause table is sourced verbatim from the source file's §상태3
  // code→copy table; the server only ever sends a stable `code` enum (never
  // a free-form reason string to render directly -- Melchior 2026-07-03:
  // that class of bug leaks English debug prose into the user-facing UI).
  step5: {
    connecting: {
      title: '연결 중',
      body: (name) => `${name}를 시작하고 있습니다. Discord 연결이 확인되면 이 화면이 바뀝니다.`,
      button: 'Discord 열기',
    },
    // channelName (2026-07-04 06:35, Melchior raw-verified http-server.cjs:940
    // -- validateAndInvite's return already carried channelId/guildId, this
    // adds homeChannel.name, a real field on the Discord API channel object,
    // no extra fetch). DM positive-exposure (source file §상태2 정정,
    // 2026-07-04 06:2x): DM is a v1-mandatory, already-shipped path (Mino
    // 01:24 directive, Melchior 02:23 12/12 tests) -- staying silent about a
    // working required feature is its own copy/implementation gap, same
    // class as promising something that doesn't work, just inverted. Home
    // channel stays the headline (that's where the onboarding funnel points
    // and where the 첫 발화 스펙 is written for); DM is a short second line,
    // not equal billing.
    live: {
      title: '끝났습니다',
      body: (name, channelName) => `${name}가 Discord의 #${channelName}에서 기다립니다. DM도 받습니다. 첫 인사는 방금 입력한 설정을 이미 반영하고 있습니다.`,
      // Deep link via POST /api/discord/open { guildId, channelId } --
      // http-server.cjs:1234-1244, confirmed live (source file's own
      // http-server.cjs:1011 citation was stale, code moved).
      button: (channelName) => `#${channelName} 열기`,
    },
    failed: {
      title: '시작하지 못했습니다',
      causes: {
        // action text (2026-07-04 06:5x, Melchior's wizard.js gate caught
        // this): settings.js is rename+Slack-placeholder only -- no real
        // key/model repair UI exists (http-server.cjs:1208 says so in its
        // own comment: "no re-onboarding/provider-switch UI today"). The
        // old action text promised a fix settings can't perform, and this
        // cause is actually reachable now (a junk setup-token passes Step 1
        // and crash-loops at spawn). Real settings repair UI = v1.1 flag
        // (Melchior's call, separate from this copy fix). Button left as-is
        // -- opening settings is harmless, just not sufficient, and the v1.1
        // repair UI will land on the same button without another copy pass.
        crash_loop: {
          cause: (name) => `${name} 프로세스가 반복해서 종료되고 있습니다. 정확한 원인은 확인되지 않았습니다.`,
          action: () => '앱을 종료했다가 다시 실행해주세요. 반복되면 처음 입력한 값이 정확한지 다시 확인해주세요.',
          buttons: ['openSettings', 'openLogs'],
        },
        discord_token_bad: {
          cause: () => 'Discord 봇 토큰이 없거나 거부됐습니다.',
          action: () => '토큰 단계로 돌아가 새 토큰을 붙여넣어주세요.',
          buttons: ['backToToken', 'openLogs'],
        },
        provider_not_wired: {
          cause: () => '선택한 모델 연결이 아직 준비되지 않았습니다.',
          action: () => '설정에서 모델을 Claude로 변경한 뒤, 앱을 종료했다가 다시 실행해주세요.',
          buttons: ['openSettings', 'openLogs'],
        },
        // action text: same fix as crash_loop above, same reason (no real
        // settings repair UI to send the user to).
        key_error: {
          cause: () => '저장된 키를 읽지 못했습니다.',
          action: () => '앱을 종료했다가 다시 실행해주세요. 반복되면 처음 입력한 값이 정확한지 다시 확인해주세요.',
          buttons: ['openSettings', 'openLogs'],
        },
        timeout: {
          cause: (name) => `${name}가 시작됐는지 확인되지 않습니다.`,
          action: () => '잠시 후 상태 다시 확인을 눌러주세요.',
          buttons: ['retry', 'openLogs'],
        },
        // Fallback row -- any code not in this table (including a literal
        // "unknown") lands here.
        unknown: {
          cause: (name) => `${name}를 시작하지 못했습니다.`,
          action: () => '잠시 후 상태 다시 확인을 누르고, 반복되면 앱을 종료했다가 다시 실행해주세요.',
          buttons: ['retry', 'openLogs'],
        },
      },
    },
    // Button label text, keyed by button "kind" (wizard.js maps kind ->
    // label + onClick). Labels sourced from the 버튼 column of the §상태3
    // table; wiring behind each is documented in wizard.js at the point of
    // use (openLogs and retry have no backend endpoint yet -- see there).
    buttonLabels: {
      openSettings: '설정 열기',
      openLogs: '로그 열기',
      backToToken: '토큰 단계로 돌아가기',
      retry: '상태 다시 확인',
    },
  },

  memoryPane: {
    title: '기억',
    subtitle: (name) => `${name}가 당신에 대해 갖고 있는 것 전부입니다. 여기 없는 것은 기억하지 않습니다.`,
    sessionGroupTitle: '이번 세션에서 기억한 것',
    categories: {
      user_facts: { label: '당신에 대해', empty: '아직 없습니다. 대화하면서 쌓입니다.' },
      open_threads: { label: '하다 만 일', empty: '지금은 없습니다. 끝내지 못한 일이 생기면 여기 남습니다.' },
      corrections: {
        label: '고쳐진 것',
        empty: (name) => `아직 없습니다. ${name}를 고쳐주면 여기 기록되고, 같은 실수를 반복하지 않는 근거가 됩니다.`,
      },
      preferences: { label: '일하는 방식', empty: '설정에서 조정할 수 있습니다.' },
    },
    // Tri-state status label for open_threads, verbatim from the copy row
    // format spec "상태(진행 중/완료/오래됨)". Derivation rule (status +
    // staleness -> label) is this build's own inference -- see memory.js.
    threadStatus: { active: '진행 중', done: '완료', stale: '오래됨' },
    // Preference key/value labels: these keys are this build's own
    // invention (Step 3 writes them), so their Korean labels are authored
    // here, not sourced from the copy file.
    prefKeyLabels: {
      tone: '말투',
      primary_task: '주로 시킬 일',
      proactive_enabled: '먼저 말 걸기',
      proactive_window: '먼저 말 거는 시간대',
    },
    prefValueLabels: {
      casual: '반말',
      formal: '존댓말',
      true: '켜짐',
      false: '꺼짐',
    },
    eventLabels: { insert: '추가됨', update: '수정됨', confirm: '확인됨', delete: '삭제됨' },
    deleteDialog: (name) => `삭제하면 복구할 수 없습니다. ${name}는 이 내용을 더 이상 기억하지 않습니다. 삭제했다는 기록만 남습니다.`,
    deleteConfirm: '삭제',
    deleteCancel: '취소',
    deleteToast: '삭제됐습니다.',
    deleteLabel: '삭제',
    // AUTHORED (not in copy file) -- manual refresh, Mino 07-13 click-test:
    // "기억페이지 리프레시 버튼이라도 있으면 좋겠어"
    refreshLabel: '새로고침',
    refreshToast: '다시 불러왔습니다.',
  },

  // AUTHORED (not in copy file) -- shared shell (nav.js), subpage split
  // 2026-07-14 per docs/ia-subpage-plan.md. tabs{} is genuinely new UI (the
  // 3-way split didn't exist before); everything else here is MOVED verbatim
  // from memory.js's inline AGENT_COPY const (Slice 2, 2026-07-09) -- still
  // eng placeholder pending Mino's copy-track localization pass, unchanged
  // by the move itself.
  nav: {
    tabs: { memory: '기억', connectors: '커넥터', settings: '설정' },
    label: 'AGENT',
    states: { live: 'Running', connecting: 'Starting…', stopped: 'Stopped', failed: 'Failed', idle: 'Not started' },
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    openDiscord: 'Open Discord',
    stopConfirm: 'Stop the agent?',
    stopOk: 'Stop',
    cancel: 'Cancel',
    switchOk: 'Switch',
    muteWarn: (n, m) => `${m} was asked to reply ${n}× and didn't. The agent may be unable to send messages.`,
    muteRevert: (m) => `Go back to ${m}`,
    muteRevertConfirm: (m) => `Switch back to ${m}? The agent will restart.`,
  },

  // AUTHORED (not in copy file) -- settings page, minimal v1.
  settings: {
    title: '설정',
    backToMemory: '기억으로',
    renameLabel: '이름',
    renameButton: '저장',
    renameSaved: '저장됐습니다.',
    // Moved verbatim from memory.js's inline AGENT_COPY (Slice 2,
    // 2026-07-09) -- the SELECT-driven half (model/effort config). The
    // read-only status-display half of that same const moved to `nav` above.
    // agentConfigLabel is AUTHORED (not in copy file): the original AGENT_COPY
    // had one 'AGENT' label covering the whole panel (status+buttons+selects
    // together); now that the selects are their own section, they get their
    // own wrapper label distinct from nav.label.
    agentConfigLabel: 'Model & Effort',
    modelLabel: 'Model',
    effortLabel: 'Effort',
    switchConfirm: (m) => `Switch model to ${m}? The agent will restart.`,
    effortConfirm: (e) => `Switch effort to ${e}? The agent will restart.`,
    switchOk: 'Switch',
    cancel: 'Cancel',

    // AUTHORED -- autonomous cycle (v0.0.6).
    //
    // The copy rules for this block are stricter than the rest of the page,
    // because this is the one setting that spends the user's money while they
    // are asleep:
    //   1. The cost is stated before the benefit. Not in a footnote.
    //   2. It ships OFF. The user turns it on; nothing turns it on for them.
    //   3. The number shown is the number the cap is enforced against --
    //      cache reads included, no friendlier second number.
    //   4. When the meter cannot measure, we say so. A blank reads as zero,
    //      and "nothing was spent" is not the same sentence as "I cannot tell
    //      you what was spent."
    autonomyLabel: '혼자 일하기',
    autonomyNote:
      '주무시는 동안 에이전트가 스스로 일을 고르고 진행합니다. ' +
      '이 작업은 회원님의 Claude 구독 사용량을 소모하며, 그동안 아무도 보고 있지 않습니다. ' +
      '기본값은 꺼짐이고, 켜신 뒤에도 아래 상한을 넘으면 스스로 멈춥니다.',
    autonomyEnableLabel: '혼자 일하도록 허용',
    autonomyWindowLabel: '작업 시간대',
    autonomyWindowNote: '이 시간대에만 시작합니다. 자정을 넘겨도 됩니다 (예: 23:00 - 05:00)',
    // "하룻밤" and not "하루": the cap is enforced per CYCLE, from the moment the
    // window opens until it closes. A 23:00-05:00 night is one night, and
    // measuring it per calendar day handed it a second budget at midnight.
    autonomyCapLabel: '하룻밤 토큰 상한',
    autonomyCapNote:
      '한 번의 밤 동안 쓸 수 있는 최대 토큰입니다 (캐시 재사용 포함). 넘으면 스스로 멈추고, 아침 브리프에 같은 숫자가 나옵니다. ' +
      '0으로 두면 혼자 일하지 않습니다 (무제한은 없습니다).',
    // Deliberately a DIFFERENT label from the cap: this is everything spent
    // today including your own conversations, and it is not what the cap is
    // measured against. One label over two measurements is how a number starts
    // lying.
    autonomyUsageLabel: '오늘 전체 사용량 (대화 포함)',
    autonomyTokensWord: '토큰',
    autonomyUsageBlind:
      '지금은 사용량을 측정할 수 없습니다. 측정하지 못하는 동안에는 혼자 일하지 않습니다.',
    autonomyLastCycle: '지난밤',
    autonomyLastCycleNone: '아직 혼자 일한 밤이 없습니다',
    autonomyLastCycleStopped: '상한에 걸려 중간에 멈췄습니다',
    autonomyLastCycleBriefed: '아침 브리프를 보냈습니다',
    autonomyLastCycleRan: '작업했습니다',
    autonomySkipCap: '상한에 이미 도달해 있어서 시작하지 않았습니다',
    autonomySkipMeter: '사용량을 측정할 수 없어서 시작하지 않았습니다',
    autonomySave: '저장',
    autonomySaved: '저장됐습니다',
    autonomyInvalidWindow: '시간 형식이 올바르지 않습니다 (예: 02:00)',
    autonomyInvalidCap: '숫자를 입력해주세요',
  },

  // AUTHORED (not in copy file) -- connectors page, new in the 2026-07-14
  // subpage split (docs/ia-subpage-plan.md). `title`/`backToMemory` are new;
  // everything else below is MOVED verbatim from `settings` (provider auth +
  // Slack banner lived there before the split -- unchanged strings, just
  // relocated), except `providersNote`, corrected in place: it used to say
  // "기억 페이지의 모델 선택" (model select lived on /memory back then); model
  // select now lives on /settings, so the pointer is updated to match --
  // otherwise this move would ship a note that sends the user to the wrong
  // page for something this same refactor moved. Register unchanged: 간결
  // 존댓말, no 이모지, no 느낌표, no cheerleading.
  connectors: {
    title: '커넥터',
    backToMemory: '기억으로',
    slackLabel: 'Slack',
    slackNote: '나중에 지원 예정',
    // AUTHORED -- post-onboarding provider auth (Mino 07-13 click-test:
    // "온보딩 끝낸 이후에 ollama cloud 인증 추가 / chatGPT인증 추가").
    providersLabel: '추가 인증',
    providersNote: '인증하면 설정 페이지의 모델 선택에서 해당 모델을 고를 수 있습니다',
    providerNames: { chatgpt: 'ChatGPT (Codex)', ollama: 'Ollama Cloud' },
    providerConnected: '연결됨',
    providerNotConnected: '미연결',
    providerAuthButton: '인증하기',
    providerAuthRunning: '로그인 창이 열렸습니다. 브라우저에서 로그인을 끝내면 여기가 바뀝니다',
    providerAuthSuccess: '연결됐습니다',
    providerAuthFailures: {
      cli_missing: {
        chatgpt: 'codex CLI가 없습니다. https://github.com/openai/codex 에서 설치 후 다시 시도해주세요',
        ollama: 'Ollama 앱이 설치되어 있지 않습니다. https://ollama.com 에서 설치 후 다시 시도해주세요',
      },
      cancelled: '인증이 취소됐습니다',
      timeout: '인증이 제한 시간을 넘겼습니다. 다시 시도해주세요',
      exit_nonzero: '인증이 실패했습니다. 다시 시도해주세요',
      unknown: '인증이 실패했습니다. 다시 시도해주세요',
    },
  },

  // Sourced from the source file's Step 4 폴백 note: "waiting.html 카피
  // (폴백 착지 화면)". Not a chat body (Mino rejected web-chat) -- status +
  // a single CTA back into the Discord tutorial only.
  waiting: {
    title: '설정이 저장됐습니다',
    banner: (name) => `${name}는 Discord 연결을 기다리고 있습니다. 연결하면 바로 대화가 시작됩니다.`,
    resumeButton: '튜토리얼 다시 열기',
  },

  // AUTHORED (not in copy file) -- generic infra-failure banner for
  // unexpected server errors (network down, disk write failure, etc), kept
  // separate from the scripted BYOK/Discord failure copy above.
  genericError: (message) => `오류가 발생했습니다: ${message}`,
}
