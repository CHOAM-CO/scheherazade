// One conservative image policy for the chip and server attachment gate.
;(function (root) {
  const yes = new Set(['kimi-k2.7-code', 'kimi-k3', 'kimi-k2.6', 'gemma4', 'qwen3.5', 'minimax-m3', 'mistral-large-3', 'deepseek-v4.1-flash', 'glm-5.3-flash', 'muse-spark-open'])
  function laneVision(spawn) {
    const provider = String(spawn?.provider || '')
    const model = String(spawn?.live?.model || spawn?.model || '').toLowerCase()
    const base = model.replace(/^[^/]+\//, '').replace(/:.*$/, '')
    return /^claude/.test(provider) || /^claude/.test(model) || ['chatgpt', 'dsh'].includes(provider) || yes.has(base) ? 'yes' : 'no'
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { laneVision }
  else root.SeraModelVision = { laneVision }
})(typeof window !== 'undefined' ? window : globalThis)
