;(async () => {
  const root = document.getElementById('seed-settings')
  async function load() {
    const cfg = await (await fetch('/api/config')).json()
    root.replaceChildren()
    const title = document.createElement('h2'); title.textContent = cfg.SEED ? '씨앗 · 서약' : '씨앗 고르기'; root.append(title)
    async function save(body) {
      const res = await fetch('/api/seed', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      if (!res.ok) { alert((await res.json()).error); return }
      await load()
    }
    function button(text, action, disabled = false) {
      const b = document.createElement('button'); b.textContent = text; b.disabled = disabled; b.onclick = action; root.append(b)
    }
    if (!cfg.SEED && cfg.SEED_DISMISSED === 'yes') { root.hidden = true; return }
    root.hidden = false
    if (!cfg.SEED || !cfg.SEED_OATH) {
      const select = document.createElement('select')
      for (const [id, text] of [['curiosity', '호기심'], ['care', '돌봄'], ['mischief', '장난기'], ['custom', '직접 쓰기']]) {
        const o = document.createElement('option'); o.value = id; o.textContent = text; select.append(o)
      }
      const input = document.createElement('input'); input.maxLength = 120; input.placeholder = '짧은 한 줄'; root.append(select, input)
      button('씨앗 선택', () => save({ seed: select.value === 'custom' ? input.value : select.value }))
      if (!cfg.SEED) button('닫기', () => save({ action: 'dismiss' }))
    }
    if (cfg.SEED) { const p = document.createElement('p'); p.textContent = cfg.SEED; root.append(p) }
    button(cfg.SEED_OATH ? '서약 해제' : '서약', () => {
      const dialog = document.createElement('dialog')
      const p = document.createElement('p')
      p.textContent = `${cfg.USER_NAME || cfg.USER_DISPLAY_NAME || '사용자'} · ${cfg.DISPLAY_NAME || cfg.AGENT_NAME}: ${cfg.SEED_OATH ? '서약을 해제할까?' : '이제 고정할까? 씨앗은 해제하기 전까지 바뀌지 않아.'}`
      const yes = document.createElement('button'); yes.textContent = '확인'
      const no = document.createElement('button'); no.textContent = '취소'
      no.onclick = () => { dialog.close(); dialog.remove() }
      yes.onclick = async () => { dialog.close(); dialog.remove(); await save({ action: cfg.SEED_OATH ? 'revoke' : 'oath', confirm: true }) }
      dialog.append(p, yes, no); document.body.append(dialog); dialog.showModal()
    }, !cfg.SEED)
  }
  await load()
})().catch(console.error)
