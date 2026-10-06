// .agent-config written with a UTF-8 BOM and CRLF (Windows editors, PowerShell Set-Content)
// must parse the same as the LF file the app writes. 10-06: a CRLF copy made the app skip
// spawning its agent ("onboarding not complete yet") because ONBOARDING_COMPLETE read as '"1"\r'.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { readAgentConfig as readRuntime } from '../channel-runtime.mjs'
const require = createRequire(import.meta.url)
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'schz-cfg-'))
fs.writeFileSync(path.join(dir, '.agent-config'), '﻿AGENT_NAME="scheherazade"\r\nONBOARDING_COMPLETE="1"\r\nMODEL="x"\r\n')
const rt = await readRuntime(dir)
assert.equal(rt.AGENT_NAME, 'scheherazade')
assert.equal(rt.ONBOARDING_COMPLETE, '1')
// http-server's reader: same parse, exercised through its source text (its AGENT_CONFIG_PATH is module-bound).
const src = fs.readFileSync(new URL('../onboarding/http-server.cjs', import.meta.url), 'utf8')
const body = src.slice(src.indexOf('function readAgentConfig()'), src.indexOf('// 0.3.7 migrate-on-read'))
const fn = new Function('fs', 'AGENT_CONFIG_PATH', body + '\n  return out\n}\nreturn readAgentConfig()')
const hs = fn(fs, path.join(dir, '.agent-config'))
assert.equal(hs.AGENT_NAME, 'scheherazade')
assert.equal(hs.ONBOARDING_COMPLETE, '1')
assert.equal(hs.MODEL, 'x')
console.log('PASS agent-config: BOM + CRLF tolerated by both readers')
