'use strict'
// design-0029: paths are a pair; config labels never select a home.
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
function validateName(name) {
  if (typeof name !== 'string' || !/^[a-z0-9-]{1,24}$/.test(name) || name === 'default') throw new Error('Invalid profile name')
  return name
}
function parseProfile(argv) {
  let name = ''
  let seen = false
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--profile' || argv[i].startsWith('--profile=')) {
      if (seen) throw new Error('Duplicate --profile')
      seen = true
      name = validateName(argv[i] === '--profile' ? argv[++i] : argv[i].slice(10))
    }
  }
  return name
}
function profilePaths(name = '', { home = os.homedir(), appData } = {}) {
  if (name) validateName(name)
  const suffix = name ? `-${name}` : ''
  return { name, dataHome: path.join(home, 'Documents', `Scheherazade${suffix}`), userData: path.join(appData, `scheherazade${suffix}`), agentName: `scheherazade${suffix}` }
}
function profileFromHome(dataHome) {
  const base = path.basename(dataHome)
  const name = base.startsWith('Scheherazade-') ? base.slice(13) : ''
  try { return name ? validateName(name) : '' } catch { return '' }
}
function pidAlive(dataHome) {
  try {
    const raw = fs.readFileSync(path.join(dataHome, '.agent.pid'), 'utf8').trim()
    if (!/^[1-9][0-9]*$/.test(raw)) return false
    process.kill(Number(raw), 0)
    return true
  } catch (e) { return e.code === 'EPERM' }
}
function listProfiles({ home = os.homedir(), appData }) {
  const documents = path.join(home, 'Documents')
  let entries
  try { entries = fs.readdirSync(documents, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  return entries.filter(e => e.isDirectory() && (e.name === 'Scheherazade' || (e.name.startsWith('Scheherazade-') && (() => { try { validateName(e.name.slice(13)); return true } catch { return false } })())))
    .map(e => {
      const name = e.name === 'Scheherazade' ? '' : e.name.slice(13)
      const p = profilePaths(name, { home, appData })
      let displayName = 'Scheherazade'
      try { displayName = fs.readFileSync(path.join(p.dataHome, '.agent-config'), 'utf8').match(/^DISPLAY_NAME=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || displayName } catch {}
      return { name, displayName, running: pidAlive(p.dataHome), dataHome: p.dataHome, isDefault: !name }
    }).sort((a, b) => a.name.localeCompare(b.name))
}
function supervisorArgs(script, name) { return [script, '__loop', ...(name ? ['--profile', validateName(name)] : [])] }
// design-0029: a default signature must not accept a named sibling's prefix.
function matchesSupervisor(commandLine, signature, name) {
  const at = commandLine.indexOf(signature)
  if (at < 0) return false
  const tail = commandLine.slice(at + signature.length)
  return (!tail || /^\s/.test(tail)) && (name || !/^\s+--profile(?:=|\s)/.test(tail))
}
module.exports = { matchesSupervisor, validateName, parseProfile, profilePaths, profileFromHome, listProfiles, pidAlive, supervisorArgs }
