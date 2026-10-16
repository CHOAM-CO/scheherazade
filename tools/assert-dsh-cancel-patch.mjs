// Fail closed before packaging: npmRebuild:false ships installed dependencies.
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

export function hasForcedCancelPatch (source) {
  const start = source.indexOf('async cancel(request) {')
  if (start < 0) return false
  const end = source.indexOf('\n\t\t},\n\t\tsubagents:', start)
  const cancel = source.slice(start, end < 0 ? undefined : end)
  return cancel.includes('keepInbox: false') && cancel.includes('target.whenIdle()') &&
    cancel.includes('ctx.agents.isOwnedBy') && !cancel.includes('keepInbox: true')
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const file = new URL('../node_modules/@deepseek-ai/dsh-host-apiproxy/lib/index.js', import.meta.url)
  if (!hasForcedCancelPatch(fs.readFileSync(file, 'utf8'))) {
    console.error('Packaging refused: dsh gateway forced-cancel patch is missing. Run npm install to apply dependency patches.')
    process.exitCode = 1
  } else console.log('PASS: installed dsh gateway includes forced cancellation and owned-subagent drain')
}
