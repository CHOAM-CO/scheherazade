;(async function () {
  const root = document.getElementById('sibling-memory')
  if (!root) return
  const toggle = document.getElementById('sibling-memory-toggle')
  const blocks = document.getElementById('sibling-memory-blocks')
  async function load() {
    blocks.replaceChildren()
    if (!toggle.checked) return
    const result = await window.api('/api/memory/siblings')
    for (const sibling of result.siblings || []) {
      const details = document.createElement('details')
      const summary = document.createElement('summary')
      summary.textContent = `${sibling.name} (${sibling.profile}) · ${sibling.material.count}개 · 마지막 기록 ${sibling.material.lastWritten || '없음'}`
      const form = document.createElement('form')
      const input = document.createElement('input')
      input.type = 'search'; input.placeholder = '기억 검색'; input.setAttribute('aria-label', `${sibling.name} 기억 검색`)
      const button = document.createElement('button'); button.textContent = '검색'
      const output = document.createElement('div'); output.setAttribute('role', 'status')
      form.append(input, button)
      form.onsubmit = async event => {
        event.preventDefault()
        if (!input.value.trim()) { output.textContent = ''; return }
        const result = await window.api(`/api/memory/siblings?search=${encodeURIComponent(input.value)}`)
        const match = (result.siblings || []).find(row => row.profile === sibling.profile)
        output.replaceChildren()
        for (const row of match?.material.rows || []) {
          const item = document.createElement('p')
          item.textContent = row.value || row.summary || row.correct_behavior || row.body || ''
          output.append(item)
        }
        if (!output.childNodes.length) output.textContent = '검색 결과 없음'
      }
      details.append(summary, form, output); blocks.append(details)
    }
  }
  try {
    const settings = await window.api('/api/profiles/settings')
    toggle.checked = settings.sharedMemoryRead !== false
    toggle.onchange = async () => {
      toggle.disabled = true
      try {
        const result = await window.api('/api/profiles/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sharedMemoryRead: toggle.checked }) })
        if (!result.ok) throw Error(result.error)
        await load()
      } catch (error) { toggle.checked = !toggle.checked; window.showToast(error.message) }
      finally { toggle.disabled = false }
    }
    await load()
  } catch (error) { blocks.textContent = '다른 세라 기억을 불러오지 못했어' }
})()
