'use strict'
// design-0029: discovery is path-based; deletion always uses the OS Trash.
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const { spawn } = require('node:child_process')
const profiles = require('../../profile.cjs')
const siblings = require('../../sibling-profiles.cjs')
function createRoutes(ctx) {
  const { sendJson, readJsonBody, getElectron } = ctx
  const home = ctx.profileHome || os.homedir()
  const electron = () => getElectron()
  const options = () => ({ home, appData: electron().app.getPath('appData'), ...ctx.profileLiveness })
  const list = () => profiles.listProfiles(options())
  const route = (method, match, handler) => ({ method, match, handler: async (req, res, callCtx, m) => {
    try { await handler(req, res, m) }
    catch (e) { sendJson(res, e.status || 400, { ok: false, error: e.message }) }
  } })
  const fail = (message, status = 400) => { const e = new Error(message); e.status = status; throw e }
  const lookup = raw => {
    const name = decodeURIComponent(raw)
    // 'default' is a route alias only, never a valid named profile.
    if (name !== 'default') profiles.validateName(name)
    const p = list().find(p => p.name === (name === 'default' ? '' : name))
    if (!p) fail('Profile not found', 404)
    return p
  }
  const configFile = path.join(ctx.DATA_HOME, '.agent-config')
  const readConfig = () => { try { return fs.readFileSync(configFile, 'utf8') } catch { return '' } }
  const sharedEnabled = () => !/^SHARED_MEMORY_READ=(?:0|false|off)\s*$/mi.test(readConfig())
  return [
    route('POST', p => p.match(/^\/api\/profiles\/([^/]+)\/say$/), async (req, res, m) => {
      const { text } = await readJsonBody(req)
      const result = await siblings.say(ctx.DATA_HOME, decodeURIComponent(m[1]), text)
      if (ctx.getMemoryService) (await ctx.getMemoryService()).journalWrite({ body: `[다른 세라에게 말하기: ${decodeURIComponent(m[1])}] ${text}` })
      sendJson(res, 200, result)
    }),
    route('GET', p => p === '/api/profiles/settings', async (req, res) => sendJson(res, 200, { ok: true, sharedMemoryRead: sharedEnabled() })),
    route('POST', p => p === '/api/profiles/settings', async (req, res) => {
      const { sharedMemoryRead } = await readJsonBody(req)
      if (typeof sharedMemoryRead !== 'boolean') fail('sharedMemoryRead must be boolean')
      const config = readConfig().replace(/^SHARED_MEMORY_READ=.*(?:\n|$)/gm, '')
      fs.writeFileSync(configFile, config + (config && !config.endsWith('\n') ? '\n' : '') + `SHARED_MEMORY_READ=${sharedMemoryRead ? '1' : '0'}\n`, { mode: 0o600 })
      sendJson(res, 200, { ok: true, sharedMemoryRead })
    }),
    route('GET', p => p === '/api/profiles', async (req, res) => sendJson(res, 200, {
      ok: true, current: profiles.profileFromHome(ctx.DATA_HOME), profiles: list(), sharedMemoryRead: sharedEnabled(),
    })),
    route('POST', p => p === '/api/profiles', async (req, res) => {
      const { name, copyFrom = true } = await readJsonBody(req)
      if (typeof copyFrom !== "boolean") fail("copyFrom must be boolean")
      profiles.validateName(name)
      const p = profiles.profilePaths(name, options())
      if (fs.existsSync(p.dataHome)) fail('Profile already exists')
      if (!profiles.emptyUserData(p.userData)) fail('Profile userData is not empty')
      fs.mkdirSync(path.dirname(p.dataHome), { recursive: true })
      fs.mkdirSync(p.dataHome)
      fs.mkdirSync(p.userData, { recursive: true })
      require('../profile-settings.cjs').copySettings(ctx.DATA_HOME, p.dataHome, name, copyFrom)
      const created = list().find(p => p.name === name)
      const text = `${created.displayName}(${name})가 이 컴퓨터에 새로 생겼어`
      await Promise.all(list().filter(p => p.name !== name && p.running).map(p => siblings.post(p, { text, from: '시스템', sibling: true }).catch(() => {})))
      if (ctx.getMemoryService) {
        const service = await ctx.getMemoryService()
        service.journalWrite({ body: text })
      }
      sendJson(res, 200, { ok: true, profile: created })
    }),
    route('POST', p => p.match(/^\/api\/profiles\/([^/]+)\/(open|shortcut)$/), async (req, res, m) => {
      const p = lookup(m[1])
      const args = profiles.launchArgs(electron().app, p.name)
      if (m[2] === 'open') {
        // Never leak the current profile's env into a sibling/default launch.
        const env = { ...process.env }
        delete env.AGENT_DATA_HOME; delete env.AGENT_NAME; delete env.CHROMUX_HOME; delete env.ELECTRON_RUN_AS_NODE; delete env.SERA_PROFILE
        const child = (ctx.profileSpawn || spawn)(process.execPath, args, { detached: true, stdio: 'ignore', env })
        await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject) })
        child.unref()
        return sendJson(res, 200, { ok: true })
      }
      const label = p.name || 'default'
      const platform = ctx.profilePlatform || process.platform
      let file
      if (platform === 'win32') {
        file = path.join(electron().app.getPath('desktop'), `Sera-${label}.lnk`)
        if (!electron().shell.writeShortcutLink(file, 'create', { target: process.execPath, args: args.join(' '), description: `Sera ${label}` })) fail('Shortcut creation failed')
      } else if (platform === 'darwin') {
        file = path.join(p.dataHome, `Open-Sera-${label}.command`)
        fs.writeFileSync(file, `#!/bin/sh\nopen -n -a Scheherazade${p.name ? ` --args --profile ${p.name}` : ''}\n`, { mode: 0o755 })
        fs.chmodSync(file, 0o755)
      } else {
        const dir = path.join(home, '.local', 'share', 'applications')
        fs.mkdirSync(dir, { recursive: true })
        file = path.join(dir, `sera-${label}.desktop`)
        const executable = process.execPath.replace(/([\\"`$])/g, '\\$1').replace(/%/g, '%%')
        fs.writeFileSync(file, `[Desktop Entry]\nType=Application\nName=Sera ${label}\nExec="${executable}" ${args.join(' ')}\nTerminal=false\n`, { mode: 0o755 })
      }
      sendJson(res, 200, { ok: true, path: file })
    }),
    route('DELETE', p => p.match(/^\/api\/profiles\/([^/]+)$/), async (req, res, m) => {
      if (decodeURIComponent(m[1]) === 'default') fail('Cannot delete default profile')
      const p = lookup(m[1])
      if (p.isDefault) fail('Cannot delete default profile')
      if (p.running) fail('Profile is running', 409)
      // A live Electron window can exist without an agent pid yet.
      if (p.name === profiles.profileFromHome(ctx.DATA_HOME)) fail('Cannot delete current profile', 409)
      const userData = profiles.profilePaths(p.name, options()).userData
      // design-0029: never trash the paired key store if data-home trash fails.
      try { await electron().shell.trashItem(p.dataHome) } catch (e) { e.status = 500; throw e }
      if (fs.existsSync(userData)) {
        try { await electron().shell.trashItem(userData) } catch (e) {
          fail(`Data home moved to Trash; userData remains at ${userData}: ${e.message}`, 500)
        }
      }
      sendJson(res, 200, { ok: true })
    }),
  ]
}
module.exports = { createRoutes }
