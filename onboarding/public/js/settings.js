// settings.js — settings page: rename agent + agent model/effort config
// (moved from memory.js's agent control panel, subpage split 2026-07-14) +
// autonomous cycle. Provider auth + Slack moved to connectors.js.
;(function () {
  const C = window.COPY.settings
  const GEN = window.COPY.genericError

  function $(id) { return document.getElementById(id) }

  // window.api() / window.showToast() now live in nav.js (loaded before this
  // file on settings.html) -- consolidated from what used to be local copies
  // here and in memory.js.

  // ── autonomous cycle (v0.0.6) ──────────────────────────────────────────
  // This section shows the user a number that is being spent on their behalf
  // while they sleep, so it is written to be un-flatterable:
  //   - the token count is the SAME number the cap is enforced against
  //   - when the meter cannot measure, it says that instead of showing 0
  //   - "used 0 tokens" and "cannot tell you how many tokens" never render
  //     the same way, because only one of them means nothing was spent
  const fmtTokens = (n) => Number(n || 0).toLocaleString()

  function renderAutonomy(a) {
    $('set-autonomy-enabled').checked = a.enabled === true
    $('set-autonomy-start').value = a.windowStart
    $('set-autonomy-end').value = a.windowEnd
    $('set-autonomy-cap').value = String(a.cap)

    const usageEl = $('set-autonomy-usage')
    if (a.today && a.today.ok) {
      // Today's TOTAL -- the owner's own conversations included. This is not the
      // number the cap is enforced against (that one is per-night), and the copy
      // says so rather than letting one label cover two measurements.
      usageEl.textContent = `${C.autonomyUsageLabel}: ${fmtTokens(a.today.total)}`
    } else {
      // Not a blank, not a zero. The one sentence the user must never be
      // shown wrongly is "you spent nothing".
      usageEl.textContent = C.autonomyUsageBlind
    }

    const lastEl = $('set-autonomy-last')
    if (a.lastCycle && a.lastCycle.day) {
      const bits = [a.lastCycle.stopped ? C.autonomyLastCycleStopped : C.autonomyLastCycleRan]
      if (typeof a.lastCycle.used === 'number') bits.push(`${fmtTokens(a.lastCycle.used)} ${C.autonomyTokensWord}`)
      if (a.lastCycle.briefed) bits.push(C.autonomyLastCycleBriefed)
      lastEl.textContent = `${C.autonomyLastCycle} (${a.lastCycle.day}): ${bits.join(' / ')}`
    } else if (a.lastSkip) {
      lastEl.textContent = a.lastSkip.reason === 'cap' ? C.autonomySkipCap : C.autonomySkipMeter
    } else {
      lastEl.textContent = C.autonomyLastCycleNone
    }
  }

  async function loadAutonomy() {
    renderAutonomy(await api('/api/autonomy'))
  }

  async function saveAutonomy() {
    const statusEl = $('set-autonomy-status')
    statusEl.classList.add('hidden')
    const cap = Number(String($('set-autonomy-cap').value).replace(/[,\s]/g, ''))
    if (!Number.isFinite(cap) || cap < 0) {
      statusEl.textContent = C.autonomyInvalidCap
      statusEl.classList.remove('hidden')
      return
    }
    const btn = $('set-autonomy-save')
    btn.disabled = true
    try {
      await api('/api/autonomy', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          enabled: $('set-autonomy-enabled').checked,
          windowStart: $('set-autonomy-start').value.trim(),
          windowEnd: $('set-autonomy-end').value.trim(),
          cap,
        }),
      })
      showToast(C.autonomySaved)
      await loadAutonomy() // re-read from the server, never trust the form
    } catch (err) {
      statusEl.textContent = /HH:MM|window/.test(err.message) ? C.autonomyInvalidWindow : GEN(err.message)
      statusEl.classList.remove('hidden')
    } finally {
      btn.disabled = false
    }
  }

  // ── avatar crop dialog (2026-09-28) ─────────────────────────────────────
  // The upload used to be take-it-or-leave-it: the raw file was stored as-is
  // and the only crop happened at display time, where it always takes the
  // centre. A wide photo lost both ends, a tall one lost the face, and the
  // owner had no say ("크기가 너무 작고 조절할 수가 없다"). This is the say: a
  // FIXED 1:1 viewport they drag and zoom, and what is inside it is exactly
  // what gets stored.
  //
  // Built with createElement/textContent like the rest of this page. nav.js's
  // dialog uses innerHTML because it only ever writes its own literal markup;
  // nothing here is interpolated at all -- not the picked filename, nothing
  // from the file -- so the injection posture is trivially kept.
  //
  // Geometry, kept in ONE place because the canvas draw has to agree with the
  // screen: the image is drawn at
  //   w = natW * cover * zoom,  h = natH * cover * zoom
  // where cover = viewport / min(natW, natH) is the "fill the square" fit. So
  // zoom >= 1 (the range's min) keeps it >= the viewport on BOTH axes, and the
  // only way to bare a corner would be an offset clamp bug -- which is why the
  // offsets are clamped to [viewport - w, 0] on every open, move and zoom.
  const CROP_VIEWPORT = 240 // must match .avatar-crop-viewport in app.css
  const CROP_OUT = 256 // stored picture is 256x256 (the shipped icon's size)

  // Resolves the stored blob (image/png) or null if the user cancelled or the
  // picture could not be decoded. `onDecodeFail` is the caller's way to show
  // its own status line -- this helper owns no status element.
  function openAvatarCrop(file, onDecodeFail) {
    return new Promise((resolve) => {
      // The picked file is shown from an OBJECT URL, never a data URL: it is
      // revoked the moment the dialog closes, so the photo is not held in
      // memory as a base64 string we keep around.
      const url = URL.createObjectURL(file)
      const backdrop = document.createElement('div')
      backdrop.className = 'dialog-backdrop hidden'
      const box = document.createElement('div')
      box.className = 'dialog-box'
      const title = document.createElement('p')
      title.textContent = C.avatarCropTitle
      const viewport = document.createElement('div')
      viewport.className = 'avatar-crop-viewport'
      const img = document.createElement('img')
      img.className = 'avatar-crop-image'
      img.alt = ''
      img.draggable = false
      img.src = url
      viewport.appendChild(img)
      const zoomRow = document.createElement('div')
      zoomRow.className = 'avatar-crop-zoom'
      const zoomLabel = document.createElement('label')
      zoomLabel.className = 'avatar-crop-zoom-label'
      zoomLabel.setAttribute('for', 'avatar-crop-zoom')
      zoomLabel.textContent = C.avatarCropZoom
      const zoomInput = document.createElement('input')
      zoomInput.type = 'range'
      zoomInput.id = 'avatar-crop-zoom'
      zoomInput.min = '1'
      zoomInput.max = '4'
      zoomInput.step = '0.01'
      zoomInput.value = '1'
      zoomRow.appendChild(zoomLabel)
      zoomRow.appendChild(zoomInput)
      const hint = document.createElement('p')
      hint.className = 'avatar-crop-hint'
      hint.textContent = C.avatarCropHint
      const actions = document.createElement('div')
      actions.className = 'dialog-actions'
      const cancelBtn = document.createElement('button')
      cancelBtn.className = 'secondary'
      cancelBtn.textContent = C.avatarCropCancel
      const saveBtn = document.createElement('button')
      saveBtn.textContent = C.avatarCropSave
      actions.appendChild(cancelBtn)
      actions.appendChild(saveBtn)
      box.appendChild(title)
      box.appendChild(viewport)
      box.appendChild(zoomRow)
      box.appendChild(hint)
      box.appendChild(actions)
      backdrop.appendChild(box)
      document.body.appendChild(backdrop)

      // natW/natH in source pixels; z is the user's zoom on top of the cover
      // fit; offX/offY are the image's top-left inside the viewport, in CSS px
      // (the units the pointer events speak and the units the canvas draw
      // divides back out of source pixels).
      let natW = 1
      let natH = 1
      let cover = 1
      let z = 1
      let offX = 0
      let offY = 0
      let drag = null
      let closed = false

      const clampOffsets = () => {
        const w = natW * cover * z
        const h = natH * cover * z
        offX = Math.min(0, Math.max(CROP_VIEWPORT - w, offX))
        offY = Math.min(0, Math.max(CROP_VIEWPORT - h, offY))
      }
      const render = () => {
        clampOffsets()
        img.style.width = `${natW * cover * z}px`
        img.style.height = `${natH * cover * z}px`
        img.style.left = `${offX}px`
        img.style.top = `${offY}px`
      }
      const close = (result) => {
        if (closed) return
        closed = true
        document.removeEventListener('keydown', onKey)
        // The bytes are already read (or the dialog was abandoned), so the
        // object URL has no further reader and must not outlive the dialog.
        URL.revokeObjectURL(url)
        backdrop.remove()
        resolve(result)
      }
      const onKey = (e) => {
        if (e.key === 'Escape') {
          e.preventDefault()
          close(null)
        }
      }

      // Zoom keeps the point that is at the viewport's CENTRE at the centre,
      // so the picture grows around what the user is looking at instead of
      // sliding out from under the pointer.
      zoomInput.oninput = () => {
        const next = Number(zoomInput.value) || 1
        const cx = (CROP_VIEWPORT / 2 - offX) / (cover * z)
        const cy = (CROP_VIEWPORT / 2 - offY) / (cover * z)
        z = next
        offX = CROP_VIEWPORT / 2 - cx * cover * z
        offY = CROP_VIEWPORT / 2 - cy * cover * z
        render()
      }

      // Pointer events, not mouse events: one code path for mouse, touch and
      // pen. setPointerCapture keeps the drag alive when the pointer leaves
      // the square, which is otherwise a dropped picture mid-gesture.
      viewport.addEventListener('pointerdown', (e) => {
        if (e.pointerType === 'mouse' && e.button !== 0) return
        drag = { id: e.pointerId, x: e.clientX, y: e.clientY }
        viewport.classList.add('dragging')
        viewport.setPointerCapture(e.pointerId)
        e.preventDefault()
      })
      viewport.addEventListener('pointermove', (e) => {
        if (!drag || e.pointerId !== drag.id) return
        offX += e.clientX - drag.x
        offY += e.clientY - drag.y
        drag.x = e.clientX
        drag.y = e.clientY
        render()
      })
      const endDrag = (e) => {
        if (!drag || e.pointerId !== drag.id) return
        drag = null
        viewport.classList.remove('dragging')
        if (viewport.hasPointerCapture(e.pointerId)) viewport.releasePointerCapture(e.pointerId)
      }
      viewport.addEventListener('pointerup', endDrag)
      viewport.addEventListener('pointercancel', endDrag)

      img.onload = () => {
        natW = img.naturalWidth || 1
        natH = img.naturalHeight || 1
        // "cover": the SHORTER side exactly fills the square, the longer one
        // overhangs; start centred and let the user move from there.
        cover = CROP_VIEWPORT / Math.min(natW, natH)
        z = 1
        zoomInput.value = '1'
        offX = (CROP_VIEWPORT - natW * cover) / 2
        offY = (CROP_VIEWPORT - natH * cover) / 2
        render()
        document.addEventListener('keydown', onKey)
        backdrop.classList.remove('hidden')
      }
      img.onerror = () => {
        close(null)
        if (onDecodeFail) onDecodeFail()
      }

      cancelBtn.onclick = () => close(null)
      saveBtn.onclick = () => {
        const canvas = document.createElement('canvas')
        canvas.width = CROP_OUT
        canvas.height = CROP_OUT
        const ctx = canvas.getContext('2d')
        // What is on screen inside the square, at full source resolution: the
        // viewport rect divided by the drawn scale (cover * z) gives the source
        // rect, and the square is drawn out at CROP_OUT. The canvas is what
        // makes the stored file square -- the server never crops.
        const scale = cover * z
        ctx.drawImage(
          img,
          -offX / scale, -offY / scale,
          CROP_VIEWPORT / scale, CROP_VIEWPORT / scale,
          0, 0, CROP_OUT, CROP_OUT,
        )
        // drawImage is synchronous (the pixels are in the canvas already), so
        // closing here -- which revokes the source object URL -- is safe.
        canvas.toBlob((blob) => close(blob || null), 'image/png')
      }
    })
  }

  async function init() {
    $('set-title').textContent = C.title
    // Three group headings (IA pass 2026-07-25) -- see settings.html.
    // Fallbacks for the same reason waiting.js carries them: a missing key
    // here collapses a group heading to empty space, which reads as a layout
    // bug rather than a copy bug and is much harder to trace back.
    $('set-group-agent').textContent = C.groupAgent || 'Agent'
    $('set-group-system').textContent = C.groupSystem || 'System'

    // ── import from other agents (design-0022, the owner 20:13 "에이전트가
    // 싹 다 긁어서 '제가 이제 챙길게요'"). Settings is the always-there
    // surface; the wizard step reuses the same endpoints later. This UI
    // is ONLY the consent gate -- the agent performs the sweep itself,
    // live in chat, after POST /api/migrate/start. ─────────────────────
    $('set-group-migrate').textContent = C.groupMigrate || 'Import'
    $('set-migrate-label').textContent = C.migrateLabel || 'Other agents'
    $('set-migrate-hint').textContent = C.migrateHint || ''
    const migTools = $('set-migrate-tools')
    const migStatus = $('set-migrate-status')
    const migStart = $('set-migrate-start')
    migStart.textContent = C.migrateStartButton
    migStart.disabled = true
    const migChecks = new Map() // id -> checkbox
    api('/api/migrate/detect').then((d) => {
      const found = (d.tools || []).filter((t) => t.detected)
      if (!found.length) {
        migStatus.textContent = C.migrateNoneFound
        return
      }
      for (const t of found) {
        const row = document.createElement('label')
        row.className = 'migrate-tool-row'
        const cb = document.createElement('input')
        cb.type = 'checkbox'
        cb.checked = true
        cb.onchange = () => { migStart.disabled = ![...migChecks.values()].some((c) => c.checked) }
        migChecks.set(t.id, cb)
        row.appendChild(cb)
        const span = document.createElement('span')
        span.textContent = C.migrateToolLine(t.label, t.files.length, t.truncated)
        span.title = t.root
        row.appendChild(span)
        migTools.appendChild(row)
      }
      migStart.disabled = false
    }).catch(() => { migStatus.textContent = C.migrateNoneFound })
    migStart.onclick = async () => {
      const ids = [...migChecks.entries()].filter(([, cb]) => cb.checked).map(([id]) => id)
      if (!ids.length) return
      migStart.disabled = true
      migStatus.className = 'status-line pending'
      migStatus.textContent = C.migrateStarting
      try {
        const r = await api('/api/migrate/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ tools: ids }),
        })
        migStatus.className = 'status-line success'
        migStatus.textContent = r.delivery === 'live' ? C.migrateStartedLive : C.migrateStartedQueued
      } catch (err) {
        migStatus.className = 'status-line failure'
        migStatus.textContent = GEN(err.message)
        migStart.disabled = false
      }
    }

    // ── handover: custom-path source (design-0023, the owner 2026-08-05
    // "persona.md / agents.md 같은 시스템프롬프트류 파일 긁어서 구조파악하고
    // ... 흡수"). Preview first (names only), then the same one-consent
    // sweep — but structure-map-first, since nobody knows this layout. ──
    $('set-handover-label').textContent = C.handoverLabel
    $('set-handover-hint').textContent = C.handoverHint
    // rev B primary: one click hands the HUNT to the agent (mdfind by
    // marker filename, candidates + per-folder consent live in chat).
    const hoDiscover = $('set-handover-discover')
    const hoDiscoverStatus = $('set-handover-discover-status')
    hoDiscover.textContent = C.handoverDiscoverButton
    hoDiscover.onclick = async () => {
      hoDiscover.disabled = true
      hoDiscoverStatus.className = 'status-line pending'
      hoDiscoverStatus.textContent = C.migrateStarting
      try {
        const r = await api('/api/migrate/custom/discover', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        hoDiscoverStatus.className = 'status-line success'
        hoDiscoverStatus.textContent = r.delivery === 'live' ? C.migrateStartedLive : C.migrateStartedQueued
      } catch (err) {
        hoDiscoverStatus.className = 'status-line failure'
        hoDiscoverStatus.textContent = GEN(err.message)
        hoDiscover.disabled = false
      }
    }
    $('set-handover-manual-hint').textContent = C.handoverManualHint
    const hoPath = $('set-handover-path')
    const hoCheck = $('set-handover-check')
    const hoStatus = $('set-handover-status')
    const hoStart = $('set-handover-start')
    hoPath.placeholder = C.handoverPlaceholder
    hoCheck.textContent = C.handoverCheckButton
    hoStart.textContent = C.migrateStartButton
    hoStart.classList.add('hidden')
    let hoPreviewedRoot = null
    hoPath.oninput = () => { hoStart.classList.add('hidden'); hoPreviewedRoot = null; hoStatus.textContent = '' }
    hoCheck.onclick = async () => {
      hoCheck.disabled = true
      hoStatus.className = 'status-line pending'
      hoStatus.textContent = C.handoverChecking
      try {
        const r = await api('/api/migrate/custom/preview', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: hoPath.value }),
        })
        hoPreviewedRoot = r.root
        hoStatus.className = 'status-line'
        hoStatus.textContent = C.handoverPreviewLine(r.files.length, r.truncated, r.agentShaped)
        hoStart.classList.remove('hidden')
      } catch (err) {
        hoPreviewedRoot = null
        hoStart.classList.add('hidden')
        hoStatus.className = 'status-line failure'
        // api() surfaces the server's error string (reason codes are not
        // preserved) — the route's messages are already user-shaped.
        hoStatus.textContent = err.message
      } finally {
        hoCheck.disabled = false
      }
    }
    hoStart.onclick = async () => {
      if (!hoPreviewedRoot) return
      hoStart.disabled = true
      hoStatus.className = 'status-line pending'
      hoStatus.textContent = C.migrateStarting
      try {
        const r = await api('/api/migrate/custom/start', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ root: hoPreviewedRoot }),
        })
        hoStatus.className = 'status-line success'
        hoStatus.textContent = r.delivery === 'live' ? C.migrateStartedLive : C.migrateStartedQueued
      } catch (err) {
        hoStatus.className = 'status-line failure'
        hoStatus.textContent = GEN(err.message)
        hoStart.disabled = false
      }
    }

    // ── about / manual update check (2026-08-04, the owner "오토 업데이트
    // 버튼 어딨니?" -- the nav banner is silent when you're current, so
    // this is the always-present surface: version + Check now). ────────
    $('set-group-about').textContent = C.groupAbout || 'About'
    $('set-about-label').textContent = C.aboutLabel || 'App'
    const updStatus = $('set-update-status')
    const updOpen = $('set-update-open')
    api('/api/update/check').then((u) => {
      // cached read on load: paint version + state without spending a
      // GitHub call (the server serves its 6h cache here)
      $('set-about-version').textContent = C.aboutVersion(u.current || '?')
      if (u.ok && u.hasUpdate) {
        updStatus.textContent = C.updateAvailableLine(u.latest)
        updOpen.textContent = C.updateOpenButton
        updOpen.classList.remove('hidden')
        updOpen.onclick = () => window.open(u.url, '_blank', 'noopener')
      }
    }).catch(() => { $('set-about-version').textContent = C.aboutVersion('?') })
    $('set-update-check').textContent = C.updateCheckButton
    $('set-update-check').onclick = async () => {
      const btn = $('set-update-check')
      btn.disabled = true
      updStatus.className = 'status-line pending'
      updStatus.textContent = C.updateChecking
      try {
        const u = await api('/api/update/check?force=1')
        $('set-about-version').textContent = C.aboutVersion(u.current || '?')
        if (!u.ok) {
          updStatus.className = 'status-line failure'
          updStatus.textContent = C.updateCheckFailed(u.detail)
        } else if (u.hasUpdate) {
          updStatus.className = 'status-line'
          updStatus.textContent = C.updateAvailableLine(u.latest)
          updOpen.textContent = C.updateOpenButton
          updOpen.classList.remove('hidden')
          updOpen.onclick = () => window.open(u.url, '_blank', 'noopener')
        } else {
          updStatus.className = 'status-line success'
          updStatus.textContent = C.updateUpToDate
          updOpen.classList.add('hidden')
        }
      } catch (err) {
        updStatus.className = 'status-line failure'
        updStatus.textContent = GEN(err.message)
      } finally {
        btn.disabled = false
      }
    }

    // ── danger zone: clean uninstall (v0.0.35) ─────────────────────────
    // design-0023 P4: gated on the SERVER's inAppUninstall capability. The
    // card used to render unconditionally against a route that answered 501
    // on two platforms of three, so the button's only effect off macOS was an
    // error toast. There are three plans now, so the gate passes everywhere --
    // but it is a gate, so a platform that loses the capability loses the
    // button instead of keeping a broken one.
    const dangerCard = document.getElementById('set-danger')
    if (!window.can('inAppUninstall')) {
      if (dangerCard) dangerCard.classList.add('hidden')
      const dangerHeading = document.getElementById('set-group-danger')
      if (dangerHeading) dangerHeading.classList.add('hidden')
    }
    $('set-group-danger').textContent = C.groupDanger || 'Danger zone'
    $('set-danger-label').textContent = C.dangerLabel
    $('set-danger-note').textContent = C.dangerNote
    $('set-danger-delete').textContent = C.dangerButton
    $('set-danger-delete').onclick = async () => {
      let name = 'Scheherazade'
      try { name = (await api('/api/config')).DISPLAY_NAME || name } catch { /* generic name is fine */ }
      const ok = await window.confirmDialog(C.dangerConfirm(name), C.dangerConfirmButton, C.dangerCancel)
      if (!ok) return
      const btn = $('set-danger-delete')
      btn.disabled = true
      try {
        await api('/api/uninstall', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ confirm: 'DELETE' }),
        })
        // The server answers, then exits: this toast is the last thing the
        // window shows before the app closes itself.
        showToast(C.dangerDone)
      } catch (err) {
        btn.disabled = false
        showToast(GEN(err.message))
      }
    }
    $('set-rename-label').textContent = C.renameLabel
    $('set-rename-save').textContent = C.renameButton

    // ── profile picture (2026-09-28, the owner "프로필 사진") ──────────────
    // The preview is fed by nav.js's shared resolver (token-bearing fetch ->
    // blob object URL) because a bare <img src="/api/settings/avatar"> is a
    // 403: every /api GET sits behind the per-launch onboard token. The
    // resolver's memo is dropped on every (re)load so a picture replaced in
    // this session is the one on screen -- the route answers max-age=86400
    // and a replacement reuses the same URL.
    const previewEl = $('set-avatar-preview')
    const avatarStatus = $('set-avatar-status')
    const avatarFail = (msg) => {
      avatarStatus.classList.remove('hidden')
      avatarStatus.textContent = msg
    }
    const avatarClear = () => avatarStatus.classList.add('hidden')
    // A stale src (the file was removed, the blob URL went bad) falls back to
    // the shipped app icon rather than a broken-image icon. onerror is
    // cleared first so a fallback that ALSO fails cannot loop.
    const loadAvatarPreview = async () => {
      window.avatarUrlForget()
      previewEl.onerror = () => {
        previewEl.onerror = null
        previewEl.src = window.AVATAR_FALLBACK_URL || '/img/agent-avatar.png'
      }
      previewEl.src = await window.avatarUrl()
    }

    $('set-avatar-label').textContent = C.avatarLabel
    $('set-avatar-choose').textContent = C.avatarChoose
    $('set-avatar-remove').textContent = C.avatarRemove
    $('set-avatar-choose').onclick = () => $('set-avatar-input').click()
    $('set-avatar-input').onchange = async () => {
      const input = $('set-avatar-input')
      const file = input.files && input.files[0]
      // Clear the input FIRST: choosing the same file twice in a row fires no
      // change event while the old value is still in it, and "it worked the
      // first time and then stopped" is the bug that produces.
      input.value = ''
      if (!file) return
      // Size and type BEFORE reading, same ordering as chat.js's
      // uploadImageFile: the server re-checks both (it must -- the page is
      // not the authority), but an 8MB photo must not be read into memory and
      // posted just to be refused.
      if (file.size > 2_000_000) { avatarFail(C.avatarTooLarge); return }
      if (!/^image\/(png|jpe?g|webp)$/.test(file.type || '')) { avatarFail(C.avatarBadType); return }
      // The CHOICE happens before anything is uploaded: the crop step shows
      // the picked file and hands back a fresh 256x256 PNG of the square the
      // user framed. Cancel and Escape come back null with the stored picture
      // (and the old status line, cleared just above) untouched.
      avatarClear()
      const blob = await openAvatarCrop(file, () => avatarFail(C.avatarBadType))
      if (!blob) return
      // Read the CANVAS blob, not the picked file -- this is the whole point
      // of the step. The data URL is a means of transport only: only the part
      // after the comma is kept, the string itself is dropped here.
      let dataBase64 = ''
      try {
        dataBase64 = await new Promise((resolve, reject) => {
          const r = new FileReader()
          r.onload = () => resolve(String(r.result || '').split(',')[1] || '')
          r.onerror = () => reject(new Error('read failed'))
          r.readAsDataURL(blob)
        })
      } catch {
        avatarFail(C.avatarBadType)
        return
      }
      if (!dataBase64) { avatarFail(C.avatarBadType); return }
      try {
        // The stored file is always PNG out of the canvas, so the name the
        // picked file arrived with is not the name of what is being sent.
        await api('/api/settings/avatar', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: 'avatar.png', dataBase64 }),
        })
        avatarClear()
        showToast(C.avatarSaved)
        $('set-avatar-remove').disabled = false
        await loadAvatarPreview()
      } catch (err) {
        avatarFail(GEN(err.message))
      }
    }
    $('set-avatar-remove').onclick = async () => {
      try {
        await api('/api/settings/avatar', { method: 'DELETE' })
        avatarClear()
        showToast(C.avatarRemoved)
        $('set-avatar-remove').disabled = true
        await loadAvatarPreview()
      } catch (err) {
        avatarFail(GEN(err.message))
      }
    }

    $('set-autonomy-label').textContent = C.autonomyLabel
    $('set-autonomy-note').textContent = C.autonomyNote
    $('set-autonomy-enabled-label').textContent = C.autonomyEnableLabel
    $('set-autonomy-window-label').textContent = C.autonomyWindowLabel
    $('set-autonomy-window-note').textContent = C.autonomyWindowNote
    $('set-autonomy-cap-label').textContent = C.autonomyCapLabel
    $('set-autonomy-cap-note').textContent = C.autonomyCapNote
    $('set-autonomy-save').textContent = C.autonomySave
    $('set-autonomy-save').addEventListener('click', saveAutonomy)
    loadAutonomy().catch((err) => console.error(err))

    try {
      const cfg = await api('/api/config')
      $('set-rename-input').value = cfg.DISPLAY_NAME || ''
      // /api/config carries avatar {present, updatedAt} (routes/onboarding-
      // meta.cjs) so the control can render its CURRENT state without the
      // page probing for it. Remove is disabled while there is nothing to
      // remove -- and left ENABLED when that read failed, because a broken
      // read must not take away the only way back to the app icon.
      if (cfg.avatar) $('set-avatar-remove').disabled = cfg.avatar.present !== true
    } catch (err) {
      console.error(err)
    }
    loadAvatarPreview().catch((err) => console.error(err))

    $('set-rename-save').onclick = async () => {
      const name = $('set-rename-input').value.trim()
      const statusEl = $('set-rename-status')
      if (!name) return
      try {
        await api('/api/settings/rename', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ displayName: name }),
        })
        showToast(C.renameSaved)
        statusEl.classList.add('hidden')
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }

    // Engine cards (model/effort, custom proxy, topology) moved to the
    // Engine page (tab merge 2026-08-06) -- see connectors.js.
    // Hidden rather than rendered empty where there is nothing to check (the
    // owner, first win install 2026-08-03): every row used to be a TCC/macOS
    // wall whose buttons opened x-apple.systempreferences: URLs that do
    // nothing off macOS.
    // design-0023 P4: the SERVER's permissionsPanel capability, not the
    // page's own read of the platform id — and it is no longer a synonym for
    // "is this a Mac". It is derived from permission-probes.cjs's per-platform
    // probe list, so Linux (sudo + keyring) shows the panel and Windows (an
    // explicitly empty list) does not. Unknown capability = false.
    if (window.can('permissionsPanel')) {
      renderPermissions().catch((err) => console.error(err))
    } else {
      const el = document.getElementById('set-perms')
      if (el) el.classList.add('hidden')
    }
    // The sudo card was the one conditional surface with NO gate at all: on
    // Windows it collected an "admin password", stored it in DPAPI, and
    // nothing could ever consume it -- `sudo -A` and the askpass helper are
    // both POSIX. Storing a secret a platform cannot use is worse than not
    // offering the feature (read-C G7).
    if (window.can('sudo')) {
      renderSudo().catch((err) => console.error(err))
    } else {
      const el = document.getElementById('set-sudo')
      if (el) el.classList.add('hidden')
    }
  }

  // ── sudo askpass (0.1.0 prep, P4) ────────────────────────────────────────
  // Write-only password field: the page shows WHETHER a password exists,
  // never the value, and clears the input after a successful save so the
  // plaintext doesn't linger in the DOM.
  async function renderSudo() {
    $('set-sudo-label').textContent = C.sudoLabel
    $('set-sudo-note').textContent = C.sudoNote
    $('set-sudo-enabled-label').textContent = C.sudoEnableLabel
    $('set-sudo-password-label').textContent = C.sudoPasswordLabel
    $('set-sudo-save').textContent = C.sudoSave

    let state = { enabled: false, hasPassword: false }
    try {
      state = await api('/api/sudo/config')
    } catch (err) {
      console.error(err)
    }
    $('set-sudo-enabled').checked = state.enabled === true
    $('set-sudo-state').textContent = state.hasPassword ? C.sudoStateStored : C.sudoStateEmpty

    $('set-sudo-save').onclick = async () => {
      const statusEl = $('set-sudo-status')
      const enabled = $('set-sudo-enabled').checked
      const password = $('set-sudo-password').value
      if (enabled && !password && !state.hasPassword) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = C.sudoNeedPassword
        return
      }
      try {
        await api('/api/sudo/config', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(password ? { enabled, password } : { enabled }),
        })
        $('set-sudo-password').value = ''
        state = await api('/api/sudo/config')
        $('set-sudo-state').textContent = state.hasPassword ? C.sudoStateStored : C.sudoStateEmpty
        showToast(C.sudoSaved)
        statusEl.classList.add('hidden')
      } catch (err) {
        statusEl.classList.remove('hidden')
        statusEl.textContent = GEN(err.message)
      }
    }
  }


  // ── permission checklist (P0, 2026-07-15) ────────────────────────────────
  // docs/permission-visibility-design.md. Render rules mirror the autonomy
  // meter's honesty contract: 'indeterminate' is its own visible state
  // ("확인 불가"), never coerced into granted/denied; heuristic rows carry a
  // "추정" mark; rows with no Settings pane never grow an open-settings button.
  //
  // design-0023 P4: WHICH rows exist is now entirely the server's answer.
  // This renderer used to synthesize an automation row client-side on every
  // host and decide the [확인] buttons from a hardcoded class list -- both of
  // which assumed macOS, on a page that also renders on Linux now. The server
  // sends its platform's rows and each row names its own explicit-probe lane.
  const PERMS_POLL_MS = 3000
  const PERMS_POLL_MAX = 20
  let permsPollTimer = null

  // The explicit-trigger lanes, keyed by the token a row carries in
  // `explicit`. A registry rather than a URL off the wire: the row decides
  // WHETHER a check is offered, this table decides WHERE it posts, so a row
  // can never aim the page at an arbitrary endpoint. Both lanes are
  // user-click-only by server contract -- automation SENDS an Apple event
  // (may pop the consent dialog), sudo RUNS `sudo -k -A true` with the
  // stored password (a wrong one writes a PAM failure to the system log).
  const EXPLICIT_PROBE_ROUTES = {
    automation: '/api/permissions/probe-automation',
    sudo: '/api/permissions/probe-sudo',
  }

  // No emoji (product register, copy.js header) -- state is words + the
  // existing status-line success/failure colors; indeterminate stays the
  // default muted color, visually its own third thing.
  function applyPermBadge(el, row) {
    el.className = 'status-line'
    let text
    if (row.granted === true) { el.classList.add('success'); text = C.permsGranted }
    else if (row.granted === false) { el.classList.add('failure'); text = C.permsDenied }
    else { text = C.permsIndeterminate }
    if (row.kind === 'heuristic' && row.granted !== 'indeterminate') text += ` (${C.permsHeuristicMark})`
    else if (row.kind === 'stored') text += ` (${C.permsStoredMark})`
    else if (row.kind === 'verified') text += ` (${C.permsVerifiedMark})`
    // Dot-only (the owner 08-20 22:00 "여기도 글 말고 초록불/빨간불로") — same
    // bean grammar as the nav status. The full sentence (incl. the
    // heuristic/stored/verified honesty marks) rides the hover title; the
    // colored dot renders via #set-perms-rows .status-line::before.
    // Indeterminate = the grey rest-state dot, its own visible third thing.
    el.textContent = ''
    el.title = text
  }

  function renderPermRows(rows, deepLinks) {
    const box = $('set-perms-rows')
    box.innerHTML = ''
    const all = Array.isArray(rows) ? rows : []
    let shown = 0
    for (const r of all) {
      if (!C.permsClassNames[r.class]) continue // unknown probe row: nothing honest to label it with
      shown += 1
      const rowEl = document.createElement('div')
      rowEl.className = 'agent-control-row'
      const label = document.createElement('label')
      label.textContent = C.permsClassNames[r.class]
      rowEl.appendChild(label)

      const right = document.createElement('span')
      const badge = document.createElement('span')
      applyPermBadge(badge, r)
      right.appendChild(badge)

      if (deepLinks && deepLinks[r.class]) {
        const btn = document.createElement('button')
        btn.textContent = C.permsOpenButton
        // spacing now owned by the row grid (app.css #set-perms-rows) --
        // the old inline margin would double up with the grid gap
        btn.onclick = async () => {
          btn.disabled = true
          try {
            await api('/api/permissions/open', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ cls: r.class }),
            })
            showRelaunchBanner()
            startPermsPoll()
          } catch (err) {
            showToast(GEN(err.message))
          } finally {
            btn.disabled = false
          }
        }
        right.appendChild(btn)
      }

      // Explicit-trigger probes. The row carries WHICH lane can deepen it
      // (`explicit`), decided server-side against the platform's probe table
      // and against the row itself — sudo's Check appears only when there is
      // a stored key to verify, because offering a Check that can only fail
      // is the misroute rule again. The page no longer knows any of that; it
      // looks the token up in the route registry and renders a button or not.
      const explicitProbe = r.explicit ? EXPLICIT_PROBE_ROUTES[r.explicit] : null
      if (explicitProbe) {
        const btn = document.createElement('button')
        btn.textContent = C.permsProbeButton
        // spacing owned by the row grid (app.css #set-perms-rows) — an
        // inline margin here doubles up with the grid gap
        btn.onclick = async () => {
          btn.disabled = true
          badge.className = 'status-line'
          // dot grammar: words ride the hover title, never the 16px dot
          // column (text there overflows the grid slot)
          badge.textContent = ''
          badge.title = C.permsLoading
          try {
            const { row: probed } = await api(explicitProbe, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({}),
            })
            applyPermBadge(badge, probed)
          } catch (err) {
            badge.textContent = ''
            badge.title = C.permsIndeterminate
            showToast(GEN(err.message))
          } finally {
            btn.disabled = false
          }
        }
        right.appendChild(btn)
      }

      rowEl.appendChild(right)
      box.appendChild(rowEl)

      if (C.permsClassNotes[r.class]) {
        const note = document.createElement('div')
        note.className = 'field-hint'
        note.textContent = C.permsClassNotes[r.class]
        box.appendChild(note)
      }
    }
    // Nothing rendered is a legitimate answer for a platform (Windows probes
    // nothing on purpose) and it must SAY so — including when rows arrived
    // but every one of them was skipped for want of a label. A silently blank
    // panel is indistinguishable from "everything is granted", which is the
    // one reading this feature exists to prevent.
    if (shown === 0) box.textContent = C.permsNone
  }

  function showRelaunchBanner() {
    const el = $('set-perms-relaunch')
    if (!el.classList.contains('hidden')) return
    el.classList.remove('hidden')
    el.textContent = `${C.permsRelaunchNote} `
    const btn = document.createElement('button')
    btn.textContent = C.permsRelaunchButton
    btn.style.marginLeft = '0.5rem'
    // Reuses the FDA relaunch route -- same app, same TCC cache, one path.
    btn.onclick = () => api('/api/onboarding/fda/relaunch', { method: 'POST' }).catch((err) => showToast(GEN(err.message)))
    el.appendChild(btn)
  }

  // Bounded refresh after the user opens a Settings pane: live-state probes
  // (screen/accessibility) reflect a toggle without relaunch, so polling
  // here lets the badge flip in front of the user. FDA stays stale until
  // relaunch -- the banner above owns that truth.
  function startPermsPoll() {
    if (permsPollTimer) return
    let n = 0
    permsPollTimer = setInterval(async () => {
      n += 1
      if (n > PERMS_POLL_MAX) {
        clearInterval(permsPollTimer)
        permsPollTimer = null
        return
      }
      try {
        const data = await api('/api/permissions/status')
        renderPermRows(data.rows, data.deepLinks)
      } catch {
        clearInterval(permsPollTimer)
        permsPollTimer = null
      }
    }, PERMS_POLL_MS)
  }

  async function renderPermissions() {
    $('set-perms-label').textContent = C.permsLabel
    $('set-perms-note').textContent = C.permsNote
    const box = $('set-perms-rows')
    box.textContent = C.permsLoading
    try {
      const data = await api('/api/permissions/status')
      renderPermRows(data.rows, data.deepLinks)
    } catch (err) {
      console.error('permissions status failed:', err)
      box.textContent = C.permsLoadFailed
    }
  }



  init()
})()
