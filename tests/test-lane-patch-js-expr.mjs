// Regression (2026-10-13, 0.4.4): mergeLanePatch round-tripped the generated
// lane patch through the `yaml` package, which dropped the `!!js` tag on the
// channel-token passthrough scalars. The engine then received the literal
// string "process.env.SLACK_BOT_TOKEN" as its Slack token -> auth.test
// invalid_auth -> FATAL restart loop for every Slack/Discord/Telegram user who
// had a lane.patch.yml with providers. The tag must survive the merge verbatim.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const lp = require('../lane-providers.cjs')

let fails = 0
function check(name, ok) { console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}`); if (!ok) fails++ }

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-js-expr-'))
fs.writeFileSync(path.join(home, 'lane.patch.yml'),
  '- id: llm-pi-ai\n  config:\n    providers:\n      myollama:\n        api: openai-completions\n        baseURL: http://127.0.0.1:11434/v1\n        models:\n          - id: m\n')
const generated = [
  '- id: llm-pi-ai', '  config:', '    providers:', '      anthropic:', '        api: anthropic',
  '- id: channel-slack', '  config:', '    env:',
  '      SLACK_BOT_TOKEN: !!js process.env.SLACK_BOT_TOKEN',
  '      SLACK_APP_TOKEN: !!js process.env.SLACK_APP_TOKEN',
  '      DISCORD_BOT_TOKEN: !!js process.env.DISCORD_BOT_TOKEN',
  '      TELEGRAM_BOT_TOKEN: !!js process.env.TELEGRAM_BOT_TOKEN', '',
].join('\n')

const out = lp.mergeLanePatch(generated, home, {})
for (const k of ['SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN', 'DISCORD_BOT_TOKEN', 'TELEGRAM_BOT_TOKEN']) {
  check(`${k} keeps its !!js tag through the merge`, out.includes(`${k}: !!js process.env.${k}`))
  check(`${k} is not emitted as a plain string`, !new RegExp(`${k}: process\\.env\\.${k}`).test(out))
}
check('user lane provider merged', out.includes('myollama'))
check('generated provider kept', out.includes('anthropic:'))

// No lane.patch.yml -> the generated text passes through untouched.
const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'lane-js-expr-empty-'))
check('no lane.patch.yml -> generated returned verbatim', lp.mergeLanePatch(generated, empty, {}) === generated)

// The dsh loader dialect (js-yaml + the !!js type) still reads the merged text.
const yaml = require('js-yaml')
const JsExpr = new yaml.Type('tag:yaml.org,2002:js', { kind: 'scalar', resolve: () => true, construct: (d) => ({ __jsExpr: d }) })
const rows = yaml.load(out, { schema: yaml.JSON_SCHEMA.extend(JsExpr) })
const slack = rows.find((r) => r.id === 'channel-slack')
check('dsh dialect parses the merged token as an expression node', slack?.config?.env?.SLACK_BOT_TOKEN?.__jsExpr === 'process.env.SLACK_BOT_TOKEN')

fs.rmSync(home, { recursive: true, force: true }); fs.rmSync(empty, { recursive: true, force: true })
console.log(fails ? `${fails} failed` : 'all passed')
process.exit(fails ? 1 : 0)
