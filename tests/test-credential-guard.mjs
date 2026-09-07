#!/usr/bin/env node
// test-credential-guard.mjs — pins hooks/pre-tool-credential-guard.mjs's
// full blocklist (design-0022 layer 3), including the 2026-08-16 extension
// past the migration-source tools: AWS, SSH, netrc/npmrc/pypirc, Docker,
// kube, GnuPG, macOS keychain (incl. dump-keychain), and browser-saved
// password/cookie stores. Coverage for the pre-existing migration-tool
// rules and the path-normalization sub-note lives in
// tests/test-migrate-routes.mjs (credential-guard section) and
// tests/test-redteam-hardening.mjs (item 8) respectively -- this file
// adds the new rules and their negative (must-pass) cases, standalone.
//
// Run: node tests/test-credential-guard.mjs

import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const hook = path.join(root, 'hooks', 'pre-tool-credential-guard.mjs')

let passed = 0
let failed = 0
function assert(cond, msg) {
  if (cond) { passed++; console.log(`  ok: ${msg}`) }
  else { failed++; console.error(`  FAIL: ${msg}`) }
}

const run = (input) => spawnSync(process.execPath, [hook], { input: JSON.stringify(input), encoding: 'utf8' })
const read = (file_path) => run({ tool_name: 'Read', tool_input: { file_path } })
const bash = (command) => run({ tool_name: 'Bash', tool_input: { command } })
const blocked = (r) => r.status === 2
const passes = (r) => r.status === 0

// ── AWS ─────────────────────────────────────────────────────────────────
console.log('1. AWS credentials/config')
{
  assert(blocked(read('~/.aws/credentials')), 'Read ~/.aws/credentials blocked')
  assert(blocked(bash('cat ~/.aws/config')), 'Bash cat ~/.aws/config blocked')
}

// ── SSH ─────────────────────────────────────────────────────────────────
console.log('\n2. SSH private keys and non-public ~/.ssh files')
{
  assert(blocked(read('~/.ssh/id_rsa')), 'id_rsa blocked')
  assert(blocked(read('~/.ssh/id_ed25519')), 'id_ed25519 blocked')
  assert(blocked(read('~/.ssh/id_ecdsa')), 'id_ecdsa blocked')
  assert(blocked(bash('cat ~/.ssh/some_custom_key')), 'other non-public ~/.ssh file blocked (catch-all)')
  assert(passes(read('~/.ssh/id_rsa.pub')), 'id_rsa.pub (public key) allowed')
  assert(passes(read('~/.ssh/known_hosts')), 'known_hosts allowed')
  assert(passes(bash('ssh host')), 'plain "ssh host" (running ssh, not reading a key) allowed')
  assert(passes(bash('ssh myserver "ls -la"')), 'plain ssh with a remote command allowed')
}

// ── netrc / npmrc / pypirc / docker / kube / gnupg ─────────────────────
console.log('\n3. other CLI credential files')
{
  assert(blocked(read('~/.netrc')), '~/.netrc blocked')
  assert(blocked(read('~/.npmrc')), '~/.npmrc blocked')
  assert(blocked(read('~/.pypirc')), '~/.pypirc blocked')
  assert(blocked(read('~/.docker/config.json')), '~/.docker/config.json blocked')
  assert(blocked(read('~/.kube/config')), '~/.kube/config blocked')
  assert(blocked(bash('cat ~/.gnupg/private-keys-v1.d/ABCDEF.key')), '~/.gnupg private key blocked')
  assert(blocked(bash('ls ~/.gnupg/')), '~/.gnupg directory listing blocked')
}

// ── macOS keychain ──────────────────────────────────────────────────────
console.log('\n4. macOS keychain')
{
  assert(blocked(bash('security dump-keychain')), 'security dump-keychain blocked')
  assert(blocked(bash('security find-generic-password -s x -w')), 'security find-generic-password blocked (pre-existing)')
  assert(blocked(bash('security find-internet-password -s example.com -w')), 'security find-internet-password blocked')
  // Decision: security list-keychains is ALLOWED. It only enumerates
  // keychain names/paths already on disk -- no secret material crosses the
  // boundary, so blocking it would be a false positive under this file's
  // "match specific paths/commands, not broad words" discipline.
  assert(passes(bash('security list-keychains')), 'security list-keychains allowed (lists names only, no secret material)')
}

// ── Browser-saved passwords / cookies ──────────────────────────────────
console.log('\n5. browser credential stores')
{
  assert(blocked(bash('cat "~/Library/Application Support/Google/Chrome/Default/Login Data"')), 'Chrome Login Data blocked')
  assert(blocked(bash('cat "~/Library/Application Support/Google/Chrome/Default/Cookies"')), 'Chrome Cookies blocked')
  assert(blocked(bash('cat "~/Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data"')), 'Brave Login Data blocked')
  assert(blocked(bash('cat "~/Library/Application Support/Microsoft Edge/Default/Cookies"')), 'Edge Cookies blocked')
  assert(blocked(bash('cat ~/Library/Application\\ Support/Firefox/Profiles/abc.default-release/logins.json')), 'Firefox logins.json blocked')
  assert(blocked(bash('cat ~/.mozilla/firefox/abc.default/key4.db')), 'Firefox key4.db (Linux profile path) blocked')
  assert(passes(bash('cat ~/Downloads/Cookies-recipe.txt')), 'unrelated file merely containing "Cookies" in its name allowed')
}

// ── .env: deliberately out of scope for this extension ─────────────────
console.log('\n6. .env (unchanged scope — see hook header comment)')
{
  // The brief asked to block .env reads outside the agent's DATA_HOME, but
  // this hook has no reliable "agent's own project directory" signal to
  // diff against (AGENT_DATA_HOME is the persona/memory home, not the
  // coding-project cwd) -- so generic .env matching was skipped rather than
  // risk blocking ordinary project .env reads. The pre-existing tool-home
  // shapes still apply.
  assert(blocked(bash('cat ~/.hermes/.env')), 'tool-home .env (~/.hermes/.env) still blocked (pre-existing rule, unchanged)')
  assert(passes(bash('cat ~/myrepo/.env')), 'an ordinary project .env is still not touched by this extension')
}

// ── fails open on garbage input (sanity) ────────────────────────────────
console.log('\n7. fails open on unparseable stdin')
{
  assert(spawnSync(process.execPath, [hook], { input: 'not json', encoding: 'utf8' }).status === 0, 'garbage stdin -> exit 0 (fail open)')
}

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
