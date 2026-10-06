import assert from 'node:assert/strict'
import { prependMemoryContext } from '../memory/turn-context.mjs'
const material = { open_threads: [{summary:'open'}], user_facts: [{id:1,subject:'user',predicate:'job',value:'x'.repeat(3000)}], corrections:[{what_was_wrong:'wrong',correct_behavior:'right'}],preferences:[{key:'tone',value:'casual'}] }
const opts = { recall: () => material, essentials: () => [] }
const result = prependMemoryContext('hello', {}, opts)
assert(result.endsWith('[/remembered-context]\nhello'))
assert(result.length <= 2505)
assert(result.includes('right') && result.includes('casual') && result.includes('open'))
assert.equal(prependMemoryContext(result, {}, opts), result)
assert.equal(prependMemoryContext('system', {sender:'SYSTEM'}, opts), 'system')
let logs = 0
const broken = {recall: () => {throw Error('offline')}, log: () => logs++}
assert.equal(prependMemoryContext('hello', {}, broken), 'hello')
assert.equal(prependMemoryContext('again', {}, broken), 'again')
assert.equal(logs, 1)
console.log('memory turn bundle assertions passed')
