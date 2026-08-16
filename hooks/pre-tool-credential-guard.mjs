#!/usr/bin/env node
// pre-tool-credential-guard.mjs -- PreToolUse gate: block reads of OTHER
// tools' credential files (design-0022 layer 3; layers 1-2 are the detect
// listing filter and the sweep prompt's DO-NOT-READ list in
// onboarding/routes/migrate.cjs -- keep the three lists in sync).
//
// Always on, not migration-scoped: there is never a legitimate reason for
// this agent to read another tool's auth store, and a standing rule is
// simpler to reason about than a windowed one. Fail-open on parse errors
// (a broken guard must not brick every tool call); exit 2 = block, with
// the reason on stderr so the model learns why instead of retrying.
//
// Matched by PATH SHAPE (credential basename under its tool's home), not
// by basename alone -- a user's own project file legitimately named .env
// in their repo must not be blocked; ~/.hermes/.env must be.
import fs from 'node:fs'

// Path normalization (red-team 2026-08-05 item 8 sub-note). The RULES below
// match path SHAPE, so anything that breaks the shape apart while still
// naming the same file walked straight past them: shell quoting
// (cat ~/.claude/".credentials.json"), backslash escapes (~/.cla\ude/...),
// percent-encoding (%2E for the dot), redundant segments
// (~/.claude/./.credentials.json), and traversal (~/x/../.codex/auth.json).
// Normalize FIRST, match after. Deliberately one-way and lossy -- these
// strings are only ever fed to the deny regexes, never used to open anything.
//
// A backslash is ambiguous: a Windows separator (C:\.claude\...) OR a POSIX
// shell escape (~/.cla\ude/...). Resolving it one way re-opens the other's
// bypass, so BOTH readings are produced and a hit on either one blocks.
function normalizeVariants(s) {
  let base = s
  try { base = decodeURIComponent(base) } catch { /* invalid escape -- keep raw */ }
  base = base.replace(/["'`]/g, '') // quotes splitting a path into pieces
  const asSeparator = base.replace(/[\\/]+/g, '/')
  const asEscape = base.replace(/\\(?=[^\\/])/g, '').replace(/[\\/]+/g, '/')
  return [asSeparator, asEscape].map(collapsePath)
}

function collapsePath(s) {
  let out = s
  let prev
  // Both rewrites loop to a fixed point: a single non-overlapping pass leaves
  // "/././" half-collapsed, and traversal must resolve innermost-first
  // (a/b/../c -> a/c).
  do {
    prev = out
    out = out.replace(/\/\.\//g, '/')          // /./ -> /
    out = out.replace(/[^/\s]+\/\.\.\//g, '')  // x/../ -> (nothing)
  } while (out !== prev)
  return out
}

function main() {
  let input
  try {
    input = JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    process.exit(0)
  }
  const tool = String(input.tool_name || '')
  const ti = input.tool_input || {}
  // The strings a file access could hide in, per tool.
  const candidates = []
  if (tool === 'Read' || tool === 'Glob' || tool === 'Grep') {
    candidates.push(String(ti.file_path || ''), String(ti.path || ''), String(ti.pattern || ''))
  } else if (tool === 'Bash') {
    candidates.push(String(ti.command || ''))
  } else {
    process.exit(0)
  }
  const hays = normalizeVariants(candidates.join('\n'))

  // Credential stores of the migration source tools + our own lane's.
  // Path-shaped: <tool home>/<credential name>. Windows separators and a
  // ~ or $HOME prefix are all normalized by the regexes themselves.
  //
  // 2026-08-16 extension (scalex.dev field data: humans catch destructive
  // commands 88% of the time but MISS credential-exfil reads 33-35% of the
  // time -- prompt-and-wait is a weak guard for exfil specifically, so this
  // adds pattern-based auto-block for the common OS/CLI credential stores
  // beyond the migration-source tools above). Same match-by-path-shape
  // approach, same hard-block action.
  //
  // .env is deliberately NOT covered here beyond the existing tool-home
  // shapes (~/.hermes/.env etc. above). The brief for this extension was
  // "block .env reads outside the agent's DATA_HOME" -- but AGENT_DATA_HOME
  // is this persona's memory/config home, not the coding-project cwd this
  // hook's Bash/Read calls actually operate in, and this hook has no
  // reliable signal for "the agent's own project directory" to diff a read
  // against. A path-shape match on bare ".env" with no such anchor would
  // block ordinary project .env reads constantly (the false positive the
  // file's own header comment already warns against). Skipped per the
  // brief's own fallback: "if the hook can't tell DATA_HOME, skip .env and
  // say so."
  const RULES = [
    [/\.claude[\\/]+\.credentials\.json/i, "Claude Code's credential file"],
    [/\.claude\.json\b/i, "Claude Code's app-state file (embeds MCP tokens)"],
    [/\.codex[\\/]+auth\.json/i, "Codex CLI's credential file"],
    [/\.hermes[\\/]+(auth\.json|\.env|state\.db)/i, "Hermes' credential/state store"],
    [/opencode[\\/]+auth\.json/i, "OpenCode's credential file"],
    [/\.openclaw[\\/]+credentials\b/i, "OpenClaw's credentials directory"],
    [/openclaw-agent\.sqlite/i, "OpenClaw's agent auth database"],

    // -- cloud / CLI credential files --
    [/\.aws[\\/]+(credentials|config)\b/i, "the AWS credentials/config file"],
    [/\.netrc\b/i, 'the netrc credentials file'],
    [/\.npmrc\b/i, "npm's rc file (may embed an auth token)"],
    [/\.pypirc\b/i, "PyPI's rc file (embeds upload credentials)"],
    [/\.docker[\\/]+config\.json\b/i, "Docker's config file (embeds registry auth)"],
    [/\.kube[\\/]+config\b/i, 'the kubeconfig file (cluster credentials)'],
    [/\.gnupg[\\/]/i, 'the GnuPG keyring directory'],

    // SSH: named private keys explicitly, plus a catch-all for anything else
    // under ~/.ssh EXCEPT known_hosts and public keys (*.pub) -- those two
    // carry no secret material and must stay readable. The lookaheads test
    // the remainder of the path token right after ".ssh/", so "ssh host" (no
    // ".ssh" substring at all) and "cat ~/.ssh/id_rsa.pub" / "~/.ssh/known_hosts"
    // (excluded shapes) both pass through untouched.
    [/\.ssh[\\/]+(?!known_hosts\b)(?!\S*\.pub\b)\S+/i, 'an SSH private key or other non-public file under ~/.ssh'],

    // macOS keychain. `security dump-keychain` added alongside the existing
    // find-* coverage. `security list-keychains` is deliberately NOT matched:
    // it only enumerates keychain names/paths on disk, never secret material,
    // so blocking it would be a pure false positive under the "match
    // specific paths/commands, not broad words" discipline this file follows.
    [/find-generic-password|security\s+(find|dump-keychain)/i, 'the macOS keychain'],

    // Browser-saved passwords / session cookies. Matched by folder-shape
    // (Application Support/<browser vendor dir>) AND target filename
    // together so an unrelated file merely named "Cookies" elsewhere doesn't
    // trip this.
    [/Application Support[\\/][\s\S]*?(Google[\\/]+Chrome|BraveSoftware|Microsoft Edge)[\s\S]*?(Login Data|Cookies)\b/i, "a browser's saved-password/cookie store"],
    [/(Firefox|\.mozilla)[\s\S]*?(logins\.json|key4\.db)\b/i, "Firefox's saved-password store"],
  ]
  for (const [re, label] of RULES) {
    if (hays.some((hay) => re.test(hay))) {
      process.stderr.write(
        `BLOCKED: this call touches ${label}. Credential stores are never read, migrated, or echoed -- ` +
        'not during migration sweeps, not ever. Continue the task without this file; its absence loses nothing of value.'
      )
      process.exit(2)
    }
  }
  process.exit(0)
}

main()
