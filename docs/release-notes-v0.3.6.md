# v0.3.6

A follow-up to 0.3.5 that finishes the loose ends it left: every way the
agent can be stopped on Windows now cleans up after itself, Settings > Import
copies your files instead of reading them where they sit, "Hand it over" keeps
its promise, the daily clock runs on Slack and Telegram too, and your own
messages show their time.

## Stop cleans up everywhere on Windows

0.3.5 fixed the Stop button so it no longer left MCP server processes behind
on Windows. The other ways the agent gets restarted still did: the stall
watchdog, the reset after three error turns, session rotation, and the
`.stop_requested` file. All of them now go through the same tree kill, so no
stray processes remain whichever path ended the session. The Stop message no
longer promises a restart that, on Windows, does not happen.

## Settings > Import copies your files

The onboarding import already copied the files you picked into the app's own
store. The Import card in Settings now does the same thing, with the same
picker and the same allowlist, so editing or deleting the originals later no
longer changes what the agent knows. Anything already imported is kept.

## "Hand it over" delivers

Clicking "Hand it over" while the agent was down said "Queued", but the
queued item was dropped when the agent came back. It is now delivered on the
next start, and the page changes from Queued to Delivered when that happens.

## The daily clock on every channel

The reflux and dream jobs from 0.3.5 only ticked on Discord and the local
channel. Slack and Telegram now run the same clock, and when more than one
channel is up only one of them ticks, so nothing runs twice in a day.

## Your messages show their time

The user's own rows in the chat now carry the same HH:MM stamp as the agent's.
