// Latest selection wins, including switches made while the engine is starting.
function createLaneModelRetry(notify, { wait = ms => new Promise(resolve => setTimeout(resolve, ms)), attempts = 100 } = {}) {
  let generation = 0
  return async (model, effort) => {
    const mine = ++generation
    for (let i = 0; i < attempts; i++) {
      if (mine !== generation) return { ok: false, reason: 'superseded' }
      const result = await notify(model, effort)
      if (result.ok || /^HTTP (?!401)/.test(result.reason || '')) return result
      if (i + 1 < attempts) await wait(1000)
    }
    return { ok: false, reason: 'endpoint readiness timeout' }
  }
}
module.exports = { createLaneModelRetry }
