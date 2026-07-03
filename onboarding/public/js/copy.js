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
    body: '3분이면 끝납니다. 모든 정보는 이 컴퓨터에만 저장됩니다.',
    button: '시작',
  },

  step1: {
    title: '사용할 모델을 연결하세요',
    // Sirin red-team #5: verification itself is a real POST to the
    // provider's server, so "외부로 전송되지 않습니다" was a false claim.
    // This is the corrected/honest version.
    body: '아래 중 하나의 API 키가 필요합니다. 키는 macOS 키체인에만 저장됩니다. 입력한 제공사에 인증을 확인하는 것 외에는 어디로도 보내거나 수집하지 않습니다.',
    tabs: [
      { id: 'claude', label: 'Claude', hint: 'console.anthropic.com에서 발급. sk-ant-로 시작합니다.' },
      {
        id: 'chatgpt',
        label: 'ChatGPT',
        disabledLabel: 'ChatGPT (곧 지원)',
        hint: 'platform.openai.com에서 발급. sk-로 시작합니다.',
      },
      {
        id: 'ollama',
        label: 'Ollama Cloud',
        disabledLabel: 'Ollama Cloud (곧 지원)',
        hint: 'ollama.com 계정 설정에서 발급.',
      },
    ],
    // Shown once beneath the tab row whenever routerWired is false (GET
    // /api/config). Same subtext for either disabled tab, per the source
    // file's 폴백 B copy -- no date promise, no implying a choice was made.
    routerDisabledNote: '다음 업데이트에서 연결됩니다. 지금은 Claude로 시작할 수 있습니다.',
    validating: '키를 확인하는 중입니다',
    success: '연결됐습니다',
    failure: (reason) => `키가 거부됐습니다 (원인: ${reason}). 키를 다시 확인하거나 다른 제공사를 선택하세요.`,
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
    // ON version (proactive 사이클 검증 완료 시 착지). The source file also
    // specifies an OFF version ("지금은 동의만 저장됩니다...") gated on a
    // server-side proactive-feature flag -- that flag isn't part of this
    // build's API surface (only routerWired is), so this build ships the ON
    // version unchanged. Flagged, not silently resolved.
    q3Note: '허락한 시간대에만 먼저 연락합니다. 언제든 끌 수 있습니다.',
    button: '다음',
  },

  step4: {
    title: '대화할 곳을 연결하세요',
    body: (name) => `${name}는 Discord에서 대화합니다. 봇을 하나 만들어 연결합니다. 5분 걸립니다.`,
    startButton: '튜토리얼 시작',
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
        // Sirin #1: View Channel is required or the bot can't see the
        // channel to post in at all.
        text: () =>
          'OAuth2 탭 → URL Generator → Scopes에서 bot 체크 → Bot Permissions에서 View Channel, Send Messages, Read Message History 체크',
        shot: true,
      },
      {
        text: () => '아래 생성된 URL 복사 → 브라우저에 붙여넣기 → 봇을 넣을 서버 선택 (서버가 없으면: Discord 앱에서 + 버튼으로 개인 서버를 하나 만드세요)',
        shot: true,
      },
      { text: () => '복사한 토큰을 아래 칸에 붙여넣기 → 연결 확인', shot: false },
    ],
    tokenFieldLabel: '봇 토큰',
    validateButton: '연결 확인',
    validating: '연결을 확인하는 중입니다',
    success: (name) => `${name}가 서버에 들어왔습니다. Discord에서 확인하세요.`,
    failures: {
      invalid_token: '토큰이 거부됐습니다. 2번 단계에서 Reset Token 후 새 토큰을 복사했는지 확인하세요.',
      intent_off: '메시지를 읽을 수 없는 상태입니다. 3번 단계의 MESSAGE CONTENT INTENT가 켜져 있는지 확인하세요.',
      not_invited: '봇이 아직 어느 서버에도 없습니다. 5번 단계의 초대 URL을 다시 여세요.',
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
    live: {
      title: '끝났습니다',
      body: (name) => `${name}가 Discord에서 기다립니다. 첫 인사는 방금 입력한 설정을 이미 반영하고 있습니다.`,
      button: 'Discord 열기',
    },
    failed: {
      title: '시작하지 못했습니다',
      causes: {
        crash_loop: {
          cause: (name) => `${name} 프로세스가 반복해서 종료되고 있습니다. 정확한 원인은 확인되지 않았습니다.`,
          action: () => '설정에서 모델 키와 인증 정보를 확인해주세요. 반복되면 로그를 보내주세요.',
          buttons: ['openSettings', 'openLogs'],
        },
        discord_token_bad: {
          cause: () => 'Discord 봇 토큰이 없거나 거부됐습니다.',
          action: () => '토큰 단계로 돌아가 새 토큰을 붙여넣어주세요.',
          buttons: ['backToToken', 'openLogs'],
        },
        provider_not_wired: {
          cause: () => '선택한 모델 연결이 아직 준비되지 않았습니다.',
          action: () => '설정에서 모델을 Claude로 변경해주세요.',
          buttons: ['openSettings', 'openLogs'],
        },
        key_error: {
          cause: () => '저장된 키를 읽지 못했습니다.',
          action: () => '다시 시도해주세요. 반복되면 설정에서 키를 다시 입력해주세요.',
          buttons: ['retry', 'openLogs'],
        },
        timeout: {
          cause: (name) => `${name}가 시작됐는지 확인되지 않습니다.`,
          action: () => '다시 시도를 누르고, 반복되면 로그를 보내주세요.',
          buttons: ['retry', 'openLogs'],
        },
        // Fallback row -- any code not in this table (including a literal
        // "unknown") lands here.
        unknown: {
          cause: (name) => `${name}를 시작하지 못했습니다.`,
          action: () => '다시 시도를 누르고, 반복되면 로그를 보내주세요.',
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
      retry: '다시 시도',
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
  },

  // AUTHORED (not in copy file) -- settings page, minimal v1.
  settings: {
    title: '설정',
    backToMemory: '기억으로',
    renameLabel: '이름',
    renameButton: '저장',
    renameSaved: '저장됐습니다.',
    slackLabel: 'Slack',
    slackNote: '나중에 지원 예정',
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
