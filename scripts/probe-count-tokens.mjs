// One-shot empirical probe: does codex-as-api's /v1/messages/count_tokens
// return an inflated token estimate (bytes-as-tokens + rawPayload double-count)?
// count_tokens is pure local estimation (no Codex/OAuth call), so this runs
// without ~/.codex/auth.json. Also doubles as a createApp() boot smoke test.
import { createApp } from 'codex-as-api'

const app = createApp()
const srv = app.listen(0, '127.0.0.1', async () => {
  const port = srv.address().port
  // ~4KB system string. Real token count is ~byteLength/4 (English) so ~1000.
  const systemText = 'You are a helpful assistant. '.repeat(140) // ~3920 bytes
  const body = {
    model: 'gpt-5.6',
    max_tokens: 100,
    system: systemText,
    messages: [{ role: 'user', content: 'hello there' }],
  }
  const sysBytes = Buffer.byteLength(systemText, 'utf8')
  const payloadBytes = Buffer.byteLength(JSON.stringify(body), 'utf8')
  const realTokensApprox = Math.round(sysBytes / 4) // rough English estimate
  try {
    const r = await fetch(`http://127.0.0.1:${port}/v1/messages/count_tokens`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    const j = await r.json()
    console.log('system bytes        :', sysBytes)
    console.log('full payload bytes  :', payloadBytes)
    console.log('real tokens (~bytes/4):', realTokensApprox)
    console.log('count_tokens reply  :', JSON.stringify(j))
    if (typeof j.input_tokens === 'number') {
      console.log('inflation vs real   :', (j.input_tokens / realTokensApprox).toFixed(1) + 'x')
      console.log('input_tokens ~= 2x payload bytes?', Math.abs(j.input_tokens - 2 * payloadBytes) < payloadBytes * 0.3)
    }
  } catch (e) {
    console.log('PROBE ERROR:', e.message)
  } finally {
    srv.close()
  }
})
