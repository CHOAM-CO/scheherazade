// onboarding/harness-render.cjs — substrate rendering + config/harness
// seeding (issue #9 PR-3, design §1 group 10). The boot-seed layer that
// lived in http-server.cjs as a non-route concern: first-run config seeding
// (seedConfigFromTemplates), the ~/.claude.json first-run gates
// (ensureClaudeOnboardingDone), harness rendering for both the
// onboarding-complete path (renderAgentSubstrate) and the every-boot
// refresh path (refreshHarnessIfOnboarded), and the harness-failure marker
// trio main.cjs gates spawn on.
//
// Same bodies-only contract as onboarding/routes/*.cjs (PR-2): every
// function body moved VERBATIM; shared singletons (log, toUnpackedPath,
// readAgentConfig, ensureConfigDir, the CONFIG_DIR target paths) keep
// exactly one owner in http-server.cjs and bind ONCE via
// createHarnessRender(ctx). Constants used ONLY by this layer (template
// paths, SETTINGS_LOCAL_PATH, agents dirs, REAL_CLAUDE_JSON_PATH,
// HARNESS_FAILURE_PATH) moved here with their comments. This module must
// NEVER require http-server.cjs back — a require cycle hands it an
// incomplete exports snapshot; everything flows through ctx.
//
// SOURCE-TEXT-PINNED TESTS read THIS file's raw source (design §3 "easy-to-
// miss pin" class — they silently print FAIL, never throw, when the matched
// text moves):
//   - tests/test-hooks-port.mjs extracts and re-runs the bash-hook port /
//     boot-diet removal migration regexes below, and pins their relative
//     order via indexOf on the CONST NAMES -- which is why this header
//     deliberately never spells those two names out: the first occurrence
//     must stay the real declaration, not prose;
//   - tests/test-context-gauge.mjs pins the GAUGE_HOOK additive migration
//     (both event groups);
//   - tests/test-attach-topology.mjs pins the attach-bootstrap.sh /
//     sudo-askpass.sh 0o700 render lines.
// Moving or rewording those literals means updating those tests IN THE SAME
// commit, and re-reading their per-line output, not just the exit code.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const crypto = require('node:crypto')
const agentIdentity = require('./agent-identity.cjs')

// Tone as a bare English word ("formal") was too weak an instruction for
// non-frontier models: a real tester picked Formal and got 반말 anyway
// (2026-08-04 external tester #4). The word stays for display; this block
// spells out what the register MEANS, per language, so the model has an
// explicit rule instead of a vibe to infer.
const TONE_GUIDANCE = {
  formal: 'Formal means a polite, professional register at all times: in Korean, every message uses 존댓말 (해요체 or 합니다체) — never 반말; in English, full sentences and no slang.',
  casual: 'Casual means a relaxed, friendly register: in Korean, 반말 is fine unless the person consistently uses 존댓말 — then mirror them; in English, contractions and everyday words.',
}

// Hand-wrap a computed paragraph to the width of the document it lands in.
//
// Every harness template is hand-wrapped by a human near a column that varies
// per document (~70 in the system prompt, ~78 in the manual, ~75 in CLAUDE.md),
// and the platform blocks below are BUILT rather than typed -- one extra skill
// name or a longer credential-store word would otherwise render a 120-column
// line in the middle of an otherwise wrapped file. `indent` is the hanging
// indent for a markdown bullet's continuation lines, so a block can be dropped
// into a `- **Label.** ...` list and keep the list's shape.
function wrapParas(paras, { width = 70, indent = '' } = {}) {
  return paras.map((text) => {
    const lines = []
    let line = ''
    for (const word of String(text).split(/\s+/).filter(Boolean)) {
      // The first line carries the caller's own prefix; every later line pays
      // for the indent, so the budget shrinks after the first break.
      const budget = width - (lines.length === 0 ? 0 : indent.length)
      if (line && line.length + 1 + word.length > budget) { lines.push(line); line = word }
      else line = line ? `${line} ${word}` : word
    }
    if (line) lines.push(line)
    return lines.map((l, i) => (i === 0 ? l : indent + l)).join('\n')
  }).join('\n\n')
}

function createHarnessRender(ctx) {
  const {
    log, toUnpackedPath, readAgentConfig, ensureConfigDir,
    REPO_ROOT, AGENT_NAME, DATA_HOME, CONFIG_DIR,
    AGENT_CONFIG_PATH, ENV_PATH, MCP_JSON_PATH,
  } = ctx
  // The host capability table (design-0023 P4). Injectable so a test can
  // render the Windows or Linux harness from a Mac -- which is the only way
  // "no bash helpers on Windows" is ever actually verified, since nothing in
  // this repo's suite runs on a Windows box on the way to a release.
  const HOST = ctx.HOST || require('./platform.cjs').host()

  // Read-only TEMPLATES checked into the repo (and therefore inside app.asar
  // once packaged -- see package.json's build.files, which now explicitly
  // includes .mcp.json for exactly this reason). Seeded into CONFIG_DIR on
  // first run only, by seedConfigFromTemplates() below; every write after
  // that targets CONFIG_DIR exclusively, and these template paths are never
  // written to. .env and .agent-config have no checked-in template today
  // (both are gitignored, deliberately -- shipping a real .env would leak
  // whatever secrets the person who ran `npm run dist` happened to have on
  // their own machine into every distributed build). Their seed step below
  // is a safe no-op until/unless that changes; first real content comes from
  // the wizard itself (writeAgentConfig / writeEnv).
  const TEMPLATE_MCP_JSON_PATH = path.join(REPO_ROOT, '.mcp.json')
  const TEMPLATE_ENV_PATH = path.join(REPO_ROOT, '.env')
  const TEMPLATE_AGENT_CONFIG_PATH = path.join(REPO_ROOT, '.agent-config')
  // Pre-approves the tool surface the headless brain needs (Bash/Read/Edit/
  // Write/Glob/Grep + both bundled MCP servers' tools) plus
  // enableAllProjectMcpServers -- without this, claude's first headless spawn
  // (run.sh -> expect -> claude, cwd == CONFIG_DIR) shows an interactive "New
  // MCP server found -- approve?" trust prompt with no one to answer it, and
  // the expect script's timeout/pattern list doesn't cover that prompt text
  // (see run.sh's own EXPECT_EOF block), so the agent hangs forever instead
  // of ever reaching channel.mjs. Also carries the SessionStart/Stop hook
  // wiring docs/ARCHITECTURE.md's Hook System section describes (memory
  // restore + felt/checkpoint nudges) -- see seedSettingsLocal() for the
  // {AGENT_DIR} render that makes those hook paths resolve in both the
  // packaged and CLI deployments. Deliberately lives under onboarding/
  // templates/ and NOT at a real .claude/settings.local.json path: a common
  // GLOBAL gitignore rule (`**/.claude/settings.local.json`, e.g. in
  // ~/.config/git/ignore) would silently mark a repo-root .claude/ copy as
  // untracked -- shipping fine from a dev's working tree tonight but MISSING
  // from a fresh clone / CI checkout, silently no-op-ing the seed and
  // re-hanging. onboarding/** is already in package.json's build.files, so
  // this tracked path ships with no extra build wiring.
  const TEMPLATE_SETTINGS_LOCAL_PATH = path.join(REPO_ROOT, 'onboarding', 'templates', 'claude-settings.local.json')
  const SETTINGS_LOCAL_PATH = path.join(CONFIG_DIR, '.claude', 'settings.local.json')

  // Harness-refresh failure marker (harness-refresh issue #6). Boot re-renders the
  // harness (CLAUDE.md / ONTOLOGY_GUIDE.md / system_prompt.md / bootstrap
  // scripts) for already-onboarded installs. That refresh used to log an error
  // and continue, so a failed render meant the agent ran against whatever was
  // on disk with the fact visible only in a log nobody reads at boot. This file
  // is the durable record: written on failure, deleted on success, and checked
  // by main.cjs before it will spawn.
  const HARNESS_FAILURE_PATH = path.join(DATA_HOME, '.harness-failed')

  // Seeds a writable CONFIG_DIR file from its checked-in (read-only, asar-
  // safe) template the first time this app ever runs on a machine. No-op if
  // the target already exists (never clobbers a user's live config) or if
  // there is no template to seed from (see TEMPLATE_* comment above).
  function seedConfigFromTemplate(templatePath, targetPath) {
    if (fs.existsSync(targetPath)) return
    if (!fs.existsSync(templatePath)) return
    ensureConfigDir()
    fs.copyFileSync(templatePath, targetPath)
    log(`seeded ${path.basename(targetPath)} into CONFIG_DIR from bundled template`)
  }

  // settings.local.json gets its own seeder (not the plain copy above) for two
  // reasons: (1) it nests one level deeper at CONFIG_DIR/.claude/, and (2) its
  // hook commands carry a {AGENT_DIR} placeholder that has to be rendered to a
  // real, executable hook-script location. {AGENT_DIR} -> toUnpackedPath(
  // REPO_ROOT): in a packaged build REPO_ROOT is inside app.asar (read-only,
  // and bash cannot exec a script from the asar virtual FS), so it is mapped
  // to app.asar.unpacked, where package.json's asarUnpack now ships hooks/**
  // as real files. Off-asar (dev / CLI) toUnpackedPath() is a no-op and this
  // resolves to the plain repo root. setup.sh's own render() applies the exact
  // same {AGENT_DIR} substitution for its CLI-deployment copy, so both seed
  // paths produce working absolute hook paths. Seeds only when absent -- never
  // clobbers a user's edited hooks/permissions.
  // Substitute INSIDE the parsed object, never in the raw text. A Windows
  // REPO_ROOT is 'C:\Users\...\app.asar.unpacked'; spliced into the template
  // text its backslashes become invalid JSON escapes ('\U'), so the file we
  // just wrote no longer parses. Claude Code then reads no settings at all --
  // every hook silently dead, the MCP allowlist gone -- and
  // ensureSettingsLocalAdditions() below hits its own JSON.parse catch, so the
  // install never self-heals. JSON.stringify escapes the backslashes for us.
  // (Found 2026-08-03 on the first real Windows pass; reproduced as
  // "SyntaxError: Bad escaped character in JSON".)
  function renderPlaceholders(node, agentDir) {
    if (typeof node === 'string') return node.split('{AGENT_DIR}').join(agentDir)
    if (Array.isArray(node)) return node.map((v) => renderPlaceholders(v, agentDir))
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = renderPlaceholders(v, agentDir)
      return out
    }
    return node
  }

  function seedSettingsLocal() {
    if (fs.existsSync(SETTINGS_LOCAL_PATH)) return
    if (!fs.existsSync(TEMPLATE_SETTINGS_LOCAL_PATH)) return
    let template
    try {
      template = JSON.parse(fs.readFileSync(TEMPLATE_SETTINGS_LOCAL_PATH, 'utf8'))
    } catch (err) {
      // The template is ours and ships in the asar, so this is a build defect,
      // not user data. Loud and non-fatal: onboarding stays usable.
      console.error(`[scheherazade/onboarding] bundled settings.local.json template is not valid JSON, not seeding: ${err.message}`)
      return
    }
    const rendered = JSON.stringify(renderPlaceholders(template, toUnpackedPath(REPO_ROOT)), null, 2)
    fs.mkdirSync(path.dirname(SETTINGS_LOCAL_PATH), { recursive: true })
    fs.writeFileSync(SETTINGS_LOCAL_PATH, rendered)
    log('seeded settings.local.json into CONFIG_DIR/.claude (hook paths rendered) from bundled template')
  }

  // Additive-only settings.local.json migration for EXISTING installs.
  // seedSettingsLocal() above is seed-if-absent by design (never clobbers user
  // edits), which means a hook added to the bundled template after a user's
  // first run would never reach them -- the exact "disk updated, config
  // frozen" half-update class diagnosed live on the owner's install 2026-07-13.
  // This runs on every boot and ONLY appends known-missing entries; it never
  // removes or rewrites anything the user has, so hand-edited hooks and
  // permissions survive. Currently migrates:
  //   - permissions.allow += mcp__agent-channel__send_file_to_discord
  //   - hooks.Stop += stop-reply-guard.mjs (silent-text regression detector,
  //     added after the agent composed replies without calling the reply tool
  //     and looked dead from Discord)
  //   - hooks.PreToolUse += pre-reply-negation-check.mjs (v0.0.4)
  //   - bash hook commands -> node .mjs ports (win-port Phase 3; the .sh
  //     files were deleted from the bundle, see the rewrite block below for
  //     why this one is a rewrite rather than an addition)
  function ensureSettingsLocalAdditions() {
    if (!fs.existsSync(SETTINGS_LOCAL_PATH)) return // fresh install: seeder covers it
    let settings
    try {
      settings = JSON.parse(fs.readFileSync(SETTINGS_LOCAL_PATH, 'utf8'))
    } catch (err) {
      // Fail-loud but non-fatal: overwriting a corrupt (possibly hand-edited)
      // file would destroy user configuration to fix a hook.
      console.error(`[scheherazade/onboarding] settings.local.json is not valid JSON, skipping additive migration: ${err.message}`)
      return
    }
    // Snapshot BEFORE mutation -- the in-place mutations below alias the parsed
    // object, so a post-mutation snapshot would always equal the result and the
    // write would silently never happen (same aliasing bug class as
    // ensureMcpJsonAgentName's 2026-07-03 fix in http-server.cjs).
    const beforeText = JSON.stringify(settings, null, 2)

    if (!settings.permissions || typeof settings.permissions !== 'object') settings.permissions = {}
    if (!Array.isArray(settings.permissions.allow)) settings.permissions.allow = []
    const SEND_FILE_PERM = 'mcp__agent-channel__send_file_to_discord'
    if (!settings.permissions.allow.includes(SEND_FILE_PERM)) settings.permissions.allow.push(SEND_FILE_PERM)

    // v0.0.34 (DM interactions): the react tool on the local backend --
    // allowlist entry only, no hook rides it (an emoji cannot carry the
    // completion-claim class the rumination gate exists for).
    const REACT_PERM = 'mcp__agent-channel__react'
    if (!settings.permissions.allow.includes(REACT_PERM)) settings.permissions.allow.push(REACT_PERM)

    // v0.0.41: the routine tool (user-requested scheduled prompts) --
    // allowlist entry only. The consent for each routine is the user's own
    // request in conversation; no hook needed on registration.
    const ROUTINE_PERM = 'mcp__agent-channel__routine'
    if (!settings.permissions.allow.includes(ROUTINE_PERM)) settings.permissions.allow.push(ROUTINE_PERM)

    if (!settings.hooks || typeof settings.hooks !== 'object') settings.hooks = {}
    if (!Array.isArray(settings.hooks.Stop)) settings.hooks.Stop = []
    if (settings.hooks.Stop.length === 0) settings.hooks.Stop.push({ hooks: [] })
    const stopGroup = settings.hooks.Stop[0]
    if (!Array.isArray(stopGroup.hooks)) stopGroup.hooks = []
    const hasReplyGuard = settings.hooks.Stop.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes('stop-reply-guard.mjs')))
    if (!hasReplyGuard) {
      stopGroup.hooks.push({
        type: 'command',
        command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', 'stop-reply-guard.mjs')}`,
      })
    }

    // v0.0.4: negation-check on the reply tool (denial gate -- see the hook's
    // own header). Appends into the existing mcp__agent-channel__reply
    // PreToolUse matcher group when present; creates the group when a user
    // config predates PreToolUse entirely. Same additive-only contract.
    if (!Array.isArray(settings.hooks.PreToolUse)) settings.hooks.PreToolUse = []
    const NEGATION_HOOK = 'pre-reply-negation-check.mjs'
    const hasNegation = settings.hooks.PreToolUse.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(NEGATION_HOOK)))
    if (!hasNegation) {
      let replyGroup = settings.hooks.PreToolUse.find((g) => g && g.matcher === 'mcp__agent-channel__reply')
      if (!replyGroup) {
        replyGroup = { matcher: 'mcp__agent-channel__reply', hooks: [] }
        settings.hooks.PreToolUse.push(replyGroup)
      }
      if (!Array.isArray(replyGroup.hooks)) replyGroup.hooks = []
      replyGroup.hooks.push({
        type: 'command',
        command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', NEGATION_HOOK)}`,
      })
    }

    // v0.0.12: permission-wall translator on Bash results -- silence-during-
    // diagnosis killer; see the hook's header. Same additive-only contract as
    // the negation block above. (history: docs/HISTORY.md)
    const TRANSLATOR_HOOK = 'post-bash-permission-translator.mjs'
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = []
    const hasTranslator = settings.hooks.PostToolUse.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(TRANSLATOR_HOOK)))
    if (!hasTranslator) {
      let bashGroup = settings.hooks.PostToolUse.find((g) => g && g.matcher === 'Bash')
      if (!bashGroup) {
        bashGroup = { matcher: 'Bash', hooks: [] }
        settings.hooks.PostToolUse.push(bashGroup)
      }
      if (!Array.isArray(bashGroup.hooks)) bashGroup.hooks = []
      bashGroup.hooks.push({
        type: 'command',
        command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', TRANSLATOR_HOOK)}`,
      })
    }

    // v0.0.33 (design 0017): receipt ledger on Bash results -- the evidence
    // side of the rumination gate's new evidence branch. Advisory writer,
    // additive-only, same contract as the translator block above.
    const LEDGER_HOOK = 'post-bash-receipt-ledger.mjs'
    const hasLedger = settings.hooks.PostToolUse.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(LEDGER_HOOK)))
    if (!hasLedger) {
      let bashGroup = settings.hooks.PostToolUse.find((g) => g && g.matcher === 'Bash')
      if (!bashGroup) {
        bashGroup = { matcher: 'Bash', hooks: [] }
        settings.hooks.PostToolUse.push(bashGroup)
      }
      if (!Array.isArray(bashGroup.hooks)) bashGroup.hooks = []
      bashGroup.hooks.push({
        type: 'command',
        command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', LEDGER_HOOK)}`,
      })
    }

    // v0.0.41: activity feed on tool starts (PreToolUse) -- pushes "what is
    // about to run" into the local channel transcript so the chat page can
    // show work instead of silence. Advisory, fail-open, local backend only
    // (the hook itself no-ops when no port file exists).
    //
    // MATCHER IS PINNED, NOT ADDITIVE (unlike the blocks above): the tool set
    // widened twice after ship (WebSearch/WebFetch/subagents 2026-08-13;
    // PowerShell -- the shell tool's name on native Windows -- 2026-08-14,
    // the Windows box live repro where matcher "Bash" never fired at all), and the
    // add-if-missing contract cannot retrofit a matcher on an existing
    // install -- that is exactly how the Windows box stayed Bash-only through an app
    // update that carried the wider template. If the hook shares a group with
    // other hooks (the pre-fix migration parked it in the "Bash" group), it
    // is extracted into its own group first so the pin never widens a
    // neighbor's trigger.
    const ACTIVITY_HOOK = 'pre-tool-activity.mjs'
    const ACTIVITY_MATCHER = 'Bash|PowerShell|WebSearch|WebFetch|Agent|Task'
    const isActivityHook = (h) => h && typeof h.command === 'string' && h.command.includes(ACTIVITY_HOOK)
    const activityGroup = settings.hooks.PreToolUse.find((g) =>
      g && Array.isArray(g.hooks) && g.hooks.some(isActivityHook))
    if (!activityGroup) {
      settings.hooks.PreToolUse.push({
        matcher: ACTIVITY_MATCHER,
        hooks: [{
          type: 'command',
          command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', ACTIVITY_HOOK)}`,
        }],
      })
    } else if (activityGroup.matcher !== ACTIVITY_MATCHER) {
      if (activityGroup.hooks.length === 1) {
        activityGroup.matcher = ACTIVITY_MATCHER
      } else {
        const entry = activityGroup.hooks.find(isActivityHook)
        activityGroup.hooks = activityGroup.hooks.filter((h) => !isActivityHook(h))
        settings.hooks.PreToolUse.push({ matcher: ACTIVITY_MATCHER, hooks: [entry] })
      }
    }

    // 2026-09-28: the memory mark's registration -- the SAME hook file on a
    // SECOND matcher. The memory-read tools post POST /memory-read (a flag the
    // next reply carries) and build no activity label, so they must never ride
    // the activity matcher pinned above: that would put a memory read in the
    // user's fold as a row saying nothing, on every boot. ADDITIVE (its own
    // group is a new trigger, never a neighbor's), and pinned by matcher
    // equality rather than by hook file -- the `find` above would otherwise
    // pick the activity group and wrongly conclude this registration exists.
    const MEMORY_READ_MATCHER = 'mcp__memory__memory_query|mcp__memory__journal_read|mcp__memory__memory_recall_material'
    const hasMemoryReadMatcher = settings.hooks.PreToolUse.some((g) => g && g.matcher === MEMORY_READ_MATCHER)
    if (!hasMemoryReadMatcher) {
      settings.hooks.PreToolUse.push({
        matcher: MEMORY_READ_MATCHER,
        hooks: [{
          type: 'command',
          command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', ACTIVITY_HOOK)}`,
        }],
      })
    }

    // v0.0.41: AskUserQuestion redirect (the owner live repro 2026-08-04) -- the
    // interactive picker renders in a terminal the person never sees, so the
    // agent stalls silently mid-task waiting for an Enter that never comes.
    // The hook denies with a redirect: re-ask the same question through the
    // reply tool as numbered plain text. Blocking-by-decision but fail-open
    // on internal error; same additive-only contract as the blocks above.
    const ASK_REDIRECT_HOOK = 'pre-ask-user-question-redirect.mjs'
    const hasAskRedirect = settings.hooks.PreToolUse.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(ASK_REDIRECT_HOOK)))
    if (!hasAskRedirect) {
      let askGroup = settings.hooks.PreToolUse.find((g) => g && g.matcher === 'AskUserQuestion')
      if (!askGroup) {
        askGroup = { matcher: 'AskUserQuestion', hooks: [] }
        settings.hooks.PreToolUse.push(askGroup)
      }
      if (!Array.isArray(askGroup.hooks)) askGroup.hooks = []
      askGroup.hooks.push({
        type: 'command',
        command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', ASK_REDIRECT_HOOK)}`,
      })
    }

    // v0.1.11: vision guard on Read -- hard-blocks image/PDF reads on lanes
    // whose model cannot see them (the 400-every-turn transcript-poison
    // wedge; see the hook's own header). The hook itself stands down unless
    // the spawn env says SCHEHERAZADE_LANE_VISION=no, so arming it
    // everywhere is safe for vision lanes. Additive-only, own 'Read' group
    // (the credential guard's Read|Glob|Grep group is a different trigger
    // contract -- never widen a neighbor's).
    const VISION_GUARD_HOOK = 'pre-tool-vision-guard.mjs'
    const hasVisionGuard = settings.hooks.PreToolUse.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(VISION_GUARD_HOOK)))
    if (!hasVisionGuard) {
      settings.hooks.PreToolUse.push({
        matcher: 'Read',
        hooks: [{
          type: 'command',
          command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', VISION_GUARD_HOOK)}`,
        }],
      })
    }

    // v0.0.22: context-gauge tap on Stop + SessionStart -- advisory
    // instrument, additive-only, both event groups checked independently so
    // a hand-edited config missing only one still converges. See the hook's
    // header for the mechanism. (history: docs/HISTORY.md)
    const GAUGE_HOOK = 'context-gauge.mjs'
    const gaugeCommand = `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', GAUGE_HOOK)}`
    const hasGaugeIn = (groups) => Array.isArray(groups) && groups.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(GAUGE_HOOK)))
    if (!hasGaugeIn(settings.hooks.Stop)) {
      // stopGroup already normalized above (reply-guard block)
      stopGroup.hooks.push({ type: 'command', command: gaugeCommand })
    }
    if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = []
    if (settings.hooks.SessionStart.length === 0) settings.hooks.SessionStart.push({ hooks: [] })
    if (!hasGaugeIn(settings.hooks.SessionStart)) {
      const ssGroup = settings.hooks.SessionStart[0]
      if (!Array.isArray(ssGroup.hooks)) ssGroup.hooks = []
      ssGroup.hooks.push({ type: 'command', command: gaugeCommand })
    }

    // win-port Phase 3: the 3 bash hooks were ported to .mjs and the .sh
    // files DELETED from the bundle -- an existing install's settings still
    // says `bash .../hooks/session-start.sh`, which now fails on every fire
    // (session-start dying = the boot restore summary silently gone). This is
    // the one place the additive-only contract allows a REWRITE: only
    // commands matching the exact seeded shape `bash <path>/hooks/<one of
    // the 3>.sh` are touched, and they point at files that no longer exist,
    // so there is nothing of the user's to preserve. Hand-edited commands
    // that don't match the shape are left alone.
    const BASH_HOOK_PORT = /^bash .*[\\/]hooks[\\/](session-start|felt-check|checkpoint-nudge)\.sh$/
    for (const groups of Object.values(settings.hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        if (!group || !Array.isArray(group.hooks)) continue
        for (const h of group.hooks) {
          if (typeof h.command !== 'string') continue
          const m = h.command.match(BASH_HOOK_PORT)
          if (m) h.command = `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', `${m[1]}.mjs`)}`
        }
      }
    }

    // Boot-context diet (2026-07-28): felt-check + stop-skill-extraction-nudge
    // were cut from the Stop lane (advisory nags; the Felt discipline itself
    // stays in CLAUDE.md §2) and their files DELETED from the bundle. Like the
    // BASH_HOOK_PORT rewrite above, this touches only commands matching the
    // exact seeded shape pointing at files that no longer exist — so removal
    // never fights a user's intent: a hand-re-added command in this shape is
    // dead anyway (the file is gone), and anything not matching the shape is
    // left alone. Runs AFTER the bash rewrite on purpose: a pre-port
    // `bash .../felt-check.sh` first becomes `node .../felt-check.mjs`, then
    // falls to this filter — one boot converges either starting point.
    const DIET_REMOVED_HOOKS = /^node .*[\\/]hooks[\\/](felt-check|stop-skill-extraction-nudge)\.mjs$/
    for (const groups of Object.values(settings.hooks)) {
      if (!Array.isArray(groups)) continue
      for (const group of groups) {
        if (!group || !Array.isArray(group.hooks)) continue
        group.hooks = group.hooks.filter((h) => !(typeof h.command === 'string' && DIET_REMOVED_HOOKS.test(h.command)))
      }
    }

    // v0.1.14 (identity-bleed bug, vector #2 — 2026-08-16 the Windows box live repro): the
    // claude CLI auto-loads the USER-GLOBAL ~/.claude/CLAUDE.md memory into
    // every session. This app deliberately spawns against the user's real
    // config dir (auth reuse — provider-env.cjs sets no CLAUDE_CONFIG_DIR),
    // so a persona living in that file (the Windows box: a retired agent's "나는
    // 아르타반" identity block) rides into the agent session and BEATS the
    // rendered system-prompt identity line — the 0.1.13 journal firewall
    // never saw this vector. claudeMdExcludes patterns are matched against
    // absolute paths; both slash forms are appended because Windows path
    // normalization inside the matcher is undocumented (setting verified
    // present in CLI bundles 2.1.220 win / 2.1.233 mac). Additive-only:
    // user-added patterns survive, ours append once. The agent's own
    // project CLAUDE.md (DATA_HOME) is untouched by design — this excludes
    // exactly one file, the machine-global one that belongs to whoever else
    // uses claude on this machine, never to this agent.
    if (!Array.isArray(settings.claudeMdExcludes)) settings.claudeMdExcludes = []
    const userClaudeMd = path.join(os.homedir(), '.claude', 'CLAUDE.md')
    for (const p of new Set([userClaudeMd, userClaudeMd.split(path.sep).join('/')])) {
      if (!settings.claudeMdExcludes.includes(p)) settings.claudeMdExcludes.push(p)
    }

    // v0.1.18 (같이보기 batch, the owner 2026-08-19: "최근에 건드린 파일들 리스트"):
    // file ledger on the file-writing tools. New matcher group — the Bash
    // group must not widen (its two hooks parse Bash-shaped payloads).
    // Additive-only, same contract as every block above; without this branch
    // no EXISTING install ever gets the hook (design-0017 §Rollout rule).
    const FILE_LEDGER_HOOK = 'post-tool-file-ledger.mjs'
    if (!Array.isArray(settings.hooks.PostToolUse)) settings.hooks.PostToolUse = []
    const hasFileLedger = settings.hooks.PostToolUse.some((group) =>
      Array.isArray(group.hooks) && group.hooks.some((h) => typeof h.command === 'string' && h.command.includes(FILE_LEDGER_HOOK)))
    if (!hasFileLedger) {
      settings.hooks.PostToolUse.push({
        matcher: 'Write|Edit|MultiEdit|NotebookEdit',
        hooks: [{
          type: 'command',
          command: `node ${path.join(toUnpackedPath(REPO_ROOT), 'hooks', FILE_LEDGER_HOOK)}`,
        }],
      })
    }

    const afterText = JSON.stringify(settings, null, 2)
    if (afterText !== beforeText) {
      fs.writeFileSync(SETTINGS_LOCAL_PATH, afterText + '\n')
      log('settings.local.json additive migration applied (send_file permission / stop-reply-guard hook / bash-hook .mjs port / user-CLAUDE.md exclusion)')
    }
  }

  // Subagent definitions (v0.0.4 item b): templates/agents/*.md ->
  // CONFIG_DIR/.claude/agents/. Per-file seed-if-absent, same contract as the
  // other seeds -- a user who edited a definition keeps their edit; NEW
  // definitions added in later app versions still arrive because absence is
  // checked per file, not per directory.
  const TEMPLATE_AGENTS_DIR = path.join(REPO_ROOT, 'onboarding', 'templates', 'agents')
  const AGENTS_DIR = path.join(CONFIG_DIR, '.claude', 'agents')

  function seedAgentDefinitions() {
    if (!fs.existsSync(TEMPLATE_AGENTS_DIR)) return
    let entries
    try {
      entries = fs.readdirSync(TEMPLATE_AGENTS_DIR).filter((f) => f.endsWith('.md'))
    } catch (err) {
      console.error(`[scheherazade/onboarding] cannot read agent templates dir: ${err.message}`)
      return
    }
    for (const name of entries) {
      const target = path.join(AGENTS_DIR, name)
      if (fs.existsSync(target)) continue
      // tmp+rename (atomic on same volume) + per-file catch: an interrupted
      // plain copyFileSync leaves a truncated file that the exists-check
      // treats as "seeded" forever, and one throwing file used to abort the
      // whole seedConfigFromTemplates() boot path.
      try {
        fs.mkdirSync(AGENTS_DIR, { recursive: true })
        const tmp = `${target}.tmp`
        fs.copyFileSync(path.join(TEMPLATE_AGENTS_DIR, name), tmp)
        fs.renameSync(tmp, target)
        log(`seeded subagent definition ${name} into .claude/agents`)
      } catch (err) {
        console.error(`[scheherazade/onboarding] seeding subagent ${name} failed (continuing): ${err.message}`)
      }
    }
  }

  // Default skills (v0.0.41): onboarding/templates/skills/<name>/SKILL.md is
  // seeded to CONFIG_DIR/.claude/skills/<name>/SKILL.md. Claude Code loads
  // .claude/skills natively, so shipping a skill is pure seeding — zero
  // runtime code. Same seed-if-absent contract as agent definitions: absence
  // is checked per skill FILE, so a user who edited a skill keeps their
  // edit while genuinely new skills from later app versions still arrive
  // (a deleted skill therefore comes back on next boot, same as agents —
  // "don't want it" is expressed by editing, e.g. emptying, not deleting).
  // Deliberately NO keyword auto-inject layer (Aside-style
  // autoInject) — the skill description is the discovery surface.
  const TEMPLATE_SKILLS_DIR = path.join(REPO_ROOT, 'onboarding', 'templates', 'skills')
  const SKILLS_DIR = path.join(CONFIG_DIR, '.claude', 'skills')

  // v0.1.11: seeding upgraded from copy-if-missing to OVERWRITE-IF-PRISTINE
  // (pattern: stablyai/orca's snapshot registry — see internal
  // research notes 2026-08-14 Part 2). copy-if-missing meant a
  // skill fix shipped in an app update never reached an existing install
  // (live case: c361e52's bot-check fallback never landing on the Windows box).
  // The manifest (skill-hashes.json, generated by tools/gen-skill-hashes.mjs
  // from git history and committed) records the normalized sha256 of EVERY
  // version of every seeded skill file this repo has ever shipped. Boot
  // tri-state per file:
  //   - hash == current template        → up to date, leave
  //   - hash ∈ historical manifest set  → provably pristine-but-stale →
  //     safe to overwrite with the current template
  //   - hash matches nothing            → user-edited → the WHOLE skill is
  //     withheld from refresh (Orca semantics: skill-granular, no merge) and
  //     logged; the user's "don't want it = edit it, not delete it" contract
  //     from the copy-if-missing era still holds
  // Hashing is CRLF/CR→LF normalized (a Windows checkout or editor line-ending
  // save must not read as "modified"). Files the user ADDED inside a skill dir
  // are never touched — refresh writes shipped files individually (tmp+rename)
  // instead of replacing the directory. Without a manifest (old build layouts)
  // the behavior degrades to exactly the old copy-if-missing.
  const SKILL_HASH_MANIFEST_PATH = path.join(REPO_ROOT, 'onboarding', 'templates', 'skill-hashes.json')

  function normalizedSkillHash(buf) {
    const text = buf.toString('utf8').replace(/\r\n/g, '\n').replace(/\r/g, '\n')
    return crypto.createHash('sha256').update(text).digest('hex')
  }

  function loadSkillHashManifest() {
    try {
      const parsed = JSON.parse(fs.readFileSync(SKILL_HASH_MANIFEST_PATH, 'utf8'))
      if (parsed && parsed.schema === 1 && parsed.files && typeof parsed.files === 'object') {
        return parsed.files
      }
    } catch { /* absent or unreadable -> legacy copy-if-missing */ }
    return null
  }

  // One skill = one decision. files = [{ src, rel }] of the SHIPPED files;
  // manifest = loadSkillHashManifest() result (null = legacy mode).
  function refreshSkillFromFiles(name, files, manifest, provenance) {
    const targetDir = path.join(SKILLS_DIR, name)
    const plan = [] // shipped files to (re)write
    let modified = false
    for (const { src, rel } of files) {
      let srcBuf
      try { srcBuf = fs.readFileSync(src) } catch { continue }
      const dst = path.join(targetDir, rel)
      let dstBuf = null
      try { dstBuf = fs.readFileSync(dst) } catch { /* missing -> seed */ }
      if (dstBuf === null) { plan.push({ srcBuf, dst }); continue }
      const dstHash = normalizedSkillHash(dstBuf)
      if (dstHash === normalizedSkillHash(srcBuf)) continue // already current
      const known = manifest && manifest[`${name}/${rel}`]
      if (Array.isArray(known) && known.includes(dstHash)) {
        plan.push({ srcBuf, dst }) // pristine old shipped version -> refresh
      } else {
        modified = true // user-edited (or legacy mode) -> withhold whole skill
      }
    }
    if (modified) {
      if (manifest) log(`skill ${name} is locally modified; template refresh withheld`)
      return
    }
    if (plan.length === 0) return
    // tmp+rename + per-skill catch, same reasons as seedAgentDefinitions:
    // a truncated copy must not read as "seeded", and one bad skill must
    // not abort the boot path.
    try {
      for (const { srcBuf, dst } of plan) {
        fs.mkdirSync(path.dirname(dst), { recursive: true })
        const tmp = `${dst}.tmp`
        fs.writeFileSync(tmp, srcBuf)
        fs.renameSync(tmp, dst)
      }
      log(`seeded/refreshed skill ${name} (${plan.length} file(s)${provenance ? `, ${provenance}` : ''})`)
    } catch (err) {
      console.error(`[scheherazade/onboarding] seeding skill ${name} failed (continuing): ${err.message}`)
    }
  }

  // design-0023 P4: the seeder ASKS THE CAPABILITY TABLE before it writes.
  // Every template skill used to land on every host, so a Windows agent was
  // handed `calendar` / `mail-briefing` / `reminders` (osascript + Mac apps)
  // and `file-organizer` (unix find/mv) -- and a seeded skill is not inert
  // decoration: Claude Code loads each SKILL.md's description into the
  // model's own inventory, so the agent was being TOLD it could read that
  // person's calendar. It picks the skill, runs osascript, and fails in
  // front of them. A skill with no row in SKILL_REQUIREMENTS is portable and
  // still seeds everywhere; the table is the only gate.
  //
  // THE UPGRADE CASE, which is the one with a real choice in it: an install
  // that already has `calendar` on disk because an older build seeded it
  // everywhere. Skipping the seed only stops NEW writes, so the stale
  // osascript skill would sit there forever on exactly the machines this
  // change exists for -- the fix would ship and change nothing. So an
  // unsupported skill is RETIRED, and the hash manifest decides whether it
  // may be: a file whose hash is in the manifest is provably a shipped
  // version the user never touched, and deleting our own artifact is not a
  // loss. Anything else -- an edit, or legacy mode with no manifest to
  // prove pristineness -- is the user's writing, and it stays, whole-skill,
  // exactly as refreshSkillFromFiles withholds a refresh.
  //
  // The alternative (leave every unsupported skill on disk and merely stop
  // seeding new ones) is worse because it is invisible: the agent keeps the
  // inventory line, keeps offering the calendar, and the only symptom is a
  // failed osascript in a transcript nobody reads. Blanket deletion is
  // worse still -- it would take a file the person edited, which is the one
  // thing the manifest gate was built to make impossible. Retire-if-
  // pristine is the only option that can be wrong in neither direction.
  function seedOrRetireSkill(name, files, manifest, provenance) {
    if (HOST.skillAllowed(name)) {
      refreshSkillFromFiles(name, files, manifest, provenance)
      return
    }
    const targetDir = path.join(SKILLS_DIR, name)
    if (!fs.existsSync(targetDir)) return // never seeded here -- nothing to say
    const doomed = []
    for (const { rel } of files) {
      const dst = path.join(targetDir, rel)
      let buf
      try { buf = fs.readFileSync(dst) } catch { continue } // not installed
      const known = manifest && manifest[`${name}/${rel}`]
      if (Array.isArray(known) && known.includes(normalizedSkillHash(buf))) {
        doomed.push(dst)
      } else {
        // Two different facts, one outcome, and the log must not conflate
        // them: either the file's hash is unknown (the person edited it) or
        // there is no manifest at all to compare against (a legacy install).
        // Both mean "we cannot prove this is our own artifact", which is the
        // bar for deleting it -- but saying "locally modified" about a
        // pristine file on a legacy install would send a reader hunting for
        // an edit that never happened.
        const why = Array.isArray(known) ? 'locally modified' : 'unprovable (no manifest entry)'
        log(`skill ${name} cannot run on ${HOST.id} but ${rel} is ${why}; left on disk untouched`)
        return
      }
    }
    if (doomed.length === 0) return
    try {
      for (const dst of doomed) fs.rmSync(dst, { force: true })
      // rmdir, never a recursive remove, deepest first: the directory goes
      // away only if nothing else is in it, so a file the user ADDED beside
      // the skill keeps both itself and the folder it lives in (same rule
      // refreshSkillFromFiles follows when it writes shipped files one by
      // one instead of replacing the tree).
      const dirs = [...new Set(doomed.map((d) => path.dirname(d)))].sort((a, b) => b.length - a.length)
      for (const dir of [...dirs, targetDir]) {
        try { fs.rmdirSync(dir) } catch { /* user content still inside */ }
      }
      log(`skill ${name} retired: ${HOST.id} has no ${HOST.SKILL_REQUIREMENTS[name]} (${doomed.length} pristine file(s) removed)`)
    } catch (err) {
      console.error(`[scheherazade/onboarding] retiring skill ${name} failed (continuing): ${err.message}`)
    }
  }

  function seedSkillDefinitions() {
    if (!fs.existsSync(TEMPLATE_SKILLS_DIR)) return
    let entries
    try {
      entries = fs.readdirSync(TEMPLATE_SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
    } catch (err) {
      console.error(`[scheherazade/onboarding] cannot read skill templates dir: ${err.message}`)
      return
    }
    const manifest = loadSkillHashManifest()
    for (const name of entries) {
      const source = path.join(TEMPLATE_SKILLS_DIR, name, 'SKILL.md')
      if (!fs.existsSync(source)) continue
      // Seeded surface stays SKILL.md-only for template skills (sidecar
      // template files like slack-app-manifest.yaml are onboarding-side
      // material, not agent-side skill content).
      seedOrRetireSkill(name, [{ src: source, rel: 'SKILL.md' }], manifest)
    }
  }

  function seedConfigFromTemplates() {
    seedConfigFromTemplate(TEMPLATE_MCP_JSON_PATH, MCP_JSON_PATH)
    seedConfigFromTemplate(TEMPLATE_ENV_PATH, ENV_PATH)
    seedConfigFromTemplate(TEMPLATE_AGENT_CONFIG_PATH, AGENT_CONFIG_PATH)
    seedSettingsLocal()
    ensureSettingsLocalAdditions()
    seedAgentDefinitions()
    seedSkillDefinitions()
  }

  // Global Claude Code CLI first-run state -- NOT part of CONFIG_DIR, and NOT
  // covered by seedConfigFromTemplate()'s copy-a-template shape. run.sh's
  // headless spawn sets no CLAUDE_CONFIG_DIR/HOME override (confirmed:
  // neither appears anywhere in run.sh or spawnRealAgentChild()'s env block
  // in main.cjs, unlike e.g. doze-portable's launcher.sh, which isolates
  // CLAUDE_CONFIG_DIR specifically because it runs in a fresh container), so
  // the spawned `claude` reads/writes the REAL user's own ~/.claude.json. On
  // a machine where the person has ever run `claude` interactively before,
  // hasCompletedOnboarding (and theme) are already set there and this is a
  // no-op. On a genuinely first-ever `claude` invocation (the exact machine
  // state setup.sh's own auto-install path can produce -- it `npm install -g
  // @anthropic-ai/claude-code`'s the CLI but never runs it interactively):
  // the CLI's own first-run "Choose the text style that looks best
  // with your terminal" picker hangs the headless expect spawn indefinitely
  // -- run.sh's `-re "text style"` pattern matches that prompt's text and
  // sends \r, but the picker does not advance on a bare \r (repeated
  // exp_continue matches just re-send \r into the same screen for the whole
  // 25s window, then expect falls through to `expect eof` with no one left
  // to answer). Same failure shape as the settings.local.json gap above, one
  // step earlier in the sequence. MERGE-ONLY: never overwrites a real,
  // existing ~/.claude.json wholesale (it can hold the user's own separate
  // interactive Claude Code state -- OAuth account info, project trust list,
  // history -- this only fills in the three keys that gate the first-run
  // prompts, and only when they aren't already satisfied).
  // (history: docs/HISTORY.md)
  const REAL_CLAUDE_JSON_PATH = path.join(os.homedir(), '.claude.json')

  function ensureClaudeOnboardingDone() {
    let existing = {}
    if (fs.existsSync(REAL_CLAUDE_JSON_PATH)) {
      try {
        existing = JSON.parse(fs.readFileSync(REAL_CLAUDE_JSON_PATH, 'utf8'))
      } catch (err) {
        log(`ensureClaudeOnboardingDone: existing ~/.claude.json is not valid JSON, leaving it untouched: ${err.message}`)
        return
      }
      // No-op only when ALL THREE first-run gates are already satisfied. The
      // fullscreen upsell has its OWN gate, independent of onboarding/theme:
      // claude skips the "Try the new fullscreen renderer?" prompt only when
      // (fullscreenUpsellSeenCount ?? 0) >= 3 (verified against the bundled CLI
      // binary: `fullscreenUpsellSeenCount??0)>=uos)return!1`, uos===3), and
      // run.sh's expect list covers none of that prompt's labels ("Yes, try
      // it"/"Not now"). So a merge that set only hasCompletedOnboarding+theme
      // still hung there on a real terminal (the pty self-test happened not to
      // surface it; a genuine TTY did). All three keys required.
      if (existing.hasCompletedOnboarding && existing.theme && (existing.fullscreenUpsellSeenCount ?? 0) >= 3) return
    }
    const merged = { ...existing, hasCompletedOnboarding: true }
    if (!merged.theme) merged.theme = 'dark'
    merged.fullscreenUpsellSeenCount = Math.max(existing.fullscreenUpsellSeenCount ?? 0, 3)
    // Atomic write: temp file in the SAME directory (so rename() is a
    // same-filesystem atomic swap) + rename, never an in-place writeFileSync.
    // A crash or a concurrent external `claude` writing this same file
    // mid-write would otherwise leave a torn/partial ~/.claude.json that
    // claude's own JSON.parse chokes on -- turning a first-run convenience
    // into a boot-fatal corruption. This does not lock against a concurrent
    // writer's lost update (inherent to a read-modify-write merge), but it
    // guarantees the file on disk is always one whole valid JSON or the other.
    const tmp = `${REAL_CLAUDE_JSON_PATH}.tmp-${process.pid}`
    fs.writeFileSync(tmp, JSON.stringify(merged, null, 2) + '\n')
    fs.renameSync(tmp, REAL_CLAUDE_JSON_PATH)
    log('seeded hasCompletedOnboarding/theme/fullscreenUpsellSeenCount into ~/.claude.json (first-run claude gates)')
  }

  // ── agent substrate rendering (app-path parity with setup.sh, 2026-07-08) ─
  // setup.sh's fuller bootstrap (CLAUDE.md / ONTOLOGY_GUIDE.md /
  // self_persona.md / checkpoint.md / memory dirs) never ran in the packaged
  // app path, so a DMG-installed agent booted with NO substrate at all: no
  // restore procedure, no dream cycle, no self-doubt loop -- just the bare
  // Claude Code default behavior. This renders the same templates setup.sh
  // renders, at onboarding-complete time, with the same
  // create-if-absent/re-render split setup.sh uses: CLAUDE.md,
  // ONTOLOGY_GUIDE.md, and system_prompt.md are harness (always re-rendered);
  // self_persona.md and checkpoint.md are the agent's own history (never
  // overwritten). {AGENT_DIR} renders to the UNPACKED repo root -- the agent
  // invokes cycle scripts with bash by absolute path, and bash cannot exec a
  // file inside app.asar (same class as http-server.cjs's toUnpackedPath
  // comment).
  // Harness-only render, extracted (07-13) so app boot can re-render harness
  // files for EXISTING installs when the app updates -- previously harness
  // files only refreshed at onboarding-complete time, so a shipped CLAUDE.md
  // fix (e.g. the §10 memory-write rules) never reached installs that had
  // already onboarded. Harness files are "always re-rendered" by design (see
  // the create-if-absent/re-render split comment above); this just adds a
  // second call site with the same semantics. Never touches self_persona.md /
  // checkpoint.md.
  // ALL-OR-NOTHING (harness-refresh issue #6). This used to read, render and write each
  // file in turn, so a template that failed to read partway through left a
  // MIXED harness on disk: a new CLAUDE.md beside an old system_prompt.md. The
  // old log line called that "stale", which is the wrong word for a worse
  // state -- stale is at least internally consistent. Every source is now read
  // and rendered before anything is written, so a read or render failure
  // leaves the previous harness completely intact. The writes then go to .tmp
  // siblings and rename into place, which is atomic per file and collapses the
  // remaining window to the (disk-full class) case.
  // opts are test seams (tests/test-harness-refresh.mjs), same shape as
  // resolveOutboundChannel's in channel.mjs: production call sites pass nothing
  // and get real fs. Needed because the two failures worth pinning here (a
  // template that cannot be READ, and a harness file that cannot be WRITTEN)
  // are otherwise only reachable by breaking the repo or the disk.
  function renderHarnessFiles({ displayName, tone, primaryTask }, opts = {}) {
    const readFileFn = opts.readFileFn || fs.readFileSync
    const writeFileFn = opts.writeFileFn || fs.writeFileSync
    const agentDir = toUnpackedPath(REPO_ROOT)
    const staged = []
    // Computed once for the whole render: the blocks are a function of the
    // host, not of the document, so every template sees the same answers.
    const docBlocks = platformDocBlocks()
    const renderHarness = (srcName, dstName, mode) => {
      const src = readFileFn(path.join(REPO_ROOT, srcName), 'utf8')
      let rendered = src
        .replaceAll('{AGENT_DIR}', agentDir)
        .replaceAll('{AGENT_NAME}', AGENT_NAME)
        .replaceAll('{MEMORY_DIR}', DATA_HOME)
        // {EXEC_PATH} = this app's own runtime (design-0023 P3). The attach
        // bootstrap execs it as node on supervisor.mjs, so a user-run pane and
        // an app-spawned child are the SAME command line; re-rendered every
        // boot, so an app move or update repoints it.
        .replaceAll('{EXEC_PATH}', process.execPath)
      // Per-platform bodies (design-0023 P4 tail). Applied to EVERY harness
      // template rather than to a named list, for the same reason the four
      // above are: a document that does not carry a placeholder is untouched,
      // and a new document can use one without a second wiring edit.
      for (const [name, body] of Object.entries(docBlocks)) {
        rendered = rendered.replaceAll(`{${name}}`, body)
      }
      staged.push({ dstName, rendered, mode })
    }

    renderHarness('CLAUDE.md', 'CLAUDE.md')
    renderHarness('ONTOLOGY_GUIDE.md', 'ONTOLOGY_GUIDE.md')
    // Trigger-load procedure files (boot-context diet, 2026-07-28): the
    // journal-compression / persona-reflux / madoromi procedure bodies moved
    // out of CLAUDE.md into files the agent Reads at the moment of use, so
    // they stop costing every boot. Same harness semantics as CLAUDE.md
    // (always re-rendered, never the agent's own history).
    fs.mkdirSync(path.join(DATA_HOME, 'procedures'), { recursive: true })
    // Diet round 2+3 (2026-08-19, the owner "3~5kb 수준까지, 레이지로딩"): CLAUDE.md
    // became a ~4.5KB index of headline rules; every section BODY now lives
    // here and loads at its trigger moment. boot/notes-and-memory/anchors/
    // autonomy-and-paths carry the former §1/1b/2/10, §6/7, §8/12/13.
    for (const proc of ['journal-compression.md', 'persona-reflux.md', 'madoromi.md', 'memory-consolidation.md', 'delegation.md', 'machine.md', 'boot.md', 'notes-and-memory.md', 'anchors.md', 'autonomy-and-paths.md']) {
      renderHarness(path.join('procedures', proc), path.join('procedures', proc))
    }
    // Attach-topology bootstrap (0.1.0 prep): harness-rendered so RUN_SH/MEM
    // paths always match the installed app version. Executed only ever by the
    // USER in their terminal -- the app renders the file, never runs it (TCC
    // attribution must descend from the terminal, see the template's header).
    // The app's own manual, rendered rather than shipped in docs/: a file
    // inside app.asar exists and cannot be opened by the agent, which is a
    // separate `claude` process reading real paths (same class as the
    // toUnpackedPath comment above). Built it into docs/ first and the dmg
    // proved it -- the agent could never have read a word of it. Lands beside
    // CLAUDE.md in the agent's own directory, and is trigger-loaded from the
    // system prompt rather than inlined, so it costs nothing per turn.
    renderHarness(path.join('onboarding', 'templates', 'SCHEHERAZADE_MANUAL.md'), 'SCHEHERAZADE_MANUAL.md')
    // design-0023 P4: both helpers below are bash, and both used to be
    // written on EVERY platform. On Windows that meant two shell scripts the
    // machine cannot execute, chmod'd 0700 by a call that is a no-op there --
    // and the agent (and hooks/session-start.mjs) read file PRESENCE as
    // capability, so an inert file is a false yes. Gated on the capability
    // that makes each one runnable: the attach lane exists only on mac
    // (vendored tmux + TCC attribution), and `sudo` only where sudo does.
    if (HOST.attachLane) {
      renderHarness(path.join('onboarding', 'templates', 'attach-bootstrap.sh'), 'attach-bootstrap.sh')
    }
    // sudo askpass helper (0.1.0 prep): must be executable -- sudo -A execs it.
    // Content carries no secret (it fetches at run time); 0700 anyway.
    if (HOST.sudo) {
      renderHarness(path.join('onboarding', 'templates', 'sudo-askpass.sh'), 'sudo-askpass.sh', 0o700)
    }

    // Identity firewall + update self-awareness (2026-08-15, design doc:
    // docs/design-identity-firewall-and-selfops.md). Both are COURTESY
    // blocks: each is computed best-effort inside its own try/catch and
    // degrades to '' — a broken identity file or changes list must never
    // fail the harness render (which would block spawn entirely).
    let predecessorNote = ''
    try {
      const identity = agentIdentity.readIdentity(DATA_HOME)
      const names = (identity && identity.predecessors || [])
        .map((p) => p.name).filter(Boolean)
      if (names.length) {
        predecessorNote =
          `Known predecessor identities on this machine: ${[...new Set(names)].join(', ')}. ` +
          'Their records remain in the journal and archives — historical data, never you.'
      }
    } catch (err) {
      console.error('[scheherazade/onboarding] predecessor note skipped:', err.message)
    }
    const updateBrief = computeUpdateBrief(readFileFn)

    // Korean voice (0.3.8, Mino 2026-09-29 "어떤 모델 쓰든 말투가 크게
    // 튀어나오지 않았으면"). Inlined, not lazy-loaded like the manual: the
    // voice applies to every Korean turn, and the weaker models this app runs
    // on follow what is in the prompt far more than a file they were told to
    // open. Read BEFORE the prompt template so that template stays the last
    // read (test-harness-refresh's all-or-nothing pin).
    const koreanVoice = readFileFn(
      path.join(REPO_ROOT, 'onboarding', 'templates', 'korean-voice.md'),
      'utf8'
    ).trim()
    const promptSrc = readFileFn(
      path.join(REPO_ROOT, 'onboarding', 'templates', 'agent-system-prompt.md'),
      'utf8'
    )
    staged.push({
      dstName: 'system_prompt.md',
      rendered: promptSrc
        .replaceAll('{DISPLAY_NAME}', displayName)
        .replaceAll('{TONE}', tone)
        .replaceAll('{TONE_GUIDANCE}', TONE_GUIDANCE[tone] || TONE_GUIDANCE.casual)
        .replaceAll('{PRIMARY_TASK}', primaryTask || '일상 대화와 기록')
        .replaceAll('{PREDECESSOR_NOTE}', predecessorNote)
        .replaceAll('{UPDATE_BRIEF}', updateBrief.block)
        .replaceAll('{PLATFORM_SECTION}', platformSection())
        .replaceAll('{KOREAN_VOICE}', koreanVoice),
    })

    // Every source read and rendered. Only now does anything touch the harness.
    for (const { dstName, rendered, mode } of staged) {
      const dst = path.join(DATA_HOME, dstName)
      const tmp = `${dst}.tmp`
      writeFileFn(tmp, rendered)
      if (mode !== undefined) fs.chmodSync(tmp, mode)
      fs.renameSync(tmp, dst)
    }
    // Stamp only AFTER the harness writes landed: a failed render must not
    // burn the one-shot briefing (the block would be lost without ever
    // reaching a system prompt).
    updateBrief.commit()
  }

  // {PLATFORM_SECTION} (design-0023 P4). The prompt used to carry one
  // section called "Controlling the Mac" -- osascript, Apple Events, the
  // -600 error code -- and it was rendered on every host, so a Windows
  // agent was told to drive Calendar.app through an interpreter that does
  // not exist there, and a Linux agent got the same paragraph plus a `sudo`
  // line whose vault it could reach and an Apple-app line it could not.
  //
  // THREE BODIES, NOT ONE BODY WITH CAVEATS. A single section hedged with
  // "on Windows, instead..." costs every platform the tokens of the other
  // two and reads as optional advice; the model then picks the branch that
  // sounds most familiar, which is the mac one, because that is what most
  // of its training saw. Each host gets prose written for it and nothing
  // about the others -- the agent should not be able to tell there was a
  // choice.
  //
  // The SKILL LIST is derived from the same table seedSkillDefinitions
  // filters on, never hand-written here: the prompt then cannot name a
  // skill that was not seeded, in either direction, no matter which way a
  // capability row is later flipped. Only the gated skills are listed
  // (SKILL_REQUIREMENTS is exactly the not-portable set); the portable ones
  // are discovered the normal way, by their own description.
  function platformSection() {
    const gated = Object.keys(HOST.SKILL_REQUIREMENTS)
    const here = gated.filter((n) => HOST.skillAllowed(n)).sort()
    const missing = gated.filter((n) => !HOST.skillAllowed(n)).sort()
    const names = (list) => (list.length ? list.join(', ') : 'none')
    // The rest of this template is hand-wrapped near 70 columns and the
    // skill lists are computed, so the paragraphs are written as one string
    // each and wrapped here -- otherwise a platform with one more skill on
    // it silently renders a 120-column line in the middle of the document.
    const body = (paras) => wrapParas(paras, { width: 70 })

    if (HOST.isWin) {
      return body([
        `## Controlling ${HOST.machineWord}`,
        `Your shell here is ${HOST.shellName}: \`Get-ChildItem\`, \`Move-Item\`, \`Copy-Item\`.`
          + ' The unix one-liners you may reach for (`find ... -exec`, `mv`) are not on'
          + ' this machine, and neither is `osascript` — a bash reflex here is a failed'
          + ' command, not a portable habit.',
        `Machine skills installed here: ${names(here)}. Deliberately NOT installed,`
          + ` because this PC cannot run them: ${names(missing)}. If your person asks for`
          + ' their calendar, mail or reminders, say this app has no way to reach them'
          + ' here — never improvise an automation to cover the gap.',
        'Admin work: Windows elevates through UAC, and this app carries no elevation'
          + ' path at all — there is no `sudo` here, and no password vault to reach. An'
          + ' administrator command is one you hand to your person to run.',
        `Keys your person saved through this app are sealed with ${HOST.credStoreName}`
          + ' and handed to whatever needs them. You never read that store yourself.',
      ])
    }
    if (HOST.isLinux) {
      return body([
        `## Controlling ${HOST.machineWord}`,
        `You have a real POSIX shell here (${HOST.shellName}) — find, mv, sed, and this`
          + " distro's package manager. That is the whole interface: there is no"
          + ' app-automation layer on this desktop'
          // windowCapture is a PROBE on Linux (wmctrl/xdotool + import), not a
          // constant, so this clause has to ask rather than assert -- an agent
          // told it cannot photograph a window on a box where the wrapper is
          // right there on its PATH would decline work it can actually do.
          + (HOST.windowCapture ? '' : ' and no way to photograph a window')
          + ', so a request that needs one is a plain "this build cannot do that'
          + ' here", never an improvised script.',
        `Machine skills installed here: ${names(here)}. Deliberately NOT installed,`
          + ` because this machine cannot run them: ${names(missing)}.`,
        "Admin work: `sudo -A <cmd>` — the only path to the app's password vault (app"
          + ' running + sudo toggle ON). Plain `sudo` and `sudo -n` cannot reach it.',
        `Keys your person saved through this app go to ${HOST.credStoreName}. With no`
          + ' keyring running the app refuses to store them at all rather than write'
          + ' plaintext — so "the key did not save" can be a desktop-session problem,'
          + ' not something they did wrong.',
      ])
    }
    return body([
      `## Controlling ${HOST.machineWord}`,
      `You have a real POSIX shell here (${HOST.shellName}) — find, mv, sed — plus`
        + ' `osascript`, which is how this machine is actually driven.',
      'For calendar/mail/reminders/music, drive the app via `osascript` before any'
        + ' TCC-gated direct API: permissions are per-process, and an Apple Event uses'
        + " the app's own grant. `-600` means the app isn't running — open it, retry"
        + ' once. "not_determined" is a fact about that lane, not proof the data is'
        + ' unreachable.',
      `Machine skills installed here: ${names(here)}.`
        + (missing.length ? ` Deliberately NOT installed, because this Mac cannot run them: ${names(missing)}.` : ''),
      "Admin work: `sudo -A <cmd>` — the only path to the app's password vault (app"
        + ' running + sudo toggle ON). Plain `sudo` and `sudo -n` cannot reach it.',
      `Keys your person saved through this app are sealed in the ${HOST.credStoreName}`
        + ' and handed to whatever needs them. You never read that store yourself.',
    ])
  }

  // ── the OTHER harness documents' platform blocks (design-0023 P4 tail) ────
  // {PLATFORM_SECTION} above fixed the system prompt and stopped there. It was
  // never the only document written as if every machine were a Mac. Four more
  // are rendered into the agent's data directory on EVERY host and each stated
  // a mac fact as a universal one: SCHEHERAZADE_MANUAL.md described `sudo -A`
  // and a password vault as things every install has and carried a section
  // literally titled "macOS permissions"; procedures/machine.md put the
  // password in "the app's Keychain vault" and described a tmux attach lane as
  // the durable mode anywhere; CLAUDE.md's machine headlines repeated both in
  // one sentence; procedures/autonomy-and-paths.md told every agent that root
  // work goes "via `sudo -A`". A Windows agent read all four and was told
  // about an elevation path it does not have, a durability mode it cannot
  // switch to, and four skills that were deliberately never seeded for it.
  //
  // Same contract as platformSection(), for the same reasons. One body per
  // host, never one body with "on Windows, instead..." attached: a hedge costs
  // the other platforms tokens, reads as optional advice, and lets the model
  // pick the branch it has seen most, which is always the mac one. And every
  // fact comes from the capability table -- HOST.sudo, HOST.attachLane,
  // HOST.permissionsPanel + the probe list behind it, HOST.credStoreName,
  // HOST.skillAllowed -- rather than being written down a second time here,
  // where it could drift from the code that actually decides.
  //
  // THE BRANCH IS THE CAPABILITY, NOT THE PLATFORM ID. `HOST.sudo` is true on
  // mac and Linux and those two share one real lane, so they share one body;
  // that is one fact, not a hedge. If a row ever flips (a Linux attach lane,
  // an elevation path on Windows) the prose follows the table instead of
  // being re-litigated here.
  //
  // Returned as a placeholder->body map and applied by renderHarness to every
  // harness template, so a document that does not use a block simply does not
  // carry its placeholder. Exported for tools/test-packaging.mjs, which has to
  // read the manual's real full text now that part of it lives here.
  function platformDocBlocks() {
    // Wrap widths are per document, matching the hand-wrap of the file each
    // block lands in (measured, not guessed: the manual runs to ~78 columns,
    // machine.md to ~76, CLAUDE.md to ~75, autonomy-and-paths.md to ~74).
    const para = (text, width) => wrapParas([text], { width })
    const bullets = (items, width) => items
      .map((t) => wrapParas([`- ${t}`], { width, indent: '  ' })).join('\n')
    const listWords = (items) => items.join(', ')

    // The permission checklist's ROWS come from the probe table, the same one
    // permissionsPanel is derived from -- so a probe added for a platform
    // shows up in that platform's manual with no second edit. An unknown class
    // prints its raw id rather than vanishing: a silently shorter checklist
    // reads exactly like "that permission is fine", which is the failure
    // permission-probes.cjs's own catch block exists to avoid.
    const PERM_ROW_WORDS = {
      fda: 'Full Disk Access',
      screen: 'Screen Recording',
      accessibility: 'Accessibility',
      automation: 'Automation (driving other apps)',
      sudo: 'admin commands (sudo)',
      sip: 'System Integrity Protection',
      keyring: 'the password store',
    }
    const permRows = require('./permission-probes.cjs').probeClassesFor(HOST.id)
      .map((cls) => PERM_ROW_WORDS[cls] || cls)

    // Which starter skills actually landed. Same filter seedSkillDefinitions
    // runs, over the same directory, so the manual cannot name a skill the
    // seeder withheld (the bug this whole pass is about) in either direction.
    // Best-effort: an unreadable template dir degrades to "no list" prose, it
    // never fails the render -- a harness render that throws blocks the spawn.
    let skillNames = []
    try {
      skillNames = fs.readdirSync(TEMPLATE_SKILLS_DIR, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => e.name)
        .filter((n) => fs.existsSync(path.join(TEMPLATE_SKILLS_DIR, n, 'SKILL.md')))
        .sort()
    } catch (err) {
      console.error(`[scheherazade/onboarding] manual skill list skipped: ${err.message}`)
    }
    const skillsHere = skillNames.filter((n) => HOST.skillAllowed(n))
    const skillsWithheld = skillNames.filter((n) => !HOST.skillAllowed(n))

    // ── SCHEHERAZADE_MANUAL.md ─────────────────────────────────────────────
    const manualAdmin = HOST.sudo
      ? [
        '## Admin access (sudo)',
        '',
        bullets([
          'Off by default. Only your person can turn it on, in Settings.',
          'When on: `sudo -A <cmd>`. Plain `sudo` and `sudo -n` cannot reach the vault.',
          'Works only while the app is running. App closed = no admin.',
          '**Never** edit sudoers, add NOPASSWD, or read the vault or token files to'
            + ' get the password another way. If sudo is refused, that is an answer —'
            + ' take it to your person instead of widening your own access.',
        ], 78),
        '',
        para('**Risk, and say this one in full when they ask to enable it**: with the'
          + ' toggle on there is no approval dialog between you and the machine. A'
          + ' mistake of yours runs as root. That is the deal the design makes on'
          + ' purpose — it trusts your judgment rather than caging it — and they should'
          + ' know they are the one accepting it.', 78),
      ].join('\n')
      : [
        '## Admin access',
        '',
        bullets([
          `There is none to offer. This app has no elevation path on ${HOST.machineWord}:`
            + ' no `sudo`, no stored admin password, and no switch in Settings that'
            + ' would create one.',
          'An administrator command is one you hand to your person — say what it does'
            + ' and why, and let them run it themselves. The consent prompt in front of'
            + ' it is theirs to answer, not yours.',
          '**Never** go looking for another way in. There is no vault and no token'
            + ' file to read here, and nothing to widen. A task that needs'
            + ' administrator rights is one you name and stop at.',
        ], 78),
      ].join('\n')

    let manualPerms
    if (HOST.permissionsPanel === 'tcc') {
      manualPerms = [
        '## macOS permissions',
        '',
        para(`Settings carries a permission checklist: ${listWords(permRows)}.`
          + ' SIP is on that list as a fixed condition of the machine rather than'
          + ' something anyone flips, so you stop rediscovering it one EPERM at a'
          + ' time. Calendar access is read-only by design — the app'
          + ' asks to read what is on their day, never to add or change events.', 78),
        '',
        para('**Risk**: Full Disk Access is exactly as broad as it sounds. If they are'
          + ' uncomfortable, most of what you do still works without it; find out what'
          + ' they actually want to do before asking for the widest grant.', 78),
      ].join('\n')
    } else if (HOST.permissionsPanel === 'posix') {
      manualPerms = [
        '## Linux permissions',
        '',
        para(`Settings carries a short permission checklist: ${listWords(permRows)}.`
          + ` The password store is the one worth explaining: keys and tokens go to`
          + ` ${HOST.credStoreName}, so with no keyring running the app refuses to`
          + ' store a new key at all rather than write it unprotected. There is no'
          + ' Settings pane in the app that fixes that — it is desktop-session work,'
          + ' outside this app entirely.', 78),
        '',
        para('**Risk**: "the key would not save" sounds like something they did wrong'
          + ' and usually is not. Say which of the two it is — a refused write with no'
          + ' keyring, or a genuinely bad key — before they retype it a third time.', 78),
      ].join('\n')
    } else {
      manualPerms = [
        '## Permissions',
        '',
        para(`This app has no permissions checklist on ${HOST.machineWord}: nothing`
          + ' here is gated behind a grant your person has to go and give, so the'
          + ' Settings screen shows no permissions panel at all. Their keys and tokens'
          + ` are sealed with ${HOST.credStoreName}, which belongs to their login and`
          + ' has no separate service that can be missing or locked.', 78),
        '',
        para('So when something is blocked here, it is an ordinary file permission or'
          + ' another program on the machine — not a switch they can flip in this app.'
          + ' Say that plainly instead of sending them hunting through Settings for a'
          + ' grant that does not exist.', 78),
      ].join('\n')
    }

    const manualTopology = HOST.attachLane
      ? [
        '## Topology',
        '',
        para('`spawn` (the app runs you) or `attach` (you run in an external tmux'
          + ' session the app connects to). Attach survives the app closing; spawn'
          + ' does not.', 78),
      ].join('\n')
      : [
        '## Topology',
        '',
        para('One mode here: the app runs you as its own child, so quitting the app'
          + ' stops you. The durable alternative — living in an external terminal'
          + ' session the app merely connects to — needs a tmux this app ships only on'
          + ' macOS, so Settings does not offer the switch on this machine.'
          + ' `AGENT_TOPOLOGY=attach` in your `.agent-config` is not a way around'
          + ' that: set by hand here it does not make you durable, it stops you from'
          + ' starting at all.', 78),
      ].join('\n')

    const manualSkills = [
      '## Default skills',
      '',
      para('You ship with a starter set of skills in your `.claude/skills/`'
        + (skillsHere.length ? ` directory: ${listWords(skillsHere)}.` : ' directory.')
        + ' Each SKILL.md carries verified recipes and its own judgment rules; read'
        + ' the skill before improvising the same job badly. skill-creator is the meta'
        + ' one: when your person teaches you a repeatable workflow, that is how you'
        + ' keep it. messenger-connect carries the EXACT Slack app manifest and scope'
        + ' table — never write a Slack manifest from memory.', 78),
      ...(skillsWithheld.length ? [
        '',
        para(`Deliberately NOT installed, because ${HOST.machineWord} cannot run them:`
          + ` ${listWords(skillsWithheld)}. If your person asks for one of those, say`
          + ' this app has no way to do it here rather than improvising a replacement'
          + ' that can only fail.', 78),
      ] : []),
      '',
      para('They are yours to edit — an edited skill survives app updates. A deleted'
        + ' one comes back on the next boot, so "don\'t want it" means editing it'
        + ' down, not deleting it.', 78),
    ].join('\n')

    // ── procedures/machine.md ──────────────────────────────────────────────
    const machinePersistence = HOST.attachLane
      ? bullets(['**Persistence — spawn vs attach.** By default you run as a child of'
        + ' the app (spawn): quit the app and you stop. In attach mode you live in a'
        + ' tmux session the user bootstrapped from their own terminal, and you'
        + ' survive the app quitting or updating. If the user wants the durable mode,'
        + ' the Settings screen hands them a bootstrap command to paste into their'
        + ' terminal — the app never runs it for them, and that is deliberate: it'
        + ' keeps the OS permissions attributed to their terminal, not to an app that'
        + ' re-signs every update. So if durability or a permission that keeps'
        + ' resetting comes up, point them at that bootstrap command; don\'t try to'
        + ' create the tmux session yourself.'], 76)
      : bullets(['**Persistence — you are the app\'s child.** You run as a child of'
        + ' the app: quit the app and you stop, every time. There is no durable mode'
        + ' on this machine — the attach lane (an external terminal session that'
        + ' outlives the app) exists only on macOS, so Settings does not offer the'
        + ' switch and there is no bootstrap command to hand anyone. If durability'
        + ' comes up, the honest answer is that the app has to stay open; setting'
        + ' `AGENT_TOPOLOGY=attach` by hand does not build the lane, it stops you from'
        + ' starting.'], 76)

    const machineAdmin = HOST.sudo
      ? bullets(['**Admin (sudo).** For a task that genuinely needs root, `sudo -A'
        + ' <cmd>` (see the system-prompt hard line for the full rule). The password'
        + ` lives in the app's vault, sealed with ${HOST.credStoreName}, and is served`
        + ' only while the app runs and the Settings toggle is ON — a sudo failure'
        + ' means one of'
        + ' those is off, not a wall for you to climb. Never widen your own privileges'
        + ' (sudoers/NOPASSWD/reading the token files); if blocked, say so and stop.'], 76)
      : bullets(['**Admin — there is no lane for it here.** This machine has no `sudo`'
        + ' and this app has no elevation path: no askpass helper, no stored admin'
        + ' password, no toggle in Settings that would make one. A task that genuinely'
        + ' needs administrator rights is one you describe to the user and hand over'
        + ' for them to run. Never go hunting for another way in; if blocked, say so'
        + ' and stop.'], 76)

    // ── CLAUDE.md machine headlines ────────────────────────────────────────
    // One paragraph, two platform sentences and a portable tail. The tail is
    // written once and appended to whichever branch runs, so a change to the
    // restart or spawn-info wording is still a one-place edit.
    const CLAUDE_FACTS_TAIL = 'Restarts happen TO you (~12h supervisor) —'
      + ' continuity is Boot + memory files. Your real brain may not be Claude (proxy'
      + ' providers); certainty = spawn-info endpoint, not `$MODEL`.'
    const claudeMachineFacts = para([
      HOST.attachLane
        ? 'Spawn mode dies with the app, attach mode (user-run tmux bootstrap)'
          + ' survives it — never create the tmux session yourself.'
        : 'The app runs you as its child: quit it and you stop, and there is no attach'
          + ' lane on this machine to outlive it.',
      HOST.sudo
        ? 'sudo = `sudo -A` while the app runs with the toggle ON; never widen'
          + ' privileges.'
        : 'No sudo and no elevation lane here — an admin command goes to your person;'
          + ' never widen privileges.',
      CLAUDE_FACTS_TAIL,
    ].join(' '), 75)

    // ── procedures/autonomy-and-paths.md ───────────────────────────────────
    const autonomySudo = HOST.sudo
      ? bullets(['**sudo**: only on direct user request, only via `sudo -A`, never to'
        + ' widen your own access (system-prompt Hard Lines covers this in full).'], 74)
      : bullets(['**Admin rights**: there is no elevation lane on this machine — hand'
        + ' the command to the user instead of looking for another way in'
        + ' (system-prompt Hard Lines covers this in full).'], 74)

    return {
      MANUAL_ADMIN_SECTION: manualAdmin,
      MANUAL_PERMISSIONS_SECTION: manualPerms,
      MANUAL_TOPOLOGY_SECTION: manualTopology,
      MANUAL_SKILLS_SECTION: manualSkills,
      MACHINE_PERSISTENCE: machinePersistence,
      MACHINE_ADMIN: machineAdmin,
      CLAUDE_MACHINE_FACTS: claudeMachineFacts,
      AUTONOMY_SUDO: autonomySudo,
    }
  }

  // Post-update briefing (Phase B of the 2026-08-15 design; red-teamed to
  // its minimal form — see the design doc's YAGNI verdict). Compares the
  // app version against DATA_HOME/.last-briefed-version:
  //   - stamp missing  -> fresh install or pre-feature upgrade: stamp now,
  //     no brief (an install is not an update).
  //   - stamp == current -> nothing new, no brief.
  //   - stamp != current -> render a one-boot block telling the agent to
  //     mention the update ONCE, with the user-facing lines from
  //     templates/user-changes.md for the versions in between. The stamp
  //     bumps when the render SUCCEEDS (commit()), so respawns don't
  //     re-brief (the spam trap the red team caught) and a failed render
  //     doesn't burn the briefing.
  // Best-effort throughout: any error -> empty block, logged, never thrown.
  function computeUpdateBrief(readFileFn) {
    const noop = { block: '', commit: () => {} }
    try {
      const version = JSON.parse(
        readFileFn(path.join(REPO_ROOT, 'package.json'), 'utf8')
      ).version
      if (!version) return noop
      const stampPath = path.join(DATA_HOME, '.last-briefed-version')
      let prev = null
      try { prev = fs.readFileSync(stampPath, 'utf8').trim() } catch { /* first run */ }
      const stamp = () => {
        try { fs.writeFileSync(stampPath, version + '\n') } catch (err) {
          console.error('[scheherazade/onboarding] briefed-version stamp failed:', err.message)
        }
      }
      if (!prev) { stamp(); return noop }
      if (prev === version) return noop

      let changes = ''
      try {
        const src = readFileFn(path.join(REPO_ROOT, 'onboarding', 'templates', 'user-changes.md'), 'utf8')
        const cmp = (a, b) => {
          const pa = String(a).split('.').map(Number)
          const pb = String(b).split('.').map(Number)
          for (let i = 0; i < 3; i++) { if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0) }
          return 0
        }
        const sections = [...src.matchAll(/^## +(\d+\.\d+\.\d+)\n([\s\S]*?)(?=^## |\n*$(?![\s\S]))/gm)]
        changes = sections
          .filter(([, v]) => cmp(v, prev) > 0 && cmp(v, version) <= 0)
          .map(([, v, body]) => `- v${v}: ${body.trim().replace(/\s*\n\s*/g, ' ')}`)
          .join('\n')
      } catch { /* no changes file in this build -- brief as a bare bump */ }

      const block = [
        '## App update notice (one-time)',
        '',
        `This app was updated from v${prev} to v${version} since your last boot.`,
        'In your NEXT reply — and only that one — mention the update briefly and',
        'naturally, one or two sentences, never a changelog dump. Then drop it.',
        changes ? `\nWhat changed for your person:\n${changes}` : '',
      ].join('\n')
      return { block, commit: stamp }
    } catch (err) {
      console.error('[scheherazade/onboarding] update brief skipped:', err.message)
      return noop
    }
  }

  // Boot-time harness refresh for already-onboarded installs. Fail-loud in
  // log, non-fatal: a broken template must not stop the whole server, but it
  // must never be silent either.
  function refreshHarnessIfOnboarded(opts = {}) {
    try {
      const config = readAgentConfig()
      if (!config.ONBOARDING_COMPLETE) return false
      // Identity firewall: create/sync .agent-identity at every boot.
      // Best-effort — provenance must never block a spawn.
      try {
        agentIdentity.ensureIdentity(DATA_HOME, config.DISPLAY_NAME || AGENT_NAME)
      } catch (err) {
        console.error('[scheherazade/onboarding] identity ensure failed:', err.message)
      }
      renderHarnessFiles({
        displayName: config.DISPLAY_NAME || AGENT_NAME,
        tone: config.TONE || 'casual',
        primaryTask: config.PRIMARY_TASK || '',
      }, opts)
      // Success clears any previous failure: the whole point of re-rendering at
      // every boot is that a shipped fix repairs an install without the user
      // doing anything, so recovery must be automatic and must un-block spawn.
      clearHarnessFailure()
      console.error('[scheherazade/onboarding] harness re-rendered at boot (CLAUDE.md / ONTOLOGY_GUIDE.md / system_prompt.md)')
      return true
    } catch (err) {
      // Durable, not just logged (harness-refresh #6). renderHarnessFiles is all-or-nothing,
      // so reaching here means the harness on disk is the PREVIOUS one, intact but
      // possibly older than the runtime that is about to read it. main.cjs refuses
      // to spawn while this file exists, and the UI shows the reason.
      writeHarnessFailure(err)
      console.error('[scheherazade/onboarding] boot harness refresh FAILED (agent will NOT be spawned):', err.message)
      return false
    }
  }

  // Written by refreshHarnessIfOnboarded on failure, removed on the next
  // success. Deliberately a plain file rather than in-memory state: the check
  // lives in main.cjs (a different module, and on a later tick), and a crash
  // between refresh and spawn must not lose the fact.
  function writeHarnessFailure(err) {
    try {
      fs.writeFileSync(
        HARNESS_FAILURE_PATH,
        JSON.stringify({ at: new Date().toISOString(), message: err && err.message ? err.message : String(err) }, null, 2) + '\n'
      )
    } catch (writeErr) {
      // Nothing left to escalate to. Say so rather than pretending the gate is armed.
      console.error('[scheherazade/onboarding] could not record the harness failure marker:', writeErr.message)
    }
  }

  function clearHarnessFailure() {
    try {
      fs.rmSync(HARNESS_FAILURE_PATH, { force: true })
    } catch (err) {
      console.error('[scheherazade/onboarding] could not clear the harness failure marker:', err.message)
    }
  }

  // Read by main.cjs before spawning. Returns null when the harness is fine.
  function readHarnessFailure() {
    try {
      if (!fs.existsSync(HARNESS_FAILURE_PATH)) return null
      return JSON.parse(fs.readFileSync(HARNESS_FAILURE_PATH, 'utf8'))
    } catch {
      // Unreadable/corrupt marker still means a failure was recorded. Fail closed.
      return { at: null, message: 'harness failure marker exists but could not be read' }
    }
  }

  // Portable tmux sync (v0.0.35, 극한의 딸깍): the vendored tmux tree
  // (tools/vendor-tmux.mjs -> extraResources Contents/Resources/
  // tmux-portable) is copied into DATA_HOME/bin/tmux-portable at every boot
  // where the VERSION stamp differs. Copied OUT of the app bundle on
  // purpose: the attach topology needs the tmux server's TCC attribution to
  // descend from the USER'S TERMINAL (probe-0016), and whether exec'ing a
  // binary living INSIDE Scheherazade.app re-keys attribution to the bundle
  // is unverified -- a binary in DATA_HOME makes the question moot.
  // Replacing files under a RUNNING server is safe (the process holds the
  // old inode), and the swap is staged+renamed so a crash mid-copy never
  // leaves a half tree at the final path. Fail-loud non-fatal: attach is an
  // optional lane; a failed sync must not block the spawn-lane boot.
  // ── one launcher writer (design-0023 P4) ────────────────────────────────
  // syncChromuxPortable and syncAgentTools each carried their own copy of
  // "write a .cmd AND a sh wrapper", unconditionally, on every platform. So
  // every mac install got two dead .cmd files and every Windows install got
  // two sh wrappers it cannot execute plus a chmod that is a no-op there --
  // and the agent reads wrapper PRESENCE as "this tool is available".
  // One writer, the platform's own form only. `extraArgs` are baked BEFORE
  // the user's argv in both shapes (the .cmd copy used to append them after
  // %*, so the two wrappers disagreed about argument order); a leading-dash
  // element is a flag and stays bare, anything else is a value and is quoted.
  function writeLauncher(binDir, name, entry, extraArgs = []) {
    fs.mkdirSync(binDir, { recursive: true })
    const baked = extraArgs.map((a) => (/^-/.test(String(a)) ? ` ${a}` : ` "${a}"`)).join('')
    if (HOST.isWin) {
      // CRLF: cmd.exe chokes on bare-LF labels and continuations.
      const cmdPath = path.join(binDir, `${name}.cmd`)
      fs.writeFileSync(cmdPath, `@echo off\r\nnode "${entry}"${baked} %*\r\n`)
      return cmdPath
    }
    const shPath = path.join(binDir, name)
    fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${entry}"${baked} "$@"\n`)
    fs.chmodSync(shPath, 0o755)
    return shPath
  }

  function syncTmuxPortable() {
    // design-0023 P4: the vendored tmux is a Mach-O binary shipped through
    // build.mac.extraResources, so on a PACKAGED win/linux build the source
    // tree is simply absent and this returned false quietly. In a DEV
    // checkout it happily copied a Mach-O into DATA_HOME/bin on Windows and
    // Linux, where nothing can run it -- and attach-topology.cjs's resolver
    // probes exactly that path first, so the useless copy would win over a
    // real system tmux. The platform that has the lane is the platform that
    // gets the binary.
    if (!HOST.attachLane) return false
    try {
      const candidates = [
        path.join(REPO_ROOT, '..', 'tmux-portable'), // packaged: Resources/ sibling of app.asar
        path.join(REPO_ROOT, 'vendor', 'tmux-portable'), // dev / CLI deployment
      ]
      const src = candidates.find((p) => fs.existsSync(path.join(p, 'tmux')))
      if (!src) return false // build predates vendoring -- nothing to sync
      const dst = path.join(DATA_HOME, 'bin', 'tmux-portable')
      const readVersion = (dir) => {
        try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() } catch { return null }
      }
      const srcVersion = readVersion(src)
      if (srcVersion && srcVersion === readVersion(dst) && fs.existsSync(path.join(dst, 'tmux'))) {
        return true // already current
      }
      const tmp = `${dst}.tmp`
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.cpSync(src, tmp, { recursive: true })
      fs.chmodSync(path.join(tmp, 'tmux'), 0o755)
      fs.rmSync(dst, { recursive: true, force: true })
      fs.renameSync(tmp, dst)
      console.error(`[scheherazade/onboarding] tmux-portable synced into DATA_HOME/bin (${srcVersion || 'unversioned'})`)
      return true
    } catch (err) {
      console.error('[scheherazade/onboarding] tmux-portable sync failed (attach lane may miss tmux):', err.message)
      return false
    }
  }

  // v0.1.10: vendored chromux (zero-dep Chrome-over-CDP CLI, MIT,
  // github.com/modakbul-gongbang/chromux) -- the web-search path for
  // non-Anthropic backends, where Claude Code's WebSearch is a server-side
  // Anthropic tool and silently returns empty (the Windows box/deepseek live repro
  // 2026-08-14). Same sync shape as syncTmuxPortable above, plus two extras:
  //   - wrapper scripts in DATA_HOME/bin (chromux / chromux.cmd) so the agent
  //     invokes it path-independently -- the lane's PATH has no npm global
  //     bin, and `node <abs>/chromux.mjs` needs an absolute path the skill
  //     text cannot know at template-write time
  //   - chromux's own bundled skills (skills/chromux, skills/chromux-work)
  //     seeded into .claude/skills, copy-if-missing like seedSkillDefinitions
  function syncChromuxPortable() {
    try {
      const candidates = [
        path.join(REPO_ROOT, '..', 'chromux'), // packaged: Resources/ sibling of app.asar
        path.join(REPO_ROOT, 'vendor', 'chromux'), // dev / CLI deployment
      ]
      const src = candidates.find((p) => fs.existsSync(path.join(p, 'chromux.mjs')))
      if (!src) return false // build predates vendoring -- nothing to sync
      const dst = path.join(DATA_HOME, 'bin', 'chromux-portable')
      const readVersion = (dir) => {
        try { return fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() } catch { return null }
      }
      const srcVersion = readVersion(src)
      const current = srcVersion && srcVersion === readVersion(dst) && fs.existsSync(path.join(dst, 'chromux.mjs'))
      if (!current) {
        const tmp = `${dst}.tmp`
        fs.rmSync(tmp, { recursive: true, force: true })
        fs.cpSync(src, tmp, { recursive: true })
        fs.rmSync(dst, { recursive: true, force: true })
        fs.renameSync(tmp, dst)
        console.error(`[scheherazade/onboarding] chromux synced into DATA_HOME/bin (${srcVersion || 'unversioned'})`)
      }
      // Wrappers are rewritten every boot (cheap, and they carry an absolute
      // path that must track DATA_HOME if it ever moves). `node` on PATH is
      // already a harness-wide assumption -- every hook runs as `node
      // hooks/*.mjs` (run.sh's own comment).
      const entry = path.join(dst, 'chromux.mjs')
      writeLauncher(path.join(DATA_HOME, 'bin'), 'chromux', entry)
      // Seed chromux's bundled skills (SKILL.md + topics/ — multi-file, so
      // the shipped file list is walked recursively). Same overwrite-if-
      // pristine tri-state as seedSkillDefinitions: pristine-but-stale files
      // refresh in place, a user-edited skill is withheld, and files the
      // user added inside the skill dir are never touched.
      const manifest = loadSkillHashManifest()
      for (const name of ['chromux', 'chromux-work']) {
        const skillSrc = path.join(dst, 'skills', name)
        if (!fs.existsSync(path.join(skillSrc, 'SKILL.md'))) continue
        const files = []
        const walk = (dir, rel) => {
          for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const r = rel ? `${rel}/${e.name}` : e.name
            if (e.isDirectory()) walk(path.join(dir, e.name), r)
            else if (e.isFile()) files.push({ src: path.join(dir, e.name), rel: r })
          }
        }
        try { walk(skillSrc, '') } catch (err) {
          console.error(`[scheherazade/onboarding] listing chromux skill ${name} failed (continuing): ${err.message}`)
          continue
        }
        seedOrRetireSkill(name, files, manifest, 'from vendored chromux')
      }
      return true
    } catch (err) {
      console.error('[scheherazade/onboarding] chromux sync failed (web-search skill may miss its CLI):', err.message)
      return false
    }
  }

  // v0.1.18: first-party agent-side helpers (같이보기 windowshot, 2026-08-19
  // the owner). Same shape as syncChromuxPortable, minus VERSION gating: the tree
  // is a handful of small first-party .cjs files, so it re-copies every boot
  // (tmp+rename) instead of carrying a version stamp -- cheaper than getting
  // a stamp wrong. Ships unpacked via build.extraResources ("agent-tools")
  // because the agent child is plain node and cannot read inside app.asar
  // (the exact reason chromux ships unpacked). Wrappers bake --data-home in:
  // the skill text cannot know DATA_HOME at template-write time.
  function syncAgentTools() {
    try {
      const candidates = [
        path.join(REPO_ROOT, '..', 'agent-tools'), // packaged: Resources/ sibling of app.asar
        path.join(REPO_ROOT, 'onboarding', 'agent-tools'), // dev / CLI deployment
      ]
      const src = candidates.find((p) => fs.existsSync(path.join(p, 'windowshot.cjs')))
      if (!src) return false // build predates agent-tools -- nothing to sync
      const dst = path.join(DATA_HOME, 'bin', 'agent-tools')
      const tmp = `${dst}.tmp`
      fs.rmSync(tmp, { recursive: true, force: true })
      fs.cpSync(src, tmp, { recursive: true })
      fs.rmSync(dst, { recursive: true, force: true })
      fs.renameSync(tmp, dst)
      // design-0023 P4: the TREE copies everywhere (it is the first-party
      // helper directory, and a portable helper added to it later must not
      // be gated on this one row), but the WRAPPER is the availability
      // signal -- the same "presence reads as capability" rule the launcher
      // writer above exists for. windowCapture is an OS built-in on mac
      // (osascript + screencapture) and Windows (PrintWindow) and a PROBE on
      // Linux, where the capture tools are ordinary packages that may simply
      // not be installed; a `windowshot` sitting on the agent's PATH there is
      // a promise the tool cannot keep. It is the same row that decides
      // whether the windowshot SKILL is seeded, so the two cannot disagree.
      // Both wrapper shapes are removed when the row is off, not merely left
      // unwritten: an install that got one from an earlier build (which wrote
      // both, on every platform) would otherwise keep it forever, and the
      // whole point of gating is the upgrade, not the fresh install.
      const entry = path.join(dst, 'windowshot.cjs')
      if (HOST.windowCapture) {
        writeLauncher(path.join(DATA_HOME, 'bin'), 'windowshot', entry, ['--data-home', DATA_HOME])
      } else {
        for (const stale of ['windowshot', 'windowshot.cmd']) {
          fs.rmSync(path.join(DATA_HOME, 'bin', stale), { force: true })
        }
      }
      return true
    } catch (err) {
      console.error('[scheherazade/onboarding] agent-tools sync failed (windowshot skill may miss its CLI):', err.message)
      return false
    }
  }

  function renderAgentSubstrate({ displayName, tone, primaryTask }) {
    for (const dir of ['session_notes/.archive', 'journals', 'dreams', 'logs', '.review']) {
      fs.mkdirSync(path.join(DATA_HOME, dir), { recursive: true })
    }

    renderHarnessFiles({ displayName, tone, primaryTask })

    const personaPath = path.join(DATA_HOME, 'self_persona.md')
    if (!fs.existsSync(personaPath)) {
      const today = new Date().toISOString().slice(0, 10)
      fs.writeFileSync(
        personaPath,
        [
          `# ${displayName} -- Self Persona`,
          '',
          '> Identity, not instructions. CLAUDE.md governs behavior; this file',
          '> governs who is behaving. It changes only through the persona reflux',
          '> cycle (see CLAUDE.md §4 and scripts/persona-reflux.mjs) -- never edited',
          '> on impulse.',
          '',
          '## Identity',
          '',
          '(Nothing here yet. This fills in from lived sessions, not from invention',
          '-- leave it blank until there is real history to draw from.)',
          '',
          '## Voice',
          '',
          `(How ${displayName} actually talks, once there is enough of a record to say.)`,
          '',
          '## Values',
          '',
          `(What ${displayName} holds to, learned from friction -- not declared up front.)`,
          '',
          '## Evolution Log',
          '',
          `- ${today} -- persona created from template. No lived history yet.`,
          '',
        ].join('\n')
      )
    }

    const checkpointPath = path.join(DATA_HOME, 'checkpoint.md')
    if (!fs.existsSync(checkpointPath)) {
      fs.writeFileSync(
        checkpointPath,
        [
          '# Checkpoint',
          '',
          '> Cross-session handoff. Overwritten on significant state changes -- a',
          '> snapshot, not a log. For history, see session_notes/ and journals/.',
          '',
          '## Status',
          '',
          '(First session has not happened yet.)',
          '',
        ].join('\n')
      )
    }

    log('rendered agent substrate into DATA_HOME (CLAUDE.md, ONTOLOGY_GUIDE.md, system_prompt.md; persona/checkpoint seeded if absent)')
  }

  return {
    seedConfigFromTemplates,
    seedSkillDefinitions,
    // Exported for tests/test-agent-tools-sync.mjs + test-chromux-sync.mjs:
    // the per-platform wrapper shape is only assertable by driving the writer
    // with an injected HOST.
    writeLauncher,
    ensureClaudeOnboardingDone,
    refreshHarnessIfOnboarded,
    renderAgentSubstrate,
    // Exported for tools/test-packaging.mjs: the manual's option surface gate
    // has to read the WHOLE manual, and since design-0023 P4's tail part of it
    // (admin, permissions, topology, the skill list) lives in these blocks
    // rather than in the template file.
    platformDocBlocks,
    readHarnessFailure,
    syncTmuxPortable,
    syncChromuxPortable,
    syncAgentTools,
    HARNESS_FAILURE_PATH,
  }
}

module.exports = { createHarnessRender }
