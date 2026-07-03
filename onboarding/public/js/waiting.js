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
    let displayName = '세헤라자드'
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
  }

  init()
})()
