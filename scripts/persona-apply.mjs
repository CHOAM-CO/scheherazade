#!/usr/bin/env node
// Reflux applies approved full-text proposals through this guarded writer.
import fs from 'node:fs'
import { createRequire } from 'node:module'
import { resolveDataHome } from '../data-home.cjs'
const { writePersona } = createRequire(import.meta.url)('../cadence/seed.cjs')
if (!process.argv[2]) throw new Error('Usage: persona-apply.mjs <approved-proposal-file>')
writePersona(resolveDataHome(), fs.readFileSync(process.argv[2], 'utf8'))
