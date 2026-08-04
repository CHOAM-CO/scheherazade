// calendar/server.mjs -- the agent's window into the owner's schedule.
//
// One tool, and it is allowed to say only two things:
//   "here is what is on your calendar"   (it looked, and this is what it saw)
//   "I could not read your calendar"     (it could not look, and it says why)
//
// It is never allowed to say the third thing -- "you have nothing scheduled" --
// unless that is true. calendar/read.cjs enforces that (it refuses to report
// events without full read access, because EventKit hands you an empty list
// when it has write-only permission and no error to go with it). This file's
// only job is to make sure that refusal reaches the AGENT as a refusal, and not
// as an empty list it will cheerfully summarize as "your day is clear".
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const { readEvents } = require('./read.cjs')

const AGENT_NAME = process.env.AGENT_NAME || 'scheherazade'
const log = (...a) => console.error(`[${AGENT_NAME}-calendar]`, ...a)

const MAX_DAYS = 90

const TOOLS = [
  {
    name: 'calendar_read',
    description:
      "Read the user's macOS calendar for a window of days starting today. " +
      'Returns the events it found, or an explicit failure if it could not read the calendar. ' +
      'IMPORTANT: an empty `events` list means the user genuinely has nothing scheduled. ' +
      'A failure means you DO NOT KNOW what is on their calendar -- in that case say so, ' +
      'and never tell the user their schedule is clear.',
    inputSchema: {
      type: 'object',
      properties: {
        days: {
          type: 'number',
          description: `How many days from today to read (1 = today only). Default 1, max ${MAX_DAYS}.`,
        },
      },
    },
  },
]

function localDayStart(now, offsetDays = 0) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  d.setDate(d.getDate() + offsetDays)
  return d
}

async function handleCalendarRead(args) {
  const raw = Number(args && args.days)
  const days = Number.isFinite(raw) && raw >= 1 ? Math.min(Math.floor(raw), MAX_DAYS) : 1

  const now = new Date()
  const result = await readEvents({ from: localDayStart(now), to: localDayStart(now, days) })

  if (!result.ok) {
    // isError: true. The agent must not be able to mistake this for a quiet day.
    return {
      content: [{
        type: 'text',
        text:
          `캘린더를 읽지 못했습니다 (${result.code}).\n${result.reason}\n\n` +
          '이건 "일정이 없다"가 아니라 "일정을 볼 수 없다"입니다. ' +
          '사용자에게 일정이 비어 있다고 말하지 마세요.',
      }],
      isError: true,
    }
  }

  if (result.events.length === 0) {
    return {
      content: [{
        type: 'text',
        text: `읽었습니다. 앞으로 ${days}일 동안 등록된 일정이 없습니다. (읽기 권한 확인됨)`,
      }],
    }
  }

  const lines = result.events.map((e) => {
    const when = e.allDay ? `${e.start.slice(0, 10)} (종일)` : `${e.start} ~ ${e.end}`
    const where = e.location ? ` @ ${e.location}` : ''
    return `- ${when} | ${e.title}${where} [${e.calendar}]`
  })
  return {
    content: [{
      type: 'text',
      text: `앞으로 ${days}일 일정 ${result.events.length}건:\n${lines.join('\n')}`,
    }],
  }
}

async function main() {
  const server = new Server(
    { name: `${AGENT_NAME}-calendar`, version: '0.0.4' },
    { capabilities: { tools: {} } },
  )
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      if (request.params.name === 'calendar_read') return await handleCalendarRead(request.params.arguments || {})
      return { content: [{ type: 'text', text: `Unknown tool: ${request.params.name}` }], isError: true }
    } catch (err) {
      return { content: [{ type: 'text', text: `Error: ${err.message}` }], isError: true }
    }
  })

  await server.connect(new StdioServerTransport())
  log('MCP server up')
}

// fileURLToPath, NOT new URL().pathname — win32 pathname is '/C:/...' and the
// guard never matches (headless-lane had the same bug; 0.57 win probe).
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
if (isMain) {
  main().catch((err) => {
    log(`Fatal: ${err.message}`)
    process.exit(1)
  })
}

export { TOOLS, handleCalendarRead, MAX_DAYS }
