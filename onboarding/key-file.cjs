'use strict'
const fs = require('node:fs')
const path = require('node:path')
const YAML = require('yaml')
const LIMIT = 64 * 1024

// Never include file contents, parser diagnostics, or native errors in errors.
function readKeyFile(file, keyName) {
  if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error('keyFile must be an absolute path')
  let fd
  let text
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK)
    const stat = fs.fstatSync(fd)
    if (!stat.isFile()) throw new Error('not a file')
    if (stat.size > LIMIT) throw new Error('too large')
    const buffer = Buffer.alloc(LIMIT + 1)
    let size = 0
    while (size < buffer.length) {
      const n = fs.readSync(fd, buffer, size, buffer.length - size, null)
      if (!n) break
      size += n
    }
    if (size > LIMIT) throw new Error('too large')
    text = buffer.subarray(0, size).toString('utf8')
  } catch (err) {
    throw new Error(err.message === 'too large' ? 'keyFile exceeds 64 KiB' : 'keyFile must be a readable regular file')
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
  }
  let key
  if (keyName !== undefined || /\.ya?ml$/i.test(file)) {
    if (typeof keyName !== 'string' || !keyName.trim()) throw new Error('keyName is required for a YAML keyFile')
    let data
    try { data = YAML.parse(text, { maxAliasCount: 0, logLevel: 'silent' }) } catch { throw new Error('keyFile contains invalid YAML') }
    if (!data || typeof data !== 'object' || Array.isArray(data) || !Object.hasOwn(data, keyName) || typeof data[keyName] !== 'string') {
      throw new Error('keyName must select a string entry in keyFile')
    }
    key = data[keyName].trim()
  } else key = text.split(/\r?\n/, 1)[0].trim()
  if (!key) throw new Error('keyFile contains an empty key')
  return key
}
function resolveRequestKey(body) {
  const supplied = ['key', 'apiKey'].filter((name) => body[name] !== undefined && body[name] !== '')
  if (supplied.some((name) => typeof body[name] !== 'string')) throw new Error('key must be a string')
  if (supplied.length > 1 || (body.keyFile !== undefined && supplied.length)) throw new Error('provide either key or keyFile, not both')
  if (body.keyFile !== undefined) return readKeyFile(body.keyFile, body.keyName)
  if (body.keyName !== undefined) throw new Error('keyName requires keyFile')
  return supplied.length ? body[supplied[0]].trim() : ''
}
module.exports = { readKeyFile, resolveRequestKey }
