#!/usr/bin/env node
// dev-serve-ui.mjs — boot ONLY the onboarding HTTP server, in plain node, so
// the UI can be opened/screenshotted without launching Electron.
// Run: AGENT_DATA_HOME=/tmp/scheherazade-uidev node tools/dev-serve-ui.mjs
//
// SANDBOX YOUR DATA_HOME. createOnboardingServer() runs first-boot side
// effects (seedConfigFromTemplates, ensureMcpJsonAgentName,
// ensureClaudeOnboardingDone, refreshHarnessIfOnboarded) that WRITE to the
// config dir. Without AGENT_DATA_HOME set, that dir is the real
// ~/Documents/Scheherazade -- i.e. a live install's config. This script
// refuses to start unless AGENT_DATA_HOME is set to something else.
//
// Electron-dependent routes (safeStorage credential read/write, shell.open*,
// systemPreferences permission probes) will fail here -- getElectron()
// throws outside an Electron process. That is fine and expected: this exists
// for LAYOUT and COPY work, not for exercising provider/permission flows.

import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'

const require = createRequire(import.meta.url)

const dataHome = process.env.AGENT_DATA_HOME
const realHome = path.join(os.homedir(), 'Documents', 'Scheherazade')
if (!dataHome || path.resolve(dataHome) === path.resolve(realHome)) {
  console.error('refusing to start: set AGENT_DATA_HOME to a scratch dir first')
  console.error(`  e.g. AGENT_DATA_HOME=/tmp/scheherazade-uidev node ${process.argv[1]}`)
  console.error(`  (must not be the live install at ${realHome})`)
  process.exit(1)
}

const { createOnboardingServer, bootPathFor } = require('../onboarding/http-server.cjs')

const { server } = await createOnboardingServer()
const { port } = server.address()
// URLs go through /boot (page-scrape fix, 2026-08-07): HTML now requires
// the UI session cookie, and /boot is how a browser acquires it. A bare
// page URL would 403.
console.log(`UI_PORT=${port}`)
console.log(`  wizard    http://127.0.0.1:${port}${bootPathFor('/')}`)
for (const p of ['channels', 'memory', 'connectors', 'settings', 'logs', 'waiting']) {
  console.log(`  ${p.padEnd(9)} http://127.0.0.1:${port}${bootPathFor('/' + p)}`)
}
