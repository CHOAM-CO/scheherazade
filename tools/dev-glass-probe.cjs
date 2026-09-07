// dev-glass-probe.cjs — frosted-glass reproduction window, NO harness.
// Boots a bare BrowserWindow with the exact glassOptions main.cjs uses and
// a static page whose panels sweep --frost-alpha values, so one eye look
// (or one screen capture) answers both "does the effect render at all" and
// "which alpha is right". Never touches AGENT_DATA_HOME or the agent.
//
// Run: npx electron tools/dev-glass-probe.cjs [vibrancy-material] [clear]
//   e.g. npx electron tools/dev-glass-probe.cjs        (under-window, prod)
//        npx electron tools/dev-glass-probe.cjs hud    (material A/B)
//        npx electron tools/dev-glass-probe.cjs under-window clear
//          (adds backgroundColor '#00000000' — the known Electron recipe for
//           when the renderer's opaque base layer hides the effect)
'use strict'

const os = require('node:os')
const path = require('node:path')
const { app, BrowserWindow } = require('electron')
const { glassOptions } = require(path.join(__dirname, '..', 'window-glass.cjs'))

const materialOverride = process.argv[2] || null
const clearBase = process.argv.includes('clear')

const page = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin:0; height:100%; background: transparent; font-family: -apple-system, sans-serif; color:#e6e6e6; }
  .col { display:flex; flex-direction:column; height:100%; }
  .band { flex:1; display:flex; align-items:center; padding-left:16px; font-size:15px; }
</style><div class="col">
  <div class="band" style="background:rgba(17,18,20,0.82)">alpha 0.82 (current prod)</div>
  <div class="band" style="background:rgba(17,18,20,0.70)">alpha 0.70</div>
  <div class="band" style="background:rgba(17,18,20,0.60)">alpha 0.60</div>
  <div class="band" style="background:rgba(17,18,20,0.50)">alpha 0.50</div>
  <div class="band" style="background:transparent">alpha 0 (raw effect)</div>
</div>`

const backdropPage = `<!doctype html><meta charset="utf-8"><style>
  html, body { margin:0; height:100%;
    background: linear-gradient(120deg, #ff5f6d, #ffc371 30%, #38ef7d 60%, #4facfe 100%); }
  .dot { position:absolute; width:120px; height:120px; border-radius:50%; background:#fff; opacity:0.85; }
</style><div class="dot" style="left:15%;top:20%"></div>
<div class="dot" style="left:45%;top:55%;background:#111"></div>
<div class="dot" style="left:75%;top:30%"></div>`

app.whenReady().then(() => {
  if (process.argv.includes('backdrop')) {
    // Vivid full-screen window to sit UNDER the probes: blur is invisible
    // over a flat dark desktop, so give it something to smear.
    // NOT fullscreen on mac — macOS fullscreen moves the window to its own
    // Space, leaving the probes on the desktop with nothing behind them.
    const bg = process.platform === 'darwin'
      ? new BrowserWindow({ x: 0, y: 0, width: 1800, height: 1100, title: 'glass-backdrop' })
      : new BrowserWindow({ fullscreen: true, title: 'glass-backdrop' })
    bg.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(backdropPage))
    return
  }
  const opts = glassOptions(process.platform, os.release())
  if (materialOverride && materialOverride !== 'clear' && process.platform === 'darwin') opts.vibrancy = materialOverride
  if (clearBase) opts.backgroundColor = '#00000000'
  // electron#46164: followWindow doesn't just dim vibrancy on inactive
  // windows — it drops it entirely on modern macOS. 'active' pins it on.
  if (process.argv.includes('activeState')) opts.visualEffectState = 'active'
  console.log('[glass-probe] glassOptions =>', JSON.stringify(opts))
  const win = new BrowserWindow({
    width: 560,
    height: 480,
    // Cascade + alwaysOnTop: probes launched into a remote interactive
    // session land BEHIND whatever is focused there; without this the
    // desktop screenshot shows no probe at all (caught live 2026-08-05).
    x: 120 + 300 * (Number(process.env.PROBE_SLOT) || (clearBase ? 2 : 0)),
    y: 120 + 40 * (Number(process.env.PROBE_SLOT) || 0),
    // NOTE: alwaysOnTop windows can vanish from screen-capture source lists
    // (Chrome getDisplayMedia picker, macOS) — PROBE_NOTOP=1 disables it
    // when a probe needs to be capturable rather than visible-over-everything.
    alwaysOnTop: !process.env.PROBE_NOTOP,
    title: `glass-probe ${materialOverride || opts.vibrancy || opts.backgroundMaterial || 'flat'}${clearBase ? ' +clear' : ''}${process.argv.includes('activeState') ? ' +active' : ''}`,
    ...opts,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(page))
})
app.on('window-all-closed', () => app.quit())
