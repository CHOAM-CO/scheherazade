// channel.mjs cannot be imported in a test (it boots a live Discord client), so
// this is a static check: every local-date helper the file CALLS must be IMPORTED.
// Regression for 0.3.13: localDate() was called by the note-cadence watcher
// without an import; the watcher threw "localDate is not defined" every hour
// and the daily-note reminder never fired.
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
for (const file of ['channel.mjs', 'channel-runtime.mjs', 'supervisor.mjs']) {
  const src = fs.readFileSync(path.join(ROOT, file), 'utf8')
  for (const fn of ['localDate', 'localStamp', 'localTime']) {
    const called = new RegExp(`(^|[^.\\w])${fn}\\(`, 'm').test(src)
    if (!called) continue
    const imported = new RegExp(`import\\s*\\{[^}]*\\b${fn}\\b[^}]*\\}\\s*from\\s*['"]\\./local-date\\.cjs['"]`).test(src)
      || new RegExp(`\\b${fn}\\b[^\\n]*=\\s*require\\(['"]\\./local-date\\.cjs['"]\\)`).test(src)
      || new RegExp(`function ${fn}\\(`).test(src)
    assert.ok(imported, `${file} calls ${fn}() but does not import it from ./local-date.cjs`)
  }
}
console.log('ok channel imports: local-date helpers imported where called')
