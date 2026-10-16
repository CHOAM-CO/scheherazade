// Import-only startup reproduction: no plugin activation, channels or requests.
// Run with --cpu-prof; compare cache disabled, empty cache and warm cache.
import { performance } from 'node:perf_hooks'
const root = new URL('../', import.meta.url)
for (const target of [
  'node_modules/@deepseek-ai/dsh/lib/profile-boot-BnJoK_kl.js',
  'node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js',
  'node_modules/@deepseek-ai/dsh-mcp-client/lib/index.js',
  'memory/service.mjs',
  'memory/server.mjs',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js',
  'node_modules/@modelcontextprotocol/sdk/dist/esm/server/stdio.js'
]) {
  const start = performance.now()
  await import(new URL(target, root))
  console.log(JSON.stringify({ target, ms: +(performance.now() - start).toFixed(2), sinceStart: +performance.now().toFixed(2) }))
}
