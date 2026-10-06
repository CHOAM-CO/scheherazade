'use strict'
const fs = require('node:fs')
const path = require('node:path')
const DRIVES = { curiosity: '호기심 — 궁금한 것을 함께 탐색하기', care: '돌봄 — 서로의 일상을 살피기', mischief: '장난기 — 일상에서 재미를 발견하기' }
const BLOCK = /<!-- seed:locked=(?:true|false) -->\r?\n\*\*씨앗\*\*: [^\r\n]*(?:\r?\n)?/
function seedText(value) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 120 || /[\r\n<>]/.test(value)) throw new Error('씨앗은 120자 이내 한 줄로 골라 주세요')
  return DRIVES[value.trim()] || value.trim()
}
function preserveSeedBlock(oldText, newText) {
  const old = oldText.match(BLOCK)
  if (!old) return newText
  return old[0] + newText.replace(BLOCK, '').replace(/^\s+/, '')
}
function writePersona(mem, newText, log = console.error) {
  const file = path.join(mem, 'self_persona.md')
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const block = old.match(BLOCK)?.[0]
  if (block?.includes('locked=true') && newText.match(BLOCK)?.[0] !== block) log('[seed] locked seed change refused')
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, preserveSeedBlock(old, newText)); fs.renameSync(tmp, file)
}
function setSeedBlock(mem, seed, locked) {
  const file = path.join(mem, 'self_persona.md')
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : ''
  const tmp = file + '.tmp'
  fs.writeFileSync(tmp, `<!-- seed:locked=${locked} -->\n**씨앗**: ${seedText(seed)}\n` + old.replace(BLOCK, '').replace(/^\s+/, ''))
  fs.renameSync(tmp, file)
}
function showSeedStep(config) { return !config.SEED && !config.ONBOARDING_COMPLETE && !config.DISPLAY_NAME }
module.exports = { DRIVES, seedText, preserveSeedBlock, writePersona, setSeedBlock, showSeedStep }
