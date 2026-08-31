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

// Host platform, injected by serveStatic beside the token (same reason: the
// renderer has no process.platform). Every macOS-specific word and every
// macOS-only surface below branches on this. Defaults to darwin when the meta
// is missing so a stale cached page keeps the shape it has always had.
window.HOST_PLATFORM = (function () {
  const meta = document.querySelector('meta[name="host-platform"]')
  return (meta && meta.getAttribute('content')) || 'darwin'
})()
window.IS_WIN = window.HOST_PLATFORM === 'win32'
window.IS_MAC = window.HOST_PLATFORM === 'darwin'

// The two words that appear all over this file. THIS_MACHINE replaces the
// literal "this Mac" -- deliberately not "this PC", because the same string
// ships to Linux dev runs too. SHELL_APP is what the user opens to type a
// command: Terminal on mac, PowerShell on Windows.
const THIS_MACHINE = window.IS_MAC ? 'this Mac' : 'this computer'
const SHELL_APP = window.IS_WIN ? 'PowerShell' : 'Terminal'
// Where safeStorage actually puts things: Keychain on mac, DPAPI on Windows.
// Naming the real store matters -- a user who goes looking for "the keychain"
// on Windows finds nothing and concludes we lied about where their token is.
const CRED_STORE = window.IS_MAC ? "this Mac's keychain" : "this computer's encrypted credential store"
const CRED_STORE_THE = window.IS_MAC ? 'the macOS keychain' : "the OS's encrypted credential store"

window.COPY = {
  step0: {
    title: 'Start setup',
    // Full-autonomy disclosure (Mino 2026-07-04 16:26 "에이전트한테 권한 다
    // 주기" + 2026-07-05 02:12 "권한 최대한 열어주기, 반박 안받음"): the old
    // macOS-protected-folders sentence was REMOVED on Mino's direct order --
    // onboarding now requests Documents/Downloads/Desktop TCC grants, so
    // that sentence would be false. The folder line below states the new
    // reality honestly. FDA: no longer deferred -- requested at setup via
    // the Step-0 card below (Mino 2026-07-07 16:58 "full disk access도
    // 온보딩중에 그냥 설정창 켜버리고 받아버리셈"). Source doc §Step 0
    // updated in the same pass -- keep verbatim-synced.
    body: 'Takes about 3 minutes. Everything stays on this computer. Once set up, the agent works on its own without asking permission every time. It reads and writes directly to your Documents, Downloads, and Desktop folders.',
    button: 'Start',
    // AUTHORED (not in copy source file) -- Full Disk Access card
    // (2026-07-07, Mino directive above). Honest about the two macOS
    // constraints: the toggle itself must be clicked by the user (no
    // programmatic grant exists), and the grant needs an app restart
    // (TCC caches at process launch).
    fda: {
      title: 'Full Disk Access',
      bodyMissing: 'The agent needs Full Disk Access to work with files on your Mac. This button opens System Settings. Turn on Scheherazade in the list.',
      bodyGrantedPendingRestart: 'Looks like the permission is on. Restart the app to apply it.',
      bodyGranted: 'Full Disk Access is on.',
      openButton: 'Open Settings',
      relaunchButton: 'Restart App',
      skipHint: 'You can turn this on later in Settings.',
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
    title: 'Connect a model',
    body: `Log in with the account you already use. Your subscription plan applies as-is, and login info stays on ${THIS_MACHINE}.`,
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
      title: 'This Mac already has a Claude Code login',
      body: "You can use that login as-is. We don't copy it, store it separately, or open its contents (we only checked that it exists). No key to paste.",
      cost: 'Usage is deducted from your Claude subscription.',
      use: 'Use this login',
      alt: 'To use a different account, connect one directly below.',
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
      staleHint: `If this login has expired, the agent won't start. Run claude in ${SHELL_APP} once to log in again, then retry.`,
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
          validating: 'Checking the token…',
          failure: (reason) => `Token rejected (reason: ${reason}). Run the command again and paste a new token.`,
          precondition: 'Requires a Claude Pro or Max subscription and the claude command installed.',
          steps: [
            `Run claude setup-token in ${SHELL_APP}`,
            'Log in with your Claude account in the browser',
            `Paste the token shown in ${SHELL_APP} into the field below`,
          ],
          copyCommand: 'claude setup-token',
          subtext: `No API key needed. Your subscription applies as-is, and the token is stored only in ${CRED_STORE}.`,
          button: 'Verify connection',
          // In-app capture: the app runs `claude setup-token` itself and
          // reads the token out of that process, so the credential never
          // reaches the clipboard. The steps/copyCommand above stay as the
          // manual fallback for machines where the spawn or the loopback
          // redirect does not work -- this replaces nothing, it just becomes
          // the default path.
          //
          // HONESTY CONSTRAINTS, same principle as the Ollama note below:
          // a browser DOES open, so do not imply otherwise; and the code box
          // may or may not be needed, because the CLI races a localhost
          // callback against its own paste prompt (verified in the 2.1.220
          // binary: waitForAuthorizationCode resolves from whichever lands
          // first). Copy must not promise one-click and must not present the
          // code box as a required step.
          inApp: {
            button: 'Log in with Claude',
            lead: 'A browser window opens for you to log in. When it finishes, the app picks the token up on its own -- you should not have to copy anything.',
            starting: 'Starting the login…',
            waiting: 'Waiting for the browser login to finish…',
            // Shown only if the localhost hand-back does not land.
            codePrompt: "If the browser showed you a code instead of returning here, paste it below.",
            codeButton: 'Submit code',
            codeInvalid: "That doesn't look like an authorization code. Copy the whole value from the browser.",
            validating: 'Checking the token…',
            success: 'Connected. Your Claude subscription is set up.',
            cancel: 'Cancel',
            manualToggle: `Do it manually in ${SHELL_APP} instead`,
            // Reason codes come from setup-token-session.cjs and are a fixed
            // enum -- never child output, so they are safe to switch on. The
            // default exists because a new reason must degrade to something
            // truthful rather than to an empty status line.
            failure: (reason) => ({
              cli_missing: `The claude command was not found on ${THIS_MACHINE}. Install it, then try again.`,
              spawn_failed: 'The login could not be started. Try the manual steps below.',
              timeout: 'The login was not finished in time. Try again.',
              // Capture-failure family. These five differ only in how the
              // read went wrong, and the user's remedy is identical for all
              // of them, so they deliberately SHARE one sentence -- but they
              // are mapped explicitly rather than left to the default. That
              // keeps the default reserved for a reason nobody has written
              // copy for yet, which is what the copy-coverage test watches.
              no_token_in_output: 'The login ended without producing a token. Try again, or use the manual steps below.',
              no_output: 'The login ended without producing a token. Try again, or use the manual steps below.',
              token_too_short: 'The login ended without producing a token. Try again, or use the manual steps below.',
              token_too_long: 'The login ended without producing a token. Try again, or use the manual steps below.',
              token_malformed: 'The login ended without producing a token. Try again, or use the manual steps below.',
              token_rejected: 'The token was captured but Anthropic rejected it. Try again.',
              // Distinct from the family above on purpose: a token WAS
              // printed here, we just could not read it unambiguously and
              // refused rather than store something possibly truncated or
              // possibly corrupted. Saying "ended without producing a token"
              // would be false.
              ambiguous_wrap: 'The token could not be read cleanly from the login output. Try again, or use the manual steps below.',
              store_failed: `The token could not be saved to ${CRED_STORE_THE}. Try again.`,
              user_cancelled: 'Login cancelled.',
            }[reason] || 'The login did not complete. Try again, or use the manual steps below.'),
          },
        },
      },
      {
        id: 'chatgpt',
        label: 'ChatGPT',
        disabledLabel: 'ChatGPT (coming soon)',
        primary: {
          button: 'Connect to local Codex',
          precondition: 'Requires Codex installed and codex login (browser auth with your ChatGPT account).',
          subtext: `Codex on ${THIS_MACHINE} handles account auth. No key is stored in the app.`,
        },
      },
      {
        id: 'ollama',
        label: 'Ollama Cloud',
        disabledLabel: 'Ollama Cloud (coming soon)',
        primary: {
          button: 'Connect to local Ollama (cloud model)',
          precondition: 'Requires the Ollama app installed and ollama signin completed.',
          subtext: `Ollama on ${THIS_MACHINE} handles account sign-in. No key is stored in the app.`,
          // Honesty note (source file): Path A is friction-moved, not
          // friction-removed (install+signin happen outside the app) --
          // copy must not imply one-click. In-app signin (Path B) = v1.1.
          failures: {
            not_running: "Ollama isn't running. Open the Ollama app and try again.",
            not_signed_in: `Not signed in to Ollama. Run ollama signin in ${SHELL_APP}, then try again.`,
          },
        },
      },
    ],
    loginWaiting: 'This screen updates once you finish logging in in the browser.',
    loginSuccess: (plan) => `Connected. Running on the ${plan} plan.`,
    loginFailure: "Login didn't complete. Try again, or connect with an API key below.",
    // AUTHORED (not in copy source file) -- in-app login shell-out UI
    // strings (Path B, 2026-07-07): the app now runs `codex login` /
    // `ollama signin` itself, so these tabs show a login button instead of
    // a key field. The precondition strings above describe the old Path-A
    // (Terminal pre-run) flow and are superseded inside the login area;
    // kept untouched for a future copy pass to reconcile. Flagged per the
    // COPY_BUTTON_LABEL precedent (wizard.js).
    login: {
      chatgpt: {
        button: 'Log in with ChatGPT',
        lead: 'This opens ChatGPT login in your browser. No key to paste.',
      },
      ollama: {
        button: 'Log in with Ollama',
        lead: 'This starts Ollama account login. No key to paste.',
        modelLabel: 'Cloud model to use',
        modelPlaceholder: 'Enter a model name',
        modelHint: 'Copy a name from the model list on ollama.com.',
        modelMissingProceed: 'Fix the name, or press Next again to continue anyway (if you plan to pull it later).',
      },
      successNoPlan: `Connected. Login info stays on ${THIS_MACHINE}.`,
      starting: 'Starting login…',
      cancelled: 'Login cancelled. You can try again.',
      timeout: 'Login timed out. Try again.',
      reloginLabel: 'Log in with a different account',
      // Lazy dependency install (2026-07-07): shown INSTEAD of the login
      // button when the provider's CLI is not on this Mac yet -- the app
      // downloads and verifies it itself (Apple 서명 확인), no Terminal,
      // no admin password.
      install: {
        needed: (name) => `${name} isn't installed on ${THIS_MACHINE} yet. It can be installed automatically.`,
        button: 'Install automatically',
        downloading: (pct) => (pct == null ? 'Downloading…' : `Downloading… (${pct}%)`),
        installing: 'Installing and verifying…',
        done: 'Installed. You can log in now.',
        failed: 'Install failed. Check your network and try again.',
        retryButton: 'Retry',
        // Windows v1 = detection-only (managed install is mac-only): the
        // wizard shows link + re-detect instead of the download button.
        manualNeeded: (name) => `${name} isn't installed on this PC yet. On Windows, install it from the official install page, then check again.`,
        manualOpenButton: 'Open install page',
        manualOpened: 'Opened the install page in your browser. Click "Check again" once install finishes.',
        redetectButton: 'Check again',
        stillMissing: (name) => `${name} still not found. Finish installing, then check again.`,
      },
    },
    // AUTHORED -- Claude CLI preflight (2026-08-04, Mino "2로 가자"): the
    // truly-clean-machine panel. Honesty requirements baked into the copy:
    // the app does NOT bundle claude (license), the install agreement is
    // with Anthropic, and Claude Code needs a PAID plan -- said BEFORE the
    // user invests in the flow, not after a failed spawn.
    cliPreflight: {
      title: 'Claude Code is not on this Mac yet',
      body: 'Scheherazade runs on top of your own Claude Code — it does not ship one. Install it with the button below (runs Anthropic’s official installer; the agreement is between you and Anthropic).',
      plan: (req) => (req ? `Note: Claude Code requires a paid plan — ${req}.` : 'Note: Claude Code requires a paid Claude plan.'),
      installButton: 'Install Claude Code',
      installing: 'Installing… (downloads from claude.ai, usually under a minute)',
      done: 'Installed. You can continue below.',
      failed: (detail) => `Install did not complete${detail ? ` — ${detail}` : ''}. Try again, or run the command below in Terminal.`,
      manualLead: 'Manual route:',
      docsLink: 'Setup docs',
    },
    // AUTHORED -- ollama key-mode strings (2026-08-04 Mino: "ollama ->
    // API키"): the ollama tab is a key-paste + model-name form now, not a
    // login button. Key hint reuses the fallback tab's proven wording.
    ollamaKey: {
      keyHint: 'Issued in your account settings at ollama.com (API keys).',
      keyPlaceholder: 'Paste the key',
      modelLabel: 'Cloud model to use',
      modelPlaceholder: 'Enter a model name',
      modelHint: 'Copy a name from the model list on ollama.com.',
      modelMissingProceed: 'Fix the name, or press Next again to continue anyway.',
    },
    // Folded-away fallback path. Field-level hint text is unchanged from
    // the pre-v2 copy (still accurate -- only its position in the flow
    // moved from primary to fallback).
    fallback: {
      toggleLabel: 'Connect with an API key',
      // Sirin red-team #5: verification itself is a real POST to the
      // provider's server, so "외부로 전송되지 않습니다" was a false claim.
      // This is the corrected/honest version.
      body: `If you have an API key, you can connect directly. The key is stored only in ${CRED_STORE_THE}. It's sent only to the provider you entered, to verify it. Nothing is sent anywhere else, and nothing is collected.`,
      tabs: [
        { id: 'claude', hint: 'Issued at console.anthropic.com. Starts with sk-ant-.' },
        { id: 'chatgpt', hint: 'Issued at platform.openai.com. Starts with sk-.' },
        { id: 'ollama', hint: 'Issued in your account settings at ollama.com.' },
      ],
      validating: 'Checking the key…',
      success: 'Connected',
      failure: (reason) => `Key rejected (reason: ${reason}). Check the key again or choose a different provider.`,
    },
    // Shown beneath a tab whenever that tab is rendered disabled (UI-scope
    // decision, not directly the routerWired field -- see note above). Same
    // subtext for either disabled tab, per the source file's 폴백 B copy --
    // no date promise, no implying a choice was made.
    routerDisabledNote: 'Connects in a future update. You can start with Claude for now.',
    button: 'Next',
  },

  step2: {
    title: 'Name your agent',
    body: "You'll talk to it by this name. You can change it later in Settings.",
    defaultName: 'Scheherazade',
    button: 'Next',
  },

  step3: {
    title: 'Three quick choices',
    q1Label: 'Tone',
    q1Options: [
      { value: 'casual', label: 'Casual' },
      { value: 'formal', label: 'Formal' },
    ],
    q2Label: "What you'll mostly ask it to do",
    q2Chips: ['Code review', 'Scheduling', 'Research', 'Writing', 'Other'],
    q3Label: 'OK for it to message you first?',
    q3YesPrefix: 'Yes, between',
    q3YesSuffix: 'only',
    q3No: 'No',
    // Flag-follows-copy (Idea copy spec, her lines 46-48): the note has an ON
    // and an OFF version, and it must track the proactive-feature flag so no
    // landing lies. That flag ships default OFF (proactive cycle is not wired
    // this build; only routerWired is in the API surface), so the OFF copy is
    // the truthful landing. Earlier build shipped the ON copy, which promised
    // proactive contact the build will not perform.
    q3Note: 'For now this just saves your consent. Once proactive messaging is enabled, it will follow this setting. You can change it anytime in Settings.',
    button: 'Next',
  },

  step4: {
    title: "Where will you talk?",
    // De-lied for in-app chat (slice 5): the old body claimed "talks
    // through Discord... about 5 minutes" -- no longer the shape of the
    // step. In-app is instant and primary; messengers are the upgrade.
    body: (name) => `${name} can talk right here in the app — no accounts, no tokens. Connecting a messenger is optional, now or anytime from the Channels tab.`,
    startChat: 'Start chatting now',
    startChatNote: 'Finishes setup and opens the conversation',
    // Mino 07-13 click-test: three platform buttons, each a redirect.
    // Discord keeps the real flow (opens the dev portal AND enters the
    // existing tutorial -- redirect alone would kill the guided steps,
    // 2FA warning and Sirin's friction fixes included). Slack/Telegram
    // have NO backend yet (settings.js Slack placeholder is the only
    // trace), so their shared note says so -- otherwise the user makes
    // a token and finds no field to paste it into.
    connectDiscord: 'Connect Discord',
    connectDiscordNote: 'Opens the bot creation page, and step-by-step guidance starts here',
    connectSlack: 'Connect Slack',
    connectTelegram: 'Connect Telegram',
    // De-lied for v0.0.18: slack/telegram backends now EXIST, but the
    // onboarding wizard still walks the Discord path only -- the honest
    // pointer is "finish setup, then switch on the 채널 tab", not the old
    // "지원 예정" (false) and not a fake in-wizard flow (doesn't exist).
    supportSoonNote: 'Only opens the bot creation page. You can connect it from the Channels tab after setup finishes',
    links: {
      discord: 'https://discord.com/developers/applications',
      slack: 'https://api.slack.com/apps',
      telegram: 'https://t.me/botfather',
    },
    // History, kept because it reads like a contradiction otherwise: an
    // early local-chat fallback idea was rejected (Mino 07-13, "localhost
    // is onboarding-only") and this section long said so. The in-app chat
    // BACKEND (channel-local.mjs + /chat, Mino go 07-30 00:28 on
    // docs/in-app-chat-plan.md) supersedes that -- it is a real channel,
    // not the rejected localhost stopgap, and the "later — save and wait"
    // button this comment used to describe is gone with it.
  },

  discordTutorial: {
    // Shown once, before step 1 of 6 (Sirin #2) -- not a numbered step
    // itself, so wizard.js renders it at tutorialIndex === -1.
    preWarning: 'If your Discord account has two-factor authentication (2FA) on, it will ask for a code partway through. Have your authenticator ready.',
    steps: [
      { text: (name) => `Go to discord.com/developers/applications → New Application → enter a name (anything, e.g. ${name})`, shot: true },
      { text: () => "Open the Bot tab on the left → Reset Token → copy the token. This token is a password. Don't paste it anywhere else.", shot: true },
      {
        // Sirin #3: switching the toggle alone does not persist it.
        text: () =>
          'On the same screen, turn on MESSAGE CONTENT INTENT under Privileged Gateway Intents → click the green Save Changes button at the bottom to save it. Toggling the switch alone and leaving does not save it.',
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
          'Paste the copied token into the field below to generate an invite link → open the invite link → choose a server to add the bot to (no server? create one in the Discord app with the + button) → verify connection',
        shot: false,
      },
    ],
    tokenFieldLabel: 'Bot token',
    inviteButton: 'Open invite link',
    inviteHint: 'An invite link with permissions already included',
    validateButton: 'Verify connection',
    validating: 'Verifying connection…',
    success: (name) => `${name} has joined the server. Check Discord to confirm.`,
    failures: {
      invalid_token: 'Token rejected. Make sure you copied a new token after Reset Token in step 2.',
      intent_off: "It can't read messages. Check that MESSAGE CONTENT INTENT is on, from step 3.",
      not_invited: "The bot hasn't joined any server yet. Reopen the invite link from step 4.",
    },
    prevButton: 'Back',
    nextButton: 'Next',
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
      title: 'Connecting',
      body: (name) => `Starting ${name}. This screen updates once Discord connection is confirmed.`,
      button: 'Open Discord',
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
      title: 'All set',
      body: (name, channelName) => `${name} is waiting in #${channelName} on Discord. It also takes DMs. Its first message already reflects the settings you just entered.`,
      // Deep link via POST /api/discord/open { guildId, channelId } --
      // http-server.cjs:1234-1244, confirmed live (source file's own
      // http-server.cjs:1011 citation was stale, code moved).
      button: (channelName) => `Open #${channelName}`,
    },
    failed: {
      title: 'Failed to start',
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
          cause: (name) => `${name}'s process keeps exiting repeatedly. The exact cause isn't confirmed.`,
          action: () => 'Quit the app and reopen it. If it keeps happening, double-check the values you entered at setup.',
          buttons: ['openSettings', 'openLogs'],
        },
        discord_token_bad: {
          cause: () => 'The Discord bot token is missing or was rejected.',
          action: () => 'Go back to the token step and paste a new token.',
          buttons: ['backToToken', 'openLogs'],
        },
        // Slack and Telegram write their own codes into the failure marker
        // (channel-slack.mjs's writeFailureMarker(..., 'slack_token_bad'),
        // channel-telegram.mjs's 'telegram_token_bad') and main.cjs's
        // pollFailureMarker relays them straight into setAgentStatus. Neither
        // had a row here, so the single commonest way to misconfigure either
        // channel rendered as the generic "failed to start / wait a moment and
        // click Check status again" -- we knew exactly what was wrong and said
        // we did not. Same defect as 'bootstrap-needed' above, found the same
        // way (2026-08-04).
        //
        // NOT given the backToToken button: that button is hardcoded to the
        // DISCORD tutorial's last step (wizard.js), so on a Slack or Telegram
        // install it would send the user somewhere unrelated to the token that
        // actually failed.
        //
        // Slack's marker also carries { token: 'bot' | 'app' } -- Slack is the
        // one channel with two distinct tokens, and knowing WHICH one is
        // rejected is most of the fix. wizard.js renders only `code` today, so
        // this row cannot say it yet; naming that here rather than writing a
        // sentence that quietly pretends the distinction does not exist.
        slack_token_bad: {
          cause: () => 'A Slack token is missing or was rejected. Slack uses two -- a bot token and an app-level token -- and either one can be the problem.',
          action: () => 'Re-check both Slack tokens in Settings, then quit and reopen the app.',
          buttons: ['openSettings', 'openLogs'],
        },
        telegram_token_bad: {
          cause: () => 'The Telegram bot token is missing or was rejected.',
          action: () => 'Re-check the token from BotFather in Settings, then quit and reopen the app.',
          buttons: ['openSettings', 'openLogs'],
        },
        provider_not_wired: {
          cause: () => "The model connection you chose isn't ready yet.",
          action: () => 'Switch the model to Claude on the Engine page, then quit and reopen the app.',
          buttons: ['openEngine', 'openLogs'],
        },
        harness_stale: {
          cause: () => "The agent's instruction files couldn't be updated for this version.",
          action: () => 'Quit the app and reopen it. Reopening retries the update, and the agent starts again once it succeeds.',
          buttons: ['openLogs'],
        },
        // action text: same fix as crash_loop above, same reason (no real
        // settings repair UI to send the user to).
        key_error: {
          cause: () => "Couldn't read the stored key.",
          action: () => 'Quit the app and reopen it. If it keeps happening, double-check the values you entered at setup.',
          buttons: ['openSettings', 'openLogs'],
        },
        timeout: {
          cause: (name) => `Can't confirm whether ${name} started.`,
          action: () => 'Wait a moment, then click Check status again.',
          buttons: ['retry', 'openLogs'],
        },
        // Fallback row -- any code not in this table (including a literal
        // "unknown") lands here.
        // 'bootstrap-needed' is set at FOUR places in main.cjs (the attach-
        // topology paths) and had no row here, so causes[code] || causes.unknown
        // rendered 'failed to start / wait a moment and click Check status
        // again' -- advice that can never resolve it, because nothing about it
        // is transient. Found by reading Codex's error taxonomy and asking what
        // OUR codes do not cover (2026-08-04).
        // NOTE for whoever touches this next: main.cjs's four call sites pass a
        // precise Korean detail (including the exact command to run) and
        // wizard.js deliberately never renders detail ('free-form debug prose').
        // That rule is right for the other codes and wrong for this one; making
        // the detail renderable is a bigger change than a copy row, so this row
        // states the situation generically and the specific command still only
        // reaches the console. Left as a decision for Mino, not silently taken.
        'bootstrap-needed': {
          cause: (name) => `${name} is set to attach mode, but there is no session to attach to yet.`,
          action: () => 'Restart the app once -- the bundled tmux sets itself up on boot. If it persists, switch topology to spawn on the Engine page.',
          buttons: ['openEngine', 'openLogs'],
        },
        // ── the nine that used to be 'unknown' (2026-08-04) ─────────────
        // main.cjs had 13 sites passing 'unknown', so a missing Claude Code
        // install, a dead Ollama daemon, an unreadable Discord token and an
        // agent that started and then died all rendered the same sentence:
        // "failed to start, wait a moment and click Check status again."
        // Every one of those sites knew exactly what had happened.
        //
        // The grouping that decides the text is WHOSE PROBLEM IT IS. If it is
        // ours, the user should not be sent to Settings to hunt for a control
        // that cannot fix it; if it is theirs, we owe them the specific step.
        cli_missing: {
          cause: () => 'Claude Code is not installed on this machine. Scheherazade runs on top of your own Claude Code -- it does not ship one.',
          // Install-assist exists now (2026-08-04, Mino "2로 가자"): the
          // setup screen's preflight panel has a one-click install button,
          // so the action points there AND carries the manual command for
          // anyone who prefers Terminal.
          action: () => 'The setup screen now has an "Install Claude Code" button (one click, official installer). Manual route: curl -fsSL https://claude.ai/install.sh | bash — then reopen this app.',
          buttons: ['openLogs'],
        },
        ollama_unavailable: {
          cause: () => 'The local Ollama daemon is not running, so there is nothing for the agent to talk to.',
          action: () => 'Start Ollama, confirm the model you picked is pulled (`ollama list`), then quit this app and reopen it.',
          buttons: ['openSettings', 'openLogs'],
        },
        proxy_unavailable: {
          cause: () => 'The local proxy this model connection needs did not come up, and the agent was not started rather than routed somewhere unverified.',
          action: () => 'Quit the app and reopen it. If it keeps happening, switch the model connection on the Engine page.',
          buttons: ['openEngine', 'openLogs'],
        },
        channel_token_error: {
          cause: () => 'The stored chat-service token could not be read. This is the computer refusing to unseal it -- the token itself may be perfectly good.',
          action: () => 'Quit the app and reopen it, and allow the credential prompt if one appears. If it keeps happening, re-save the token in Settings.',
          buttons: ['openSettings', 'openLogs'],
        },
        // Ours, not theirs. No openSettings button on any of these three:
        // there is no control in Settings that repairs a broken install, and
        // sending someone to look for one wastes their time and reads as a
        // deflection.
        app_files_missing: {
          cause: (name) => `Part of ${name}'s own installation is missing.`,
          action: () => 'Reinstall the app. Nothing you entered is lost -- your settings and memory live outside the app.',
          buttons: ['openLogs'],
        },
        spawn_failed: {
          cause: (name) => `${name} could not be started at all.`,
          action: () => 'Quit the app and reopen it. If it keeps happening, reinstall the app.',
          buttons: ['openLogs'],
        },
        attach_failed: {
          cause: (name) => `${name} is set to attach mode and the terminal session it was attached to could not be brought back.`,
          action: () => 'Switch topology to spawn on the Engine page, or restart the app to rebuild the session.',
          buttons: ['openEngine', 'openLogs'],
        },
        // Started, then stopped. Distinct from every code above: something DID
        // run, so "it never started" advice would be wrong.
        agent_exited: {
          cause: (name) => `${name} started and then stopped unexpectedly.`,
          action: () => 'Click Check status again to see if it came back on its own. If not, quit the app and reopen it.',
          buttons: ['retry', 'openLogs'],
        },
        stop_unconfirmed: {
          cause: (name) => `${name} was asked to stop and did not confirm it had -- it may still be running.`,
          action: () => 'Quit the app and reopen it. That clears the old process for certain.',
          buttons: ['openLogs'],
        },
        unknown: {
          cause: (name) => `${name} failed to start.`,
          action: () => 'Wait a moment and click Check status again. If it keeps happening, quit the app and reopen it.',
          buttons: ['retry', 'openLogs'],
        },
      },
    },
    // Button label text, keyed by button "kind" (wizard.js maps kind ->
    // label + onClick). Labels sourced from the 버튼 column of the §상태3
    // table; wiring behind each is documented in wizard.js at the point of
    // use (openLogs and retry have no backend endpoint yet -- see there).
    buttonLabels: {
      openSettings: 'Open Settings',
      openEngine: 'Open Engine',
      openLogs: 'Open Logs',
      backToToken: 'Back to token step',
      retry: 'Check status again',
    },
  },

  memoryPane: {
    title: 'Memory',
    subtitle: (name) => `Everything ${name} knows about you. Anything not here, it doesn't remember.`,
    sessionGroupTitle: 'Remembered this session',
    categories: {
      user_facts: { label: 'About you', empty: 'Nothing yet. This fills in as you talk.' },
      open_threads: { label: 'Unfinished things', empty: 'None right now. Anything left unfinished shows up here.' },
      corrections: {
        label: 'Corrections',
        empty: (name) => `Nothing yet. Correct ${name} and it's logged here, so the same mistake isn't repeated.`,
      },
      preferences: { label: 'How it works', empty: 'Adjust this in Settings.' },
    },
    // Tri-state status label for open_threads, verbatim from the copy row
    // format spec "상태(진행 중/완료/오래됨)". Derivation rule (status +
    // staleness -> label) is this build's own inference -- see memory.js.
    threadStatus: { active: 'In progress', done: 'Done', stale: 'Stale' },
    // Preference key/value labels: these keys are this build's own
    // invention (Step 3 writes them), so their Korean labels are authored
    // here, not sourced from the copy file.
    prefKeyLabels: {
      tone: 'Tone',
      primary_task: 'Main task',
      proactive_enabled: 'Message first',
      proactive_window: 'Proactive time window',
    },
    prefValueLabels: {
      casual: 'Casual',
      formal: 'Formal',
      true: 'On',
      false: 'Off',
    },
    eventLabels: { insert: 'Added', update: 'Updated', confirm: 'Confirmed', delete: 'Deleted' },
    // "What I remember" (Dreaming feature, 2026-08-16) -- AUTHORED, not in
    // the copy file (this UI is new). The agent's own nightly synthesis of
    // memory-summary.md, written by following procedures/memory-consolidation.md.
    remember: {
      label: 'What I remember',
      refreshLabel: 'Refresh',
      updated: (t) => `Last updated ${t}`,
      empty: (name) => `${name} hasn't written this yet. It's rewritten overnight, during a scheduled memory-consolidation pass — that requires autonomy to be turned on in Settings, and at least one night to have gone by since.`,
      loadError: (msg) => `Couldn't load this (${msg}).`,
    },
    // AUTHORED -- recently-touched files (같이보기 batch, Mino 2026-08-19:
    // "세라가 최근에 건드린 파일들 리스트도 볼 수 있게"). Register rules:
    // failed touches render dimmed with a mark, never hidden -- hiding a
    // failed write is the silent-false-success class this app keeps killing.
    recentFiles: {
      label: (name) => `Files ${name} touched recently`,
      refreshLabel: 'Refresh',
      empty: (name) => `Nothing recorded yet. This fills in as ${name} writes or edits files (recorded from this app version on).`,
      loadError: (msg) => `Couldn't load this (${msg}).`,
      touches: (n) => (n > 1 ? `${n} edits` : '1 edit'),
      failedMark: 'last edit failed',
      openFail: (msg) => `Couldn't open it (${msg}).`,
      openHint: 'Click a file to open it',
    },
    deleteDialog: (name) => `This can't be undone. ${name} will no longer remember this. Only a record that it was deleted will remain.`,
    deleteConfirm: 'Delete',
    deleteCancel: 'Cancel',
    deleteToast: 'Deleted.',
    deleteLabel: 'Delete',
    // AUTHORED (not in copy file) -- manual refresh, Mino 07-13 click-test:
    // "기억페이지 리프레시 버튼이라도 있으면 좋겠어"
    refreshLabel: 'Refresh',
    refreshToast: 'Reloaded.',
  },

  // AUTHORED (not in copy file) -- shared shell (nav.js), subpage split
  // 2026-07-14 per docs/ia-subpage-plan.md. tabs{} is genuinely new UI (the
  // 3-way split didn't exist before); everything else here is MOVED verbatim
  // from memory.js's inline AGENT_COPY const (Slice 2, 2026-07-09) -- still
  // eng placeholder pending Mino's copy-track localization pass, unchanged
  // by the move itself.
  nav: {
    // channels FIRST (multichannel v0.0.18, Mino 07-16: "맨 앞에 채널 섹션") --
    // tab order is meaning here: the messenger the agent lives through
    // outranks what it remembers and how it runs.
    tabs: { chat: 'Chat', channels: 'Channels', memory: 'Memory', connectors: 'Engine', settings: 'Settings', appearance: 'Appearance', logs: 'Logs' },
    // IA v2 (2026-08-13): 7 flat tabs collapsed to 4 daily surfaces
    // (Chat/Memory/Settings/Logs); the config-family pages (Channels, model &
    // providers, Appearance) live under a Settings sub-nav. Labels below name
    // the sub-nav rows -- "Model & Providers" replaces the ambiguous "Engine"/
    // "Connectors" split the page had.
    subGeneral: 'General',
    subModel: 'Model & Providers',
    label: 'AGENT',
    states: { live: 'Running', connecting: 'Starting…', stopped: 'Stopped', failed: 'Failed', idle: 'Not started' },
    start: 'Start',
    stop: 'Stop',
    restart: 'Restart',
    openDiscord: 'Open Discord',
    stopConfirm: 'Stop the agent?',
    // Autonomy runs INSIDE the agent's own channel process (autonomy/tick.cjs
    // is driven from channel.mjs), so stopping the agent stops the night
    // cycle with it -- this note states that fact. It must never claim the
    // opposite ("autonomy will wake it back up" would be a lie in this
    // architecture; verified against tick.cjs before wording this).
    stopConfirmAutonomyNote: " Tonight's autonomous cycle stops with it.",
    stopOk: 'Stop',
    cancel: 'Cancel',
    switchOk: 'Switch',
    updateAvailable: (latest, current) => `Update available: v${latest} (you're on v${current}).`,
    updateOpen: 'Download',
    muteWarn: (n, m) => `${m} was asked to reply ${n}× and didn't. The agent may be unable to send messages.`,
    // Turn-error strip (2026-08-04, Mino "클로드도 동작안함"): carries the
    // RAW upstream error text -- that text is the only thing that tells a
    // rate-limit hit ("429/limit reached", wait it out) apart from dead
    // auth ("401/authentication", re-login on Connectors). Paraphrasing it
    // away would hide exactly the discriminator the user needs.
    turnError: (subtype, detail) => `Model call failed (${subtype}): ${detail || 'no detail from the provider'}`,
    turnErrorDismiss: 'Dismiss',
    muteRevert: (m) => `Go back to ${m}`,
    // context gauge (v0.0.22): occupancy is exact (from the transcript's own
    // usage counters); the percentage is vs the best-known cap for the model
    // -- honest about the gap, so no "안전" wording, just numbers.
    contextGauge: (pct, used, cap) => `Context ${pct}% (${used}/${cap})`,
    contextGaugeNoCap: (used) => `Context ${used} tokens`,
    contextGaugePrev: (used) => `Context ${used} (prev session)`,
    muteRevertConfirm: (m) => `Switch back to ${m}? The agent will restart.`,
    // Shell reality additions (IA v0.0.9): autonomy visibility badge (the
    // one setting that spends money while nobody watches deserves a spot in
    // the always-visible bar) -- same eng-placeholder register as the rest
    // of this section, pending the copy-track localization pass.
    autonomyBadge: (start, end) => `autonomy ${start}-${end}`,
  },

  // AUTHORED -- in-app chat page (in-app chat slice 4, Mino go 07-30
  // 00:28, docs/in-app-chat-plan.md). Same no-false-promise register as
  // logs: statusUnreachable says restarts "usually" clear on their own (a
  // stale port file is exactly that), never "will".
  chat: {
    title: 'Chat',
    subtitle: 'Talk to your agent right here. Connected messengers carry the same agent when you want it on your phone.',
    placeholder: 'Message the agent…',
    send: 'Send',
    statusChecking: 'Checking the chat channel…',
    statusUp: (agent) => (agent ? `${agent} is listening.` : 'Connected.'),
    statusNotRunning: "The agent isn't running — start it from the bar above.",
    statusUnreachable: "The agent isn't answering. If it's restarting, this usually clears on its own.",
    // wrongBackend retired 2026-08-05: in-app chat is hosted by every
    // backend now, so that state no longer exists.
    gapMarker: '— some earlier messages fell out of the buffer —',
    empty: 'No messages yet. Say hi.',
    // P1 (design-research 2026-08): empty state doubles as example prompts
    // (Notion pattern). Click fills the composer — never auto-sends.
    emptyTitle: 'No messages yet. Try one of these, or just say hi:',
    emptyExamples: [
      'What can you do for me?',
      'Remember this: I prefer short answers.',
      'What do you remember about me so far?',
    ],
    // P1: jump-to-latest pill (auto-scroll stops when the reader scrolls
    // up; the pill is the way back instead of viewport-yanking).
    jumpToLatest: 'Jump to latest ↓',
    // P1 v2: live run timeline (aside port) — steps render open while the
    // agent works, then collapse into the "Worked for" summary when the
    // reply lands.
    activityRunning: (n) => `Working… · ${n} step${n === 1 ? '' : 's'}`,
    // 0.2.11 storyteller status (Mino 08-21 "'세헤라자드'라는 캐릭터리스틱에
    // 맞춰서... 에이전트가 지금 무슨 일을 하고 있는지 알아보기 쉽게"): the
    // LIVE summary names the current move in the storyteller's own register
    // and updates on every event — the pace of change is what reads as
    // speed ("와바바박 바뀌어야 빨라보인다구"). Verb from the label's shape;
    // the concrete label rides along so it stays informative, not just cute.
    // Labels arrive as `WebFetch: url` / `name: path` / bare bash prose
    // (dsh-lane activityLabelFor + hooks/pre-tool-activity.mjs conventions).
    // Vocabulary drawn from the Nights themselves (Mino: "천일야화에서
    // 따와서"): scrolls and ink for the scribe's work, caravans for word
    // from the wider world, the lamp's djinn for commands carried out, the
    // astrolabe for computation, and the magic word for a practiced art.
    statusLive: (label, n) => {
      const L = String(label || '')
      let verb = "Summoning the lamp's djinn"
      if (/^web_?(fetch|search)/i.test(L)) verb = 'Hearing word from the caravans'
      else if (/^(read|grep|glob|ls|find|view|cat|search)[ :(]/i.test(L)) verb = 'Leafing through the scrolls'
      else if (/^(write|edit|str_replace|create|notebook)[ :(]/i.test(L)) verb = 'Setting ink to paper'
      else if (/^run_code/i.test(L)) verb = 'Consulting the astrolabe'
      else if (/^skill/i.test(L)) verb = 'Open sesame'
      const short = L.replace(/^[A-Za-z_]+:\s*/, '').slice(0, 48)
      return `${verb}${short ? ` — ${short}` : ''} · ${n}`
    },
    thinkLive: 'Weaving the tale…',
    activityFoldSummary: (n, secs) => `Worked for ${secs}s · ${n} step${n === 1 ? '' : 's'}`,
    activityFoldAria: 'What the agent did during this turn',
    // 0.2.1 collapsible Think fold (dsh lane reasoning stream; Mino 08-19
    // "우리도 띵크 접이식으로 가자"). Collapsed by default — the reasoning
    // is there when wanted, never in the way.
    thinkSummary: 'Thinking…',
    thinkFoldSummary: 'Thought process',
    // 0.2.15 background-subagent pill (Mino 08-24 "서브 스폰하면 서브도
    // working 정보에 띄우게"): stays visible across turn ends while any
    // background child is still working, so "Worked for Ns" cannot read as
    // "everything is finished".
    bgPill: (labels) => labels.length === 1
      ? `Still working in the background: ${labels[0]}`
      : `Still working in the background (${labels.length}): ${labels.join(' · ')}`,
    bgPillAria: 'Background tasks the agent has running',
    thinkAria: "The model's reasoning for this turn (click to expand)",
    sendFailed: "Couldn't send. Your message is still in the box — try again.",
    // DM interaction states (v0.0.34). `read` is honest by construction:
    // a user message only enters the transcript after it was delivered
    // into the agent process, so the label never claims more than that.
    read: 'Read',
    typingAria: 'The agent is typing…',
    activityAria: 'What the agent is working on right now',
    reactAria: (emoji) => `React with ${emoji}`,
    reactFailed: "Couldn't react — try again.",
    // Message copy button (2026-08-05, colleague feedback via Mino).
    copyAria: 'Copy this message',
    copied: 'Copied.',
    copyFailed: 'Copy failed. Select the text manually and copy it.',
    // Image attachments (2026-08-04, Mino "인앱챗에 이미지 업로드할수있는
    // 방법이 없음"). The 10MB number matches the server's hard cap in
    // routes/chat.cjs -- if that changes, change both.
    attachTitle: 'Attach an image (or paste one into the box)',
    attachBadType: 'Only PNG, JPG, GIF, or WebP images can be attached.',
    attachTooLarge: 'That image is over 10MB — too big to attach.',
    attachFailed: (msg) => `Couldn't upload the image: ${msg}`,
    attachMissing: (name) => `🖼 ${name} (file no longer available)`,
    // Soft warning, never a block: the vision table is a best-effort
    // binding (ollama.com library scrape 2026-08-04), and a false block
    // is worse than a warned attempt.
    attachNoVision: "Heads up: the current model can't view images, so the agent will only know a file was attached.",
    // Vision stand-in landed (0.0.56): same warning class, better outcome.
    attachCaptioned: "The current model can't view images, so a helper vision model described it for the agent.",
    // Lane status chip (0.1.4): states capability, never apologizes for it.
    laneChipVisionYes: 'sees images',
    laneChipVisionNo: 'no image vision · helper describes',
    // "New conversation" clean break (2026-08-18): a genuine fresh session.
    // The button is low-key; the confirm carries the weight because the action
    // is irreversible. The copy is honest about the exact split -- this thread
    // is forgotten, but what the agent LEARNED about you (its memory) stays.
    newConversation: 'New conversation',
    newConversationConfirm:
      'Start a new conversation? This clears the chat here and the agent forgets everything in this thread — its next reply starts fresh. What it has learned about you (its saved memory) is kept. This cannot be undone.',
    newConversationConfirmOk: 'Start fresh',
    newConversationStarting: 'Starting a fresh conversation…',
    newConversationFailed: "Couldn't start a new conversation — try again.",
  },

  // AUTHORED (v0.0.20) -- session log viewer (Mino 07-16: 개발 중 앱이
  // 깜깜이라 로그 창 요청). Register matches the rest: 간결 존댓말, no
  // promises the code doesn't keep -- redaction is best-effort, so the
  // copy says tokens are "가려집니다" (mechanism) and never "안전합니다"
  // (guarantee it can't make).
  logs: {
    title: 'Logs',
    backToMemory: 'Back to Memory',
    subtitle: 'Live logs from the app and agent session. Known secrets like tokens are masked automatically.',
    copyButton: 'Copy all',
    copied: 'Copied. Paste it as-is to share.',
    copyFailed: 'Copy failed. Select the text manually and copy it.',
    empty: 'No logs yet. Output appears here once the agent starts.',
    gapMarker: '— Some earlier logs were pushed out of the buffer. The full record is in the log file —',
    fileNote: (p) => `Full record file: ${p}`,
    fileNoteMissing: "The disk log file hasn't been created yet.",
    followOn: 'Auto-scroll',
    pollError: "Couldn't load logs. Check that the app is running.",
  },

  // AUTHORED (not in copy file) -- settings page, minimal v1.
  appearance: {
    title: 'Appearance',
    subtitle: 'Tune the look. Every change applies instantly — this page is the preview — and saves on its own.',
    glassLabel: 'Background',
    glassNote: 'Tint is how much your background color covers the window glass. Blur is the glass itself — it has three levels because the OS only offers blur in steps, and Windows pauses it while the window is in the background.',
    glassRangeLabel: 'Tint',
    blurLabel: 'Blur',
    blurLevels: { off: 'Off', soft: 'Soft', strong: 'Strong' },
    typeLabel: 'Type',
    fontSizeLabel: 'Font size',
    fontFamilyLabel: 'Font family',
    fonts: { system: 'System', pretendard: 'Pretendard', serif: 'Serif', mono: 'Mono', rounded: 'Rounded' },
    accentLabel: 'Color',
    accentRowLabel: 'Accent',
    bgRowLabel: 'Background',
    fgRowLabel: 'Text',
    reset: 'Reset to defaults',
    saved: 'Saved',
    saveFailed: 'Save failed',
  },

  settings: {
    title: 'Settings',
    backToMemory: 'Back to Memory', // unused since the IA pass removed the back link; kept so a future page can reuse it
    // Three group headings (IA pass 2026-07-25). The page used to run seven
    // flat blocks; these name the question each group answers, so the answer
    // to "where do I change X" is one read instead of a scan.
    groupAgent: 'Agent',
    groupSystem: 'System',
    // Danger zone (v0.0.35). The confirm names EVERYTHING that dies --
    // memory included -- and the one thing that survives (~/.claude.json,
    // shared with the user's own Claude Code). No euphemisms: "deletes the
    // agent's memory" is the sentence a user must read before clicking.
    groupDanger: 'Danger zone',
    // AUTHORED -- About / manual update check (2026-08-04, Mino "오토
    // 업데이트 버튼 어딨니?"). The nav banner appears only when an update
    // exists; this row is the always-there surface. "Check now" honesty:
    // failure shows the server's detail, up-to-date says so plainly.
    // Import from other agents (design-0022). The hint is honest about
    // the mechanism: the AGENT reads the files, live, after consent --
    // this panel never copies anything itself. Credential stores are
    // excluded by name at three layers; the copy may say "never touched"
    // because the pre-tool guard actually enforces it.
    groupMigrate: 'Import',
    migrateLabel: 'Bring over another agent',
    migrateHint: 'Found data from other AI agent tools on this computer. Pick which ones your agent may read — it will go through them in chat, keep what matters to its own memory, and offer to take over recurring jobs. Credential and token files are never touched.',
    migrateStartButton: 'Hand it over',
    migrateNoneFound: 'No other agent tools were found on this computer.',
    migrateToolLine: (label, n, truncated) => `${label} — ${n}${truncated ? '+' : ''} files`,
    migrateStarting: 'Asking the agent to take over…',
    migrateStartedLive: 'The agent is on it — watch the chat.',
    migrateStartedQueued: "Queued. The agent will start the import next time it's running.",
    // design-0023 handover: custom agents (rev B: agent-led discovery
    // first, manual path as fallback).
    handoverLabel: 'A custom agent',
    handoverHint: "Built or ran an agent that isn't on the list? Your agent can hunt for its traces (persona.md, AGENTS.md and kin) by filename, show you what it found, and take over only the folders you approve — mapping how each one worked before absorbing anything. Credential files are never touched.",
    handoverDiscoverButton: 'Find agents on this computer',
    handoverManualHint: 'Or point at a folder directly (useful for drives the search index misses):',
    handoverPlaceholder: '/path/to/that/agent',
    handoverCheckButton: 'Preview',
    handoverChecking: 'Looking…',
    handoverPreviewLine: (n, truncated, shaped) =>
      `${n}${truncated ? '+' : ''} files.` + (shaped ? ' Looks like an agent lives here.' : ' No agent traces recognized — hand it over anyway if you know better.'),
    groupAbout: 'About',
    aboutLabel: 'App version & updates',
    aboutVersion: (v) => `Scheherazade v${v}`,
    updateCheckButton: 'Check for updates',
    updateChecking: 'Checking…',
    updateUpToDate: "You're on the latest version.",
    updateAvailableLine: (latest) => `v${latest} is available.`,
    updateOpenButton: 'Open download page',
    updateCheckFailed: (detail) => `Couldn't check: ${detail || 'unknown error'}`,
    // AUTHORED -- Ollama by-URL model picker (2026-08-04, Mino: paste an
    // ollama.com/library/{model} URL to run models the dropdown doesn't
    // list). The model-absent line WARNS instead of blocking: the public
    // catalog probe is best-effort and can lag a brand-new model.
    ollamaUrlCatalogLabel: 'Other (ollama.com URL)…',
    ollamaUrlHint: 'Paste an ollama.com model URL (like https://ollama.com/library/kimi-k3) or a model name.',
    ollamaUrlPlaceholder: 'https://ollama.com/library/…',
    ollamaUrlApply: 'Use this model',
    ollamaUrlParseFailed: "Couldn't read a model name from that — paste an ollama.com/library/... URL or a plain model name.",
    ollamaUrlNoKey: 'Connect Ollama first (Providers card above) — this needs an ollama.com API key.',
    ollamaUrlChecking: (m) => `Checking "${m}" against ollama.com…`,
    ollamaUrlModelWarn: (m) => `ollama.com's catalog doesn't list "${m}" right now — it may still work if it's brand new.`,
    ollamaUrlApplyFailed: 'Switch failed — the agent kept its previous model.',
    ollamaUrlApplied: (m) => `Switched to ${m}. The agent is restarting.`,
    // Usage gauge cli-session source label (403-scope fix): honest about
    // WHICH login the number describes.
    usageCliSourceNote: 'via this Mac\'s Claude CLI login',
    usageSetupTokenSourceNote: 'via the setup-token — may not read usage; connect below for accuracy',
    // Full-scope usage-login CTA (2026-08-13, the real fix for the stuck 429).
    usageConnectCta: 'Connect Claude usage',
    usageConnectStarting: 'Opening a login window…',
    usageConnectWaiting: 'Finish signing in in the browser — this updates on its own.',
    usageConnectDone: 'Connected — reading usage.',
    usageConnectFailed: 'Login did not finish. Try again.',
    usageConnectTimeout: 'Login timed out. Try again.',
    dangerLabel: 'Delete the app and everything it made',
    dangerNote: "Removes the agent, its memory and journals, saved credentials, caches, and the app itself — everything, without Terminal. Your personal Claude Code settings (~/.claude.json) are left untouched.",
    dangerButton: 'Delete everything…',
    dangerConfirm: (name) => `This permanently deletes ${name} — the agent, all of its memory and journals, saved tokens, and the app itself. There is no undo. The app will close when it's done.`,
    dangerConfirmButton: 'Delete everything',
    dangerCancel: 'Keep it',
    dangerDone: 'Deleting. The app will close itself in a moment — it is already in the Trash.',
    renameLabel: 'Name',
    renameButton: 'Save',
    renameSaved: 'Saved.',
    // AUTHORED -- apply-state line under the model/effort selects (IA
    // v0.0.9, red-team fold #1): the shell shows reality, this line explains
    // the GAP. Its highest-value state is the failure one -- a spawn refused
    // by the proxy model-receipt gate (07-14 catch) surfaces its reason HERE,
    // next to the picker that caused it, instead of only in the app log.
    applyChecking: 'Checking applied state…',
    applyApplied: (m, e) => `Applied · ${m} / ${e}`,
    applyStopped: 'Stopped. It will start with this setting.',
    applyPending: (m) => `Restarting… (previously running: ${m})`,
    applyMismatch: (m) => `Currently running ${m}. Restart to apply this setting.`,
    applyFailed: (detail) => `Failed to start: ${detail}`,
    // AUTHORED -- attach topology (0.1.0 prep, design-0016). Copy contract:
    // the bootstrap NEVER runs from the app, so every string here hands the
    // work to the user's terminal explicitly. No "안전합니다"-class promises
    // -- the why-line states the mechanism (attribution), not a guarantee.
    topologyLabel: 'How the agent runs',
    topologyNote: 'Spawn: the app launches the agent. Attach: it joins a tmux session you started — permissions survive updates, and the agent outlives the app.',
    topologySelectLabel: 'Mode',
    topologySpawnOption: 'Spawn — the app runs it directly (default)',
    topologyAttachOption: 'Attach — connect to a tmux session in Terminal',
    topologySave: 'Save',
    topologySaved: 'Saved. Applies from the next start or restart.',
    topologyStateSpawn: 'Currently running in spawn mode.',
    topologyStateNoTmux: "The app's bundled tmux isn't ready yet — quit and reopen the app once, then try again.",
    topologyStateBootstrapNeeded: "No session to attach to. Paste and run the command below in Terminal (or iTerm). The app doesn't run this for you on purpose — permissions need to be attached to Terminal's lineage to survive app updates.",
    topologyStatePaneDead: 'The session exists, but the agent is off. Use the Start button in the top bar to bring it back.',
    topologyStateAttached: (cmd) => `Attached to the session. To view it directly in Terminal: ${cmd}`,
    topologyBootstrapWhy: 'This command must run in your own Terminal (this is what ties macOS permissions to Terminal):',
    topologyBootstrapCopy: 'Copy command',
    topologyBootstrapCopied: 'Copied. Paste it into Terminal and run it.',
    // AUTHORED -- sudo askpass (0.1.0 prep, P4). Mechanism wording only, no
    // safety promises: where it's stored, where it never goes, when it works.
    sudoLabel: 'Admin privileges (sudo)',
    sudoNote: `When on, the agent can use sudo commands. The password is encrypted and stored in a vault backed by ${CRED_STORE_THE}, and is designed to never appear in chat, logs, or conversation history. sudo doesn't work while the app is off.`,
    sudoEnableLabel: 'Allow sudo',
    sudoPasswordLabel: 'Mac login password',
    sudoSave: 'Save',
    sudoSaved: 'Saved.',
    sudoStateStored: 'A password is stored in the vault. To change it, enter a new one and save.',
    sudoStateEmpty: 'No password stored.',
    sudoNeedPassword: 'Enter a password to turn on sudo.',
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

    // AUTHORED -- custom provider (generic OpenAI-compatible proxy,
    // 2026-07-25). Register matches the rest of this page: 간결 존댓말, no
    // 이모지, no 느낌표. Always-visible section (same convention as Autonomy/
    // Topology/Sudo below), not gated on the current provider -- switching
    // TO custom and editing an already-custom install's fields share this
    // one form.
    customLabel: 'Custom proxy',
    customNote: 'Any OpenAI-compatible endpoint. Base URL + model ID; key only if the proxy needs one.',
    customCatalogLabel: 'Custom (any model ID)',
    customPresetLabel: 'Common proxies',
    customPresetPlaceholder: 'Enter manually',
    customPresetClinePass: 'ClinePass (:18084)',
    customPresetGrok: 'Grok (:8766)',
    customPresetOllamaCloud: 'Ollama Cloud (:11434)',
    customPresetCodexApi: 'Codex-as-API (:18080)',
    // Subscription / pay-as-you-go cloud providers (2026-08-31): pick one and
    // the Base URL + a starter Model ID fill in; you add your own key. All
    // three speak the OpenAI-compatible protocol this custom lane already uses.
    // Model IDs are editable — vendors rotate their default model names often.
    customPresetKimi: 'Kimi / Moonshot',
    customPresetDeepSeek: 'DeepSeek',
    customPresetZai: 'z.ai (GLM)',
    customUrlLabel: 'Base URL',
    customKeyLabel: 'API key (optional)',
    customKeyStoredPlaceholder: 'Key stored — leave blank to keep using it',
    customKeyEmptyPlaceholder: 'No key stored — enter one only if needed',
    customModelLabel: 'Model ID',
    customModelPlaceholder: 'Enter a model name the proxy recognizes',
    customMissingFields: 'Enter both Base URL and model ID',
    customSwitchConfirm: (m) => `Switch to the custom proxy (model: ${m}) and restart the agent. Continue?`,
    // Names BOTH hosts and states them as facts, rather than asserting which
    // host the key "belongs" to -- the app does not know that. It knows the
    // proxy was saved as one host and is about to become another while a key
    // rides along. The key field is a password field, so a populated one and
    // an empty one look identical, and an empty one means the stored key is
    // reused; the host is the part the user cannot otherwise see. Never shows
    // the key itself -- the warning is about where it goes.
    // THREE strings, because there are three different true things to say and
    // the last two revisions each shipped a false one.
    //
    // `stored`: CUSTOM_BASE_URL is the last URL SAVED, not where the key was
    // stored -- the save route rewrites it on a blank-key save while leaving
    // the key store untouched, so the two diverge. A previous revision said
    // "The saved API key was stored for X", which asserts provenance the data
    // does not carry. This says only what is true: the proxy is currently
    // saved as X, it is becoming Y, and the stored key goes along.
    //
    // `storedNoHost`: a key stored through /api/byok/validate leaves no
    // CUSTOM_BASE_URL behind, so there is no prior host to name. The previous
    // revision interpolated the empty string and rendered "was stored for ,
    // and this points...". Say the truth instead: we do not know.
    //
    // `pasted`: the ONE case where provenance is actually known, because the
    // baseUrl and the apiKey arrived in the same blob.
    customSwitchConfirmKeyToNewHost: (m, host, priorHost) => `Switch to the custom proxy (model: ${m}) and restart the agent.\n\nThe proxy is currently saved as ${priorHost}, and this changes it to ${host}. The stored API key will be sent there. Continue?`,
    customSwitchConfirmKeyNoPriorHost: (m, host) => `Switch to the custom proxy (model: ${m}) and restart the agent.\n\nA stored API key will be sent to ${host}. There is no record of which host that key was saved for. Continue?`,
    customSwitchConfirmPastedKeyToNewHost: (m, host, priorHost) => `Switch to the custom proxy (model: ${m}) and restart the agent.\n\nThe pasted API key arrived with ${priorHost}, but the proxy is now set to ${host}. That key will be sent there. Continue?`,
    customSave: 'Save',
    customSaved: 'Saved. Restarting the agent.',
    // Pasted definition (2026-07-29). Folded shut by default -- it is a
    // shortcut for people arriving with a blob from another tool, not the
    // path we teach. The copy says "fills in the fields above" rather than
    // "adds a provider" because that is literally all it does: this app runs
    // one provider at a time, so a paste declaring several is refused with
    // its own message from the server rather than quietly narrowed.
    customJsonSummary: 'Paste a provider definition instead',
    customJsonNote: 'Have a provider definition in JSON from another tool? Paste it here and it will fill in the fields above. Nothing is saved until you press Save. One provider and one model per paste.',
    customJsonPlaceholder: '{ "providers": { "my-provider": { "baseUrl": "http://localhost:18080", "models": [{ "id": "my-model" }] } } }',
    customJsonLoad: 'Fill in the fields',
    customJsonEmpty: 'Paste a provider definition first',
    customJsonLoaded: 'Filled in — check the fields above, then press Save.',
    customJsonLoadedWithKey: 'Filled in, including an API key — check the fields above, then press Save.',
    // Said out loud because the consequence is invisible: the key field is a
    // password field, so "blank" and "a key you cannot see" look identical,
    // and blank means the stored key keeps being used -- against whatever
    // endpoint the paste just set.
    customJsonLoadedKeptKey: 'Filled in. The paste had no API key, so the key already stored will be used with this endpoint — type a new one in the API key field above if that is not what you want.',

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
    autonomyLabel: 'Work on its own',
    // Copy diet (대공사 2026-08-05): the cost fact stays — unattended spend
    // is the one thing this note must say — everything else went.
    autonomyNote:
      'Picks its own work while you sleep — spending your subscription unattended. Off by default; hard-stopped by the cap below.',
    // Just 'Enabled': the category heading directly above already says WORK
    // ON ITS OWN, so repeating it here only made the label wrap to two lines
    // and pushed the checkbox off the shared control baseline.
    autonomyEnableLabel: 'Enabled',
    autonomyWindowLabel: 'Working hours',
    autonomyWindowNote: 'Starts only inside this window (may cross midnight).',
    // "하룻밤" and not "하루": the cap is enforced per CYCLE, from the moment the
    // window opens until it closes. A 23:00-05:00 night is one night, and
    // measuring it per calendar day handed it a second budget at midnight.
    autonomyCapLabel: 'Per-night token cap',
    autonomyCapNote:
      'Nightly ceiling, cache included — the morning brief reports against it. 0 disables; there is no unlimited.',
    // Deliberately a DIFFERENT label from the cap: this is everything spent
    // today including your own conversations, and it is not what the cap is
    // measured against. One label over two measurements is how a number starts
    // lying.
    autonomyUsageLabel: "Today's total usage (including conversations)",
    autonomyTokensWord: 'tokens',
    autonomyUsageBlind:
      "Usage can't be measured right now. It won't work on its own while it can't be measured.",
    autonomyLastCycle: 'Last night',
    autonomyLastCycleNone: "Hasn't worked on its own yet",
    autonomyLastCycleStopped: 'Stopped partway after hitting the cap',
    autonomyLastCycleBriefed: 'Sent the morning brief',
    autonomyLastCycleRan: 'Worked',
    autonomySkipCap: "Didn't start because it was already at the cap",
    autonomySkipMeter: "Didn't start because usage couldn't be measured",
    autonomySave: 'Save',
    autonomySaved: 'Saved',
    autonomyInvalidWindow: 'Invalid time format (e.g. 02:00)',
    autonomyInvalidCap: 'Enter a number',

    // AUTHORED -- permission checklist (P0, 2026-07-15). Register rules for
    // this block: a probe that cannot measure never renders as granted or
    // denied ("확인 불가" is its own state), and rows without a Settings
    // pane (SIP/sudo) never grow an open button -- offering a toggle that
    // cannot fix the problem is the misroute this feature exists to kill.
    permsLabel: 'Permission status',
    permsNote:
      'What macOS currently allows. Granting always happens in System Settings — this page only checks and points.',
    permsLoading: 'Checking…',
    permsLoadFailed: "Couldn't check permission status",
    permsGranted: 'Granted',
    permsDenied: 'Denied',
    permsIndeterminate: "Can't determine",
    permsHeuristicMark: 'Estimated',
    permsStoredMark: 'stored key',
    permsVerifiedMark: 'verified just now',
    permsOpenButton: 'Open Settings',
    permsProbeButton: 'Check',
    permsClassNames: {
      fda: 'Full Disk Access',
      screen: 'Screen Recording',
      accessibility: 'Accessibility',
      automation: 'Automation (control other apps)',
      sudo: 'Admin commands (sudo)',
      sip: 'System Integrity Protection (SIP)',
    },
    permsClassNotes: {
      screen: 'Needed for 같이보기 — the agent taking a screenshot of one of your app windows when you ask it to look.',
      automation: 'Clicking Check may prompt a macOS permission dialog',
      sudo: 'Granted (stored key) means the admin password saved during setup arms sudo -A through the app. Check actually runs sudo with it — the one honest test of the stored password.',
      sip: 'A fixed system condition, unrelated to app permissions. Not something you change in Settings.',
    },
    permsRelaunchNote: 'If you changed a permission in Settings, some changes need an app restart to show up here',
    permsRelaunchButton: 'Restart App',
  },

  // AUTHORED -- channels page (multichannel v0.0.18, Mino 07-16 15:07:
  // "맨 앞에 채널 섹션 추가하고 Discord/Slack/Telegram 연동 갈아끼울 수
  // 있게" + 15:13 "셋 다 실작동까지 이번에"). The discord reconnect strings
  // MOVED here verbatim from `connectors` (that page no longer renders
  // messengers); slack/telegram connect strings are new. Register: 간결
  // 존댓말, no 이모지, no 느낌표.
  channels: {
    title: 'Channels',
    subtitle: 'In-app chat is always on. Connect a messenger to also reach the agent from your phone.',
    activeBadge: 'Active',
    configuredBadge: 'Connected',
    notConfiguredBadge: 'Not connected',
    // In-app chat stopped being a switch target in spirit (2026-08-05:
    // every backend hosts it), so its row states presence, not selection.
    localAlwaysOn: 'Always on',
    switchButton: 'Switch to this channel',
    switchConfirm: (name) => `Switch to ${name} and restart the agent. Continue?`,
    switchOk: 'Switch',
    switching: 'Switching and restarting the agent…',
    switched: (name) => `Switched to ${name}`,
    switchAfterConnect: (name) => `${name} is connected. Switch the agent to this channel now?`,
    notConfiguredYet: 'Finish connecting before you can switch',
    names: { local: 'In-app chat', discord: 'Discord', slack: 'Slack', telegram: 'Telegram' },
    connectButton: 'Connect',
    reconnectButton: 'Reconnect',
    closeButton: 'Close',
    homeLine: (label) => `Home: ${label}`,
    invalidToken: 'Token is invalid',
    // -- discord (moved verbatim from connectors.*) --
    discordConnected: (guild, channel) => `Connected · ${guild} / #${channel}`,
    discordStoredTokenNote: 'Leave blank to keep using the stored token. Paste a new one only if the bot token changed.',
    discordTokenPlaceholder: 'New bot token (optional)',
    discordEnumButton: 'Load server list',
    discordEnumRunning: 'Loading server list…',
    discordGuildLabel: 'Server',
    discordChannelLabel: 'Channel',
    discordTruncatedNote: (max) => `The bot is in many servers, so only the first ${max} are shown`,
    discordNoChannels: 'No text channels in this server',
    discordApplyButton: 'Connect to this channel',
    discordApplyConfirm: (guild, channel) => `Move to ${guild} / #${channel} and restart the agent. Continue?`,
    discordApplyOk: 'Move',
    discordApplying: 'Applying and restarting the agent…',
    discordApplied: (guild, channel) => `Connected: ${guild} / #${channel}`,
    // -- telegram (new backend, channel-telegram.mjs) --
    telegramGuide: 'Create a bot with /newbot in BotFather (@BotFather) and paste the token. Then send the bot any message in Telegram so the chat shows up in the list.',
    telegramOpenBotFather: 'Open BotFather',
    telegramTokenPlaceholder: 'Bot token (123456:ABC-...)',
    telegramStoredTokenNote: 'Leave blank to keep using the stored token.',
    telegramEnumButton: 'Load chats',
    telegramEnumRunning: 'Loading chats…',
    telegramChatLabel: 'Chat',
    telegramNoChats: "The bot hasn't received any messages. Send it a message in Telegram, then reload.",
    telegramConflictRunning: "Can't load the list because the agent is currently running on this bot. Stop the agent, then try again.",
    telegramApplyButton: 'Connect to this chat',
    telegramApplied: (label) => `Connected: ${label}`,
    telegramChatUnreachable: "The bot can't reach this chat. Make sure you haven't blocked it.",
    // -- slack (new backend, channel-slack.mjs; Socket Mode, 토큰 2개) --
    slackGuide: 'Create an app from a manifest in the Slack app console, turn on Socket Mode, then paste the app token (xapp-) and bot token (xoxb-).',
    slackOpenConsole: 'Open Slack app console',
    slackBotTokenPlaceholder: 'Bot token (xoxb-...)',
    slackAppTokenPlaceholder: 'App token (xapp-...)',
    slackStoredTokenNote: 'Leave blank to keep using the stored token.',
    slackEnumButton: 'Load channels',
    slackEnumRunning: 'Loading channels…',
    slackChannelLabel: 'Channel',
    slackNotMemberSuffix: ' (bot not invited)',
    slackNoChannels: 'No channels to load',
    slackInvalidBotToken: 'Bot token (xoxb-) is invalid',
    slackInvalidAppToken: 'App token (xapp-) is invalid, or Socket Mode is off',
    slackListFailed: 'Tokens are valid, but Slack refused to return the channel list — usually the bot token is missing the channels:read and groups:read scopes. Add them under OAuth & Permissions, reinstall the app to the workspace, and paste the NEW bot token (it changes on reinstall).',
    slackApplyButton: 'Connect to this channel',
    slackNotInChannel: (name) => `The bot isn't in #${name}. Invite it with /invite in Slack, then try again.`,
    slackApplied: (name) => `Connected: #${name}`,
    // DM-default mode (2026-08-04): tokens-only connect, conversation = the
    // bot's DM. Channel pick stays as the optional secondary path.
    slackDmNote: 'Default: talk to the agent in a DM with the bot — no channel setup needed. Connecting a channel is optional.',
    slackDmApplyButton: 'Connect (DM mode)',
    slackAppliedDm: 'Connected. DM the bot on Slack to start talking.',
    links: {
      telegram: 'https://t.me/botfather',
      slack: 'https://api.slack.com/apps',
    },
  },

  // AUTHORED (not in copy file) -- connectors page, new in the 2026-07-14
  // subpage split (docs/ia-subpage-plan.md). `title`/`backToMemory` are new;
  // everything else below is MOVED verbatim from `settings` (provider auth +
  // Slack banner lived there before the split -- unchanged strings, just
  // relocated), except `providersNote`, corrected in place: it used to say
  // "기억 페이지의 모델 선택" (model select lived on /memory back then; then
  // /settings; since the 2026-08-06 tab merge the model select lives HERE,
  // tab relabeled Engine) --
  // otherwise this move would ship a note that sends the user to the wrong
  // page for something this same refactor moved. Register unchanged: 간결
  // 존댓말, no 이모지, no 느낌표, no cheerleading.
  connectors: {
    title: 'Connectors',
    backToMemory: 'Back to Memory',
    slackLabel: 'Slack',
    slackNote: 'Support coming later',
    // AUTHORED -- post-onboarding provider auth (Mino 07-13 click-test:
    // "온보딩 끝낸 이후에 ollama cloud 인증 추가 / chatGPT인증 추가").
    providersLabel: 'Providers',
    // providersNote removed (대공사 — subtitle row retired; the label carries it)
    // custom (custom-provider addition, 2026-07-25): NOT in AUTH_PROVIDERS
    // (connectors.js), so this key is never actually looked up there today --
    // added for display-name consistency with the other two entries and any
    // future call site, harmless either way.
    providerNames: { chatgpt: 'ChatGPT (Codex)', ollama: 'Ollama Cloud', custom: 'Custom proxy' },
    providerConnected: 'Connected',
    providerNotConnected: 'Not connected',
    providerStatusUnknown: 'Status unavailable',
    providerConfigLoadError: "Couldn't read connection status — check Logs and retry.",
    providerAuthButton: 'Authenticate',
    providerTestButton: 'Test',
    providerReloginButton: 'Re-login',
    providerTestRunning: 'Testing the connection…',
    providerTestOk: 'Responded — connection looks alive.',
    providerTestFail: 'No usable response — try Re-login.',
    // ollama key-mode (2026-08-04): connect/rotate = paste an ollama.com API
    // key. Replaces the login shell-out strings for this provider.
    ollamaKeyReplace: 'Replace key',
    ollamaKeyPlaceholder: 'Paste an ollama.com API key',
    ollamaKeyGet: 'Get a key at ollama.com',
    ollamaKeySave: 'Save',
    ollamaKeyValidating: 'Checking the key against ollama.com…',
    ollamaKeySaved: 'Ollama API key saved.',
    // External consoles this page links out to (same shape as the channels
    // section's links map).
    links: {
      ollamaKeys: 'https://ollama.com/settings/keys',
    },
    // Prerequisite doctor (2026-08-06, 0.67 clean-mac feedback). The rows
    // name the two things a fresh machine actually needs; the missing-CLI
    // fix is the official installer, not npm (npm itself is a prerequisite
    // a clean machine doesn't have).
    doctorLabel: 'System check',
    doctorNote: 'What the agent needs on this machine to run at all.',
    doctorRecheck: 'Re-check',
    doctorRowClaudeCli: 'Claude Code CLI — runs the agent in every mode',
    doctorRowCredential: (p) => `Sign-in for the selected connection (${p || 'none'})`,
    doctorPresent: 'Found',
    doctorMissing: 'Missing',
    doctorCredentialFix: 'Connect it in the Providers card above.',
    doctorInstallHint: 'Run this in Terminal, then Re-check. It installs the official CLI without needing npm or Homebrew.',
    doctorInstallCopy: 'Copy command',
    doctorInstallCopied: 'Install command copied.',
    doctorDocs: 'Open install guide',
    // Usage gauges, one line per lane (2026-08-04 evening: "이게 킥임").
    usageLabel: 'Usage',
    usageRefresh: 'Refresh',
    usageLoading: 'Reading usage…',
    // AUTHORED — gauge-UI lane names (2026-08-05, Mino: 텍스트 말고 진짜
    // 게이지 "보기쉽게"). Replaced the old one-line text prefixes.
    usageLaneClaude: 'Claude',
    usageLaneCodex: 'Codex',
    usageLaneOllama: 'Ollama',
    usageLaneSession: 'session',
    usageOllamaReqs: (n) => `${n} reqs this week`,
    // Present in the settings section too — connectors.js reads ITS OWN copy
    // (the old code referenced a key that only existed in settings and
    // rendered "undefined" on the cli-session branch; latent until 08-05).
    usageCliSourceNote: "via this machine's Claude CLI login",
    usageSetupTokenSourceNote: 'via the setup-token — may not read usage; connect below for accuracy',
    usageConnectCta: 'Connect Claude usage',
    usageConnectStarting: 'Opening a login window…',
    usageConnectWaiting: 'Finish signing in in the browser — this updates on its own.',
    usageConnectDone: 'Connected — reading usage.',
    usageConnectFailed: 'Login did not finish. Try again.',
    usageConnectTimeout: 'Login timed out. Try again.',
    usageNoToken: 'no Claude login on file',
    usageCodexNoLogin: 'no Codex login on this Mac (~/.codex)',
    usageOllamaNoKey: 'no ollama.com API key on file',
    // unknown_shape = the undocumented ollama.com endpoint answered with a
    // shape we have not bound yet; the field list IS the receipt to send us.
    usageOllamaUnknownShape: (fields) => `endpoint answered but the shape is new to us — ${fields}`,
    usageWinWeekly: 'weekly',
    usageWinFable: 'fable',
    usageError: 'Could not read usage.',
    usageUnreadable: 'unreadable',
    usageStaleNote: (time) => `refresh failed, showing ${time} reading`,
    providerAuthRunning: 'A login window opened. This updates once you finish logging in in the browser.',
    providerAuthSuccess: 'Connected',
    providerAuthFailures: {
      cli_missing: {
        chatgpt: 'The codex CLI is not installed. Install it from https://github.com/openai/codex, then try again',
        ollama: 'The Ollama app is not installed. Install it from https://ollama.com, then try again',
      },
      cancelled: 'Authentication cancelled',
      timeout: 'Authentication timed out. Try again.',
      exit_nonzero: 'Authentication failed. Try again.',
      unknown: 'Authentication failed. Try again.',
    },
    // AUTHORED -- discord reconnect (Mino 07-14 11:31: "이미 세팅한 상태에서
    // 디코 -> 슬랙 -> 텔레그램 해보게"). Failure branches deliberately reuse
    // discordTutorial.failures VERBATIM at the call site (same three causes,
    // same fixes) -- no duplicate strings here, connectors.js reads that map.
    discordLabel: 'Message channel',
    discordName: 'Discord',
    discordConnected: (guild, channel) => `Connected · ${guild} / #${channel}`,
    discordNotConnected: 'Not connected',
    discordReconnectButton: 'Reconnect',
    discordReconnectClose: 'Close',
    discordStoredTokenNote: 'Leave blank to keep using the stored token. Paste a new one only if the bot token changed.',
    discordTokenPlaceholder: 'New bot token (optional)',
    discordEnumButton: 'Load server list',
    discordEnumRunning: 'Loading server list…',
    discordGuildLabel: 'Server',
    discordChannelLabel: 'Channel',
    discordTruncatedNote: (max) => `The bot is in many servers, so only the first ${max} are shown`,
    discordNoChannels: 'No text channels in this server',
    discordApplyButton: 'Connect to this channel',
    discordApplyConfirm: (guild, channel) => `Move to ${guild} / #${channel} and restart the agent. Continue?`,
    discordApplyOk: 'Move',
    discordApplying: 'Applying and restarting the agent…',
    discordApplied: (guild, channel) => `Connected: ${guild} / #${channel}`,
    // AUTHORED -- Claude subscription re-login row (2026-08-04, Mino
    // "connectors에서 클로드도 re-login 가능하게" + "claude API Key는
    // 없애버리고" -- the claudeKey* BYOK block that lived here is gone with
    // the API-key mode). Wording mirrors the wizard's setup-token panel;
    // the failure line carries the server's verbatim reason, same
    // no-paraphrase rule as the turn-error strip.
    claudeSubName: 'Claude (web login)',
    claudeSubLogin: 'Log in',
    claudeSubRelogin: 'Re-login',
    claudeSubCancel: 'Cancel',
    claudeSubStarting: 'Starting the login…',
    claudeSubWaiting: 'Finish the login in the browser window that opened…',
    claudeSubValidating: 'Checking the login…',
    claudeSubSuccess: 'Claude login refreshed',
    claudeSubFailure: (reason) => `Login didn't complete: ${reason || 'unknown error'}`,
    claudeSubCodePrompt: 'If the browser showed you a code instead of returning here, paste it:',
    claudeSubCodeButton: 'Submit code',
    claudeSubCodeInvalid: "That code didn't work — copy it again from the browser page.",
    // AUTHORED -- chatgpt live serving receipt ("셸은 현실" product form of
    // the 07-14 dropdown-vs-engine model mismatch catch). Shown only when the
    // proxy actually answers; no line when it doesn't run.
    chatgptServing: (model) => `Currently serving: ${model}`,
    chatgptServingUnknown: 'The proxy response has no model info',
    // AUTHORED -- future client slots (Mino 07-14 11:31 directive names the
    // path: 디코 -> 슬랙 -> 텔레그램).
    telegramLabel: 'Telegram',
    telegramNote: 'Support coming later',
    // AUTHORED -- claude.ai connector intercept (춘식3 design, 07-14). The
    // lane warning is the load-bearing honesty line: on a non-subscription
    // lane an authorized connector is inert, so we SAY so instead of shipping
    // a dead button.
    mcpLabel: 'Claude connectors',
    // mcpNote removed (대공사 — subtitle row retired; the label carries it)
    mcpLaneWarning: (lane) => `The agent is currently running on the ${lane} lane, so authenticating here won't let it use connectors. This only works on the Claude subscription login lane.`,
    mcpLoading: 'Loading connector list…',
    mcpCliMissing: "Can't check connectors because the claude executable was not found",
    mcpNone: 'No Claude connectors available',
    mcpConnected: 'Connected',
    mcpNeedsAuth: 'Needs authentication',
    mcpAuthButton: 'Authenticate',
    mcpAuthStarting: 'Preparing authentication…',
    mcpUrlReady: 'Open the link below in your browser to approve it, then restart the agent',
    mcpOpenLink: 'Open approval page',
    mcpAuthTimeout: 'Authentication timed out. Try again',
    mcpAuthFailed: 'Authentication failed. Check the app log',
  },

  // Sourced from the source file's Step 4 폴백 note: "waiting.html 카피
  // (폴백 착지 화면)". Not a chat body (Mino rejected web-chat) -- status +
  // a single CTA back into the Discord tutorial only.
  waiting: {
    title: 'Settings saved',
    banner: (name) => `${name} is waiting for Discord to connect. Once connected, the conversation starts right away.`,
    resumeButton: 'Reopen tutorial',
    // IA pass 2026-07-25. This screen carries no tab bar, so before these
    // two it offered exactly one destination -- the Discord tutorial. A user
    // who picked "later" could not reach settings or logs at all.
    openSettings: 'Settings',
    openLogs: 'Logs',
  },

  // AUTHORED (not in copy file) -- generic infra-failure banner for
  // unexpected server errors (network down, disk write failure, etc), kept
  // separate from the scripted BYOK/Discord failure copy above.
  genericError: (message) => `Error: ${message}`,
}
