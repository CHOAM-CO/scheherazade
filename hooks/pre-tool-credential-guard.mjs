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
  const RULES = [
    [/\.claude[\\/]+\.credentials\.json/i, "Claude Code's credential file"],
    [/\.claude\.json\b/i, "Claude Code's app-state file (embeds MCP tokens)"],
    [/\.codex[\\/]+auth\.json/i, "Codex CLI's credential file"],
    [/\.hermes[\\/]+(auth\.json|\.env|state\.db)/i, "Hermes' credential/state store"],
    [/opencode[\\/]+auth\.json/i, "OpenCode's credential file"],
    [/\.openclaw[\\/]+credentials\b/i, "OpenClaw's credentials directory"],
    [/openclaw-agent\.sqlite/i, "OpenClaw's agent auth database"],
    [/find-generic-password|security\s+find/i, 'the macOS keychain'],
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
