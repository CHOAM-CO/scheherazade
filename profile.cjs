'use strict'
// design-0029: paths are a pair; config labels never select a home.
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')
const proc = require('./proc.cjs')
const { execFileSync } = require('node:child_process')
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
// design-0029: a recycled or foreign PID is not a running Sera.
function pidAlive(dataHome, { name = '', readCommandLine = proc.readCommandLine, kill = process.kill, supervisorPath = path.join(__dirname, 'supervisor.mjs') } = {}) {
  try {
    const raw = fs.readFileSync(path.join(dataHome, '.agent.pid'), 'utf8').trim()
    if (!/^[1-9][0-9]*$/.test(raw)) return false
    kill(Number(raw), 0) // EPERM is unverified, not ours.
    const command = readCommandLine(Number(raw))
    const scripts = [supervisorPath, supervisorPath.replace(/app\.asar([\\/])/, 'app.asar.unpacked$1')]
    return scripts.some(script => matchesSupervisor(command, supervisorArgs(script, name).join(' '), name))
  } catch { return false }
}
function hasProfileArgument(command, name) {
  return new RegExp(`(?:^|\\s)--profile(?:=|\\s+)${validateName(name)}(?=\\s|$)`).test(command)
}
function processCommands() {
  if (process.platform === 'win32') {
    const json = execFileSync(proc.POWERSHELL_EXE, ['-NoProfile', '-Command', 'Get-CimInstance Win32_Process | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress'], { encoding: 'utf8', windowsHide: true })
    const rows = JSON.parse(json || '[]')
    return (Array.isArray(rows) ? rows : [rows]).map(row => ({ pid: row.ProcessId, command: row.CommandLine || '' }))
  }
  return execFileSync('ps', ['-axww', '-o', 'pid=,command='], { encoding: 'utf8' }).trim().split('\n').map(line => {
    const m = line.trim().match(/^(\d+)\s+(.*)$/)
    return m ? { pid: Number(m[1]), command: m[2] } : { pid: 0, command: '' }
  })
}
// design-0029: the Electron window can hold the home without an agent yet.
function windowRunning(userData, name, { kill = process.kill, readCommandLine = proc.readCommandLine, listCommands = processCommands } = {}) {
  if (!name) return false
  try {
    const pid = Number(fs.readlinkSync(path.join(userData, 'SingletonLock')).match(/-(\d+)$/)?.[1])
    if (pid > 0) { kill(pid, 0); if (hasProfileArgument(readCommandLine(pid), name)) return true }
  } catch {}
  try {
    return listCommands().some(row => {
      if (!hasProfileArgument(row.command, name)) return false
      try { kill(Number(row.pid), 0); return true } catch { return false }
    })
  } catch { return false }
}
function configureEnvironment(name, paths, env) {
  env.SERA_PROFILE = name // explicit identity, never inferred from a custom data-home basename.
  if (!name) return
  env.AGENT_DATA_HOME = paths.dataHome
  env.AGENT_NAME = paths.agentName
  env.CHROMUX_HOME = path.join(paths.dataHome, '.chromux')
}
function emptyUserData(dir) {
  try { return fs.lstatSync(dir).isDirectory() && fs.readdirSync(dir).length === 0 }
  catch (e) { if (e.code === 'ENOENT') return true; throw e }
}
function cleanupEmptyUserData(dir) {
  try { fs.rmdirSync(dir) } catch (e) { if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(e.code)) throw e }
}
function ensureProfileConfig(dataHome, name) {
  fs.mkdirSync(dataHome, { recursive: true })
  const file = path.join(dataHome, '.agent-config')
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch (e) { if (e.code !== 'ENOENT') throw e }
  if (!/^PROFILE=/m.test(text)) fs.writeFileSync(file, text + (text && !text.endsWith('\n') ? '\n' : '') + `PROFILE=${validateName(name)}\n`, { mode: 0o600 })
}
function launchArgs(app, name) {
  return [...(app.isPackaged ? [] : [app.getAppPath()]), ...(name ? ['--profile', validateName(name)] : [])]
}
function listProfiles({ home = os.homedir(), appData, ...liveness }) {
  const documents = path.join(home, 'Documents')
  let entries
  try { entries = fs.readdirSync(documents, { withFileTypes: true }) } catch (e) { if (e.code === 'ENOENT') return []; throw e }
  return entries.filter(e => e.isDirectory() && (e.name === 'Scheherazade' || (e.name.startsWith('Scheherazade-') && (() => { try { validateName(e.name.slice(13)); return true } catch { return false } })())))
    .map(e => {
      const name = e.name === 'Scheherazade' ? '' : e.name.slice(13)
      const p = profilePaths(name, { home, appData })
      let displayName = 'Scheherazade'
      try { displayName = fs.readFileSync(path.join(p.dataHome, '.agent-config'), 'utf8').match(/^DISPLAY_NAME=(.*)$/m)?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2') || displayName } catch {}
      return { name, displayName, running: pidAlive(p.dataHome, { ...liveness, name }) || windowRunning(p.userData, name, liveness), dataHome: p.dataHome, isDefault: !name }
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
module.exports = { configureEnvironment, emptyUserData, cleanupEmptyUserData, ensureProfileConfig, launchArgs, windowRunning, processCommands, hasProfileArgument, matchesSupervisor, validateName, parseProfile, profilePaths, profileFromHome, listProfiles, pidAlive, supervisorArgs }
