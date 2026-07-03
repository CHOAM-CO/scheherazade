// copy.js — single source of truth for every user-facing string in the
// onboarding wizard + memory pane. Sourced VERBATIM from:
//   ~/Documents/MAGI_Memory/projects/scheherazade_onboarding_copy_v0_2026-07-03.md
//   ~/Documents/MAGI_Memory/projects/scheherazade_pane_copy_opener_criteria_2026-07-03.md §A
// Register: 간결 존댓말, no 이모지, no 느낌표, no cheerleading.
//
// Strings marked "AUTHORED (not in copy file)" below are new UI surfaces the
// copy files did not specify (settings page, waiting-room fallback, generic
// infra-error banner). Written in the same register, flagged here so they
// are easy to find and replace if Idea/PO writes real copy for them later.

window.COPY = {
  step0: {
    title: '설정을 시작합니다',
    body: '3분이면 끝납니다. 모든 정보는 이 컴퓨터에만 저장됩니다.',
    button: '시작',
  },

  step1: {
    title: '사용할 모델을 연결하세요',
    body: '아래 중 하나의 API 키가 필요합니다. 키는 macOS 키체인에 저장되며 외부로 전송되지 않습니다.',
    tabs: [
      { id: 'claude', label: 'Claude', hint: 'console.anthropic.com에서 발급. sk-ant-로 시작합니다.' },
      { id: 'chatgpt', label: 'ChatGPT', hint: 'platform.openai.com에서 발급. sk-로 시작합니다.' },
      { id: 'ollama', label: 'Ollama Cloud', hint: 'ollama.com 계정 설정에서 발급.' },
    ],
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
    q3Note: '허락한 시간대에만 먼저 연락합니다. 언제든 끌 수 있습니다.',
    button: '다음',
  },

  step4: {
    title: '대화할 곳을 연결하세요',
    body: (name) => `${name}는 Discord에서 대화합니다. 봇을 하나 만들어 연결합니다. 5분 걸립니다.`,
    startButton: '튜토리얼 시작',
    laterButton: '나중에 하기 — 지금은 로컬 창에서 대화',
  },

  discordTutorial: {
    steps: [
      { text: (name) => `discord.com/developers/applications 접속 → New Application → 이름 입력 (아무거나, 예: ${name})`, shot: true },
      { text: () => '왼쪽 Bot 탭 → Reset Token → 토큰 복사. 이 토큰은 비밀번호입니다. 다른 곳에 붙여넣지 마세요.', shot: true },
      { text: () => '같은 화면에서 Privileged Gateway Intents 중 MESSAGE CONTENT INTENT 켜기 → Save', shot: true },
      { text: () => 'OAuth2 탭 → URL Generator → Scopes에서 bot 체크 → Bot Permissions에서 Send Messages, Read Message History 체크', shot: true },
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

  step5: {
    title: '끝났습니다',
    body: (name) => `${name}가 Discord에서 기다립니다. 첫 인사는 방금 입력한 설정을 이미 반영하고 있습니다.`,
    button: 'Discord 열기',
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

  // AUTHORED (not in copy file) -- Step 4 "나중에 하기" fallback. Explicitly
  // NOT a chat body (Mino rejected web-chat) -- status + a single CTA back
  // into the Discord tutorial only.
  waiting: {
    title: '설정이 아직 끝나지 않았습니다',
    banner: (name) => `${name}는 아직 Discord에 연결되지 않았습니다. 연결 전까지는 여기서 기다립니다.`,
    resumeButton: 'Discord 연결하기',
  },

  // AUTHORED (not in copy file) -- generic infra-failure banner for
  // unexpected server errors (network down, disk write failure, etc), kept
  // separate from the scripted BYOK/Discord failure copy above.
  genericError: (message) => `오류가 발생했습니다: ${message}`,
}
