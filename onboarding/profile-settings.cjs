'use strict'
const fs = require('node:fs')
const path = require('node:path')
const allowed = new Set(['MODEL', 'PROVIDER', 'EFFORT', 'LANGUAGE', 'DISPLAY_NAME_TYPE', 'CLAUDE_MODEL', 'CODEX_MODEL', 'OLLAMA_MODEL', 'AGENT_MODEL', 'AGENT_PROVIDER', 'REASONING_EFFORT'])
function cleanLines(text) {
  return text.split(/\r?\n/).filter(line => {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/)
    return match && allowed.has(match[1])
  }).join('\n')
}
function copySettings(source, target, name, enabled) {
  const copied = [], notCopied = ['.mcp.json', 'DISPLAY_NAME', 'credentials', 'memory.db', 'channel tokens', 'non-allowlisted config and env keys']
  let config = ''
  if (enabled) {
    try { config = cleanLines(fs.readFileSync(path.join(source, '.agent-config'), 'utf8')) } catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const file of ['CLAUDE.md', 'AGENTS.md', 'self_persona.md', 'system_prompt.md', '.env']) {
      const from = path.join(source, file)
      if (!fs.existsSync(from) || !fs.lstatSync(from).isFile()) continue
      let text = fs.readFileSync(from, 'utf8')
      if (file === '.env') text = cleanLines(text) + '\n'
      fs.writeFileSync(path.join(target, file), text, { mode: 0o600 }); copied.push(file)
    }
  }
  fs.writeFileSync(path.join(target, '.agent-config'), `${config ? config + '\n' : ''}PROFILE=${name}\n`, { flag: 'wx', mode: 0o600 })
  copied.unshift('.agent-config')
  fs.writeFileSync(path.join(target, '.profile-copy-receipt.json'), JSON.stringify({ copyFrom: enabled, copied, notCopied, allowedFields: [...allowed] }, null, 2) + '\n', { mode: 0o600 })
}
module.exports = { copySettings }
