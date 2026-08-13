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
//   - scripts/test-hooks-port.mjs extracts and re-runs the bash-hook port /
//     boot-diet removal migration regexes below, and pins their relative
//     order via indexOf on the CONST NAMES -- which is why this header
//     deliberately never spells those two names out: the first occurrence
//     must stay the real declaration, not prose;
//   - scripts/test-context-gauge.mjs pins the GAUGE_HOOK additive migration
//     (both event groups);
//   - scripts/test-attach-topology.mjs pins the attach-bootstrap.sh /
//     sudo-askpass.sh 0o700 render lines.
// Moving or rewording those literals means updating those tests IN THE SAME
// commit, and re-reading their per-line output, not just the exit code.

'use strict'

const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')

// Tone as a bare English word ("formal") was too weak an instruction for
// non-frontier models: a real tester picked Formal and got 반말 anyway
// (2026-08-04 external tester #4). The word stays for display; this block
// spells out what the register MEANS, per language, so the model has an
// explicit rule instead of a vibe to infer.
const TONE_GUIDANCE = {
  formal: 'Formal means a polite, professional register at all times: in Korean, every message uses 존댓말 (해요체 or 합니다체) — never 반말; in English, full sentences and no slang.',
  casual: 'Casual means a relaxed, friendly register: in Korean, 반말 is fine unless the person consistently uses 존댓말 — then mirror them; in English, contractions and everyday words.',
}

function createHarnessRender(ctx) {
  const {
    log, toUnpackedPath, readAgentConfig, ensureConfigDir,
    REPO_ROOT, AGENT_NAME, DATA_HOME, CONFIG_DIR,
    AGENT_CONFIG_PATH, ENV_PATH, MCP_JSON_PATH,
  } = ctx

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

  // Harness-refresh failure marker (nogabi issue #6). Boot re-renders the
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
  // frozen" half-update class diagnosed live on Mino's install 2026-07-13.
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
    // magi-win live repro where matcher "Bash" never fired at all), and the
    // add-if-missing contract cannot retrofit a matcher on an existing
    // install -- that is exactly how magi-win stayed Bash-only through an app
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

    // v0.0.41: AskUserQuestion redirect (Mino live repro 2026-08-04) -- the
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

    const afterText = JSON.stringify(settings, null, 2)
    if (afterText !== beforeText) {
      fs.writeFileSync(SETTINGS_LOCAL_PATH, afterText + '\n')
      log('settings.local.json additive migration applied (send_file permission / stop-reply-guard hook / bash-hook .mjs port)')
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
    for (const name of entries) {
      const source = path.join(TEMPLATE_SKILLS_DIR, name, 'SKILL.md')
      if (!fs.existsSync(source)) continue
      const targetDir = path.join(SKILLS_DIR, name)
      const target = path.join(targetDir, 'SKILL.md')
      if (fs.existsSync(target)) continue
      // tmp+rename + per-skill catch, for the same reasons as
      // seedAgentDefinitions above: a truncated copy must not read as
      // "seeded", and one bad skill must not abort the boot path.
      try {
        fs.mkdirSync(targetDir, { recursive: true })
        const tmp = `${target}.tmp`
        fs.copyFileSync(source, tmp)
        fs.renameSync(tmp, target)
        log(`seeded skill ${name} into .claude/skills`)
      } catch (err) {
        console.error(`[scheherazade/onboarding] seeding skill ${name} failed (continuing): ${err.message}`)
      }
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
  // ALL-OR-NOTHING (nogabi issue #6). This used to read, render and write each
  // file in turn, so a template that failed to read partway through left a
  // MIXED harness on disk: a new CLAUDE.md beside an old system_prompt.md. The
  // old log line called that "stale", which is the wrong word for a worse
  // state -- stale is at least internally consistent. Every source is now read
  // and rendered before anything is written, so a read or render failure
  // leaves the previous harness completely intact. The writes then go to .tmp
  // siblings and rename into place, which is atomic per file and collapses the
  // remaining window to the (disk-full class) case.
  // opts are test seams (scripts/test-harness-refresh.mjs), same shape as
  // resolveOutboundChannel's in channel.mjs: production call sites pass nothing
  // and get real fs. Needed because the two failures worth pinning here (a
  // template that cannot be READ, and a harness file that cannot be WRITTEN)
  // are otherwise only reachable by breaking the repo or the disk.
  function renderHarnessFiles({ displayName, tone, primaryTask }, opts = {}) {
    const readFileFn = opts.readFileFn || fs.readFileSync
    const writeFileFn = opts.writeFileFn || fs.writeFileSync
    const agentDir = toUnpackedPath(REPO_ROOT)
    const staged = []
    const renderHarness = (srcName, dstName, mode) => {
      const src = readFileFn(path.join(REPO_ROOT, srcName), 'utf8')
      const rendered = src
        .replaceAll('{AGENT_DIR}', agentDir)
        .replaceAll('{AGENT_NAME}', AGENT_NAME)
        .replaceAll('{MEMORY_DIR}', DATA_HOME)
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
    for (const proc of ['journal-compression.md', 'persona-reflux.md', 'madoromi.md']) {
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
    renderHarness(path.join('onboarding', 'templates', 'attach-bootstrap.sh'), 'attach-bootstrap.sh')
    // sudo askpass helper (0.1.0 prep): must be executable -- sudo -A execs it.
    // Content carries no secret (it fetches at run time); 0700 anyway.
    renderHarness(path.join('onboarding', 'templates', 'sudo-askpass.sh'), 'sudo-askpass.sh', 0o700)

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
        .replaceAll('{PRIMARY_TASK}', primaryTask || '일상 대화와 기록'),
    })

    // Every source read and rendered. Only now does anything touch the harness.
    for (const { dstName, rendered, mode } of staged) {
      const dst = path.join(DATA_HOME, dstName)
      const tmp = `${dst}.tmp`
      writeFileFn(tmp, rendered)
      if (mode !== undefined) fs.chmodSync(tmp, mode)
      fs.renameSync(tmp, dst)
    }
  }

  // Boot-time harness refresh for already-onboarded installs. Fail-loud in
  // log, non-fatal: a broken template must not stop the whole server, but it
  // must never be silent either.
  function refreshHarnessIfOnboarded(opts = {}) {
    try {
      const config = readAgentConfig()
      if (!config.ONBOARDING_COMPLETE) return false
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
      // Durable, not just logged (nogabi #6). renderHarnessFiles is all-or-nothing,
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
  // (scripts/vendor-tmux.mjs -> extraResources Contents/Resources/
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
  function syncTmuxPortable() {
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
  // Anthropic tool and silently returns empty (magi-win/deepseek live repro
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
      const binDir = path.join(DATA_HOME, 'bin')
      fs.writeFileSync(path.join(binDir, 'chromux.cmd'), `@echo off\r\nnode "${entry}" %*\r\n`)
      const shPath = path.join(binDir, 'chromux')
      fs.writeFileSync(shPath, `#!/bin/sh\nexec node "${entry}" "$@"\n`)
      fs.chmodSync(shPath, 0o755)
      // Seed chromux's bundled skills (SKILL.md + topics/, so a plain
      // recursive copy -- seedSkillDefinitions' single-file shape does not
      // fit). Copy-if-missing: a user-edited skill survives updates.
      for (const name of ['chromux', 'chromux-work']) {
        const skillSrc = path.join(dst, 'skills', name)
        const skillDst = path.join(SKILLS_DIR, name)
        if (!fs.existsSync(path.join(skillSrc, 'SKILL.md'))) continue
        if (fs.existsSync(path.join(skillDst, 'SKILL.md'))) continue
        try {
          const tmp = `${skillDst}.tmp`
          fs.rmSync(tmp, { recursive: true, force: true })
          fs.cpSync(skillSrc, tmp, { recursive: true })
          fs.mkdirSync(path.dirname(skillDst), { recursive: true })
          fs.rmSync(skillDst, { recursive: true, force: true })
          fs.renameSync(tmp, skillDst)
          log(`seeded skill ${name} into .claude/skills (from vendored chromux)`)
        } catch (err) {
          console.error(`[scheherazade/onboarding] seeding chromux skill ${name} failed (continuing): ${err.message}`)
        }
      }
      return true
    } catch (err) {
      console.error('[scheherazade/onboarding] chromux sync failed (web-search skill may miss its CLI):', err.message)
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
    ensureClaudeOnboardingDone,
    refreshHarnessIfOnboarded,
    renderAgentSubstrate,
    readHarnessFailure,
    syncTmuxPortable,
    syncChromuxPortable,
    HARNESS_FAILURE_PATH,
  }
}

module.exports = { createHarnessRender }
