// waiting.js — Step 4 "나중에 하기" fallback screen. Status + a single CTA
// back into the Discord tutorial; intentionally no chat surface here.
;(function () {
  const C = window.COPY.waiting

  function $(id) { return document.getElementById(id) }

  async function api(path) {
    const res = await fetch(path)
    const body = await res.json()
    if (!res.ok) throw new Error(body.error || `HTTP ${res.status} from ${path}`)
    return body
  }

  async function init() {
    let displayName = 'Scheherazade'
    try {
      const cfg = await api('/api/config')
      displayName = cfg.DISPLAY_NAME || displayName
    } catch (err) {
      console.error(err)
    }
    $('w-title').textContent = C.title
    $('w-banner').textContent = C.banner(displayName)
    $('w-resume').textContent = C.resumeButton
    $('w-resume').onclick = () => {
      window.location.href = '/?step=4'
    }
    // See waiting.html's comment: this screen had no route to the rest of
    // the app at all.
    //
    // The `||` fallbacks are not defensive noise. A missing copy key here
    // renders a BLANK button -- not a visibly broken one, an invisible one
    // that still navigates when clicked (caught exactly this way during the
    // 2026-07-25 pass, before the keys landed). A wrong-but-present label is
    // a bug someone reports; a blank one is a bug nobody can describe.
    $('w-settings').textContent = C.openSettings || 'Settings'
    $('w-settings').onclick = () => { window.location.href = '/settings' }
    $('w-logs').textContent = C.openLogs || 'Logs'
    $('w-logs').onclick = () => { window.location.href = '/logs' }
  }

  init()
})()
