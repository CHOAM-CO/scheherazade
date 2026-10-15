'use strict'
const fs = require('node:fs')
const path = require('node:path')
const secret = /TOKEN|KEY|SECRET|PASSWORD|CHANNEL|DISCORD|SLACK|TELEGRAM/i
function cleanLines(text) {
  return text.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    return match && !secret.test(match[1]) && !['PROFILE', 'AGENT_DATA_HOME', 'AGENT_NAME', 'CHROMUX_HOME', 'SERA_PROFILE'].includes(match[1])
  }).join('\n')
}
function copySettings(source, target, name, enabled) {
  const copied = []
  let config = ''
  if (enabled) {
    try { config = cleanLines(fs.readFileSync(path.join(source, '.agent-config'), 'utf8')) } catch {}
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'self_persona.md', 'system_prompt.md', '.mcp.json', '.env']) {
      const from = path.join(source, file)
      if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue
      let text = fs.readFileSync(from, 'utf8')
      if (file === '.env') text = cleanLines(text) + '\n'
      if (file === '.mcp.json') {
        const scrub = value => Array.isArray(value) ? value.map(scrub) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).filter(([key]) => !secret.test(key)).map(([key, val]) => [key, scrub(val)])) : value
        text = JSON.stringify(scrub(JSON.parse(text)), null, 2) + '\n'
      }
      fs.writeFileSync(path.join(target, file), text, { mode: 0o600 }); copied.push(file)
    }
  }
  fs.writeFileSync(path.join(target, '.agent-config'), `${config ? config + '\n' : ''}PROFILE=${name}\n`, { flag: 'wx', mode: 0o600 })
  copied.unshift('.agent-config')
  fs.writeFileSync(path.join(target, '.profile-copy-receipt.json'), JSON.stringify({ copyFrom: enabled, copied }, null, 2) + '\n', { mode: 0o600 })
}
module.exports = { copySettings }
