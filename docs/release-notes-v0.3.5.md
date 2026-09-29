# v0.3.5

This release makes the "!" mark honest, lets you put your own face in the
chat, brings your notes over from the tools you already use, fixes Stop on
Windows, and checks its own installer before it ships. The Claude picker now
offers Sonnet 5.5 in place of Sonnet 5.

## The "!" now has something to say

In 0.3.4 the mark above the composer could only light from the corrections
list: the reflux pass that turns your corrections into proposals had no
schedule, and dream consolidation only ran when autonomy mode was on. Both
now run once a day on the app's own clock, on every platform, with no
launchd or Task Scheduler entry. Reflux runs inside the app with no model
call and writes nothing when nothing changed, so a fresh install never gets
an empty proposals file. The dream pass runs in the same afternoon window as
the existing schedule, waits while you are chatting, skips days with no new
journal, and stands down when autonomy already has it covered, so she never
dreams twice in a day. The last run of each job is written under the data
home, so relaunching the app does not repeat a job that already ran today.
`SCHEDULES=off` turns the clock off.

## Your picture

Settings has a second picture row, "Your picture", with the same square crop
step as hers. When you upload one, it appears at 32px on the right above the
first bubble of each run of your messages. No text label is added to your
rows, and with no picture uploaded the chat looks exactly as before. Rename
keeps both pictures.

## Bring your notes with you

When onboarding finds data from Claude Code, Codex, Hermes, OpenCode or
OpenClaw on this machine, a new step between provider connect and naming
shows one card per tool with a checkbox per file and its size, and a line
listing what is left in place. Nothing is copied until you click Copy, and
Skip is always there. Copies go to `imported/<tool>/` in the data home,
byte for byte, owner-only, with a receipt. Tool settings files and credential
stores are never read, symlinks are never followed, and any selected file
that contains key-shaped text is held back with the reason shown. Instruction
files are saved as `imported-CLAUDE.md` / `imported-AGENTS.md` so the CLI
does not load them as her own instructions. Chat history is off by default.
After the copy she is told to fold what came over into her memory on her next
start.

## Stop on Windows

Stop used to terminate `claude.exe` outright and leave its MCP servers
running. It now sends the interrupt the CLI understands and waits up to 8
seconds (`SCHEHERAZADE_SOFT_STOP_SECONDS`); if the turn closes, the session
and its servers stay up and the next message is answered without a restart.
If the interrupt is refused or times out, the whole process tree is killed
(`taskkill /T /F`), children included. The stopped turn no longer counts as
an error, shows no banner, and does not trigger the reply nudge. mac and
Linux behave as before.

## The installer checks itself

Every leg now writes a build stamp (tag, git HEAD, a per-run id) into the
build tree before packaging, then opens the packaged `app.asar` and confirms
the packaged version equals the tag, the stamp's HEAD equals the one preflight
printed, and the run id is this run's. A mismatch fails the leg and blocks
`--publish`. On mac the dmg itself is opened; on Windows the unpacked folder
the installer was packed from is read before cleanup; on Linux the asar is
pulled out of the AppImage. The Windows e2e install task now resolves the
current release from the feed instead of a hard-coded 0.3.0 installer.

## Models

The Claude picker offers Sonnet 5.5 (`claude-sonnet-5-5`) instead of Sonnet
5, and it is the default for subagents on the Anthropic route. A saved
config that still names `claude-sonnet-5` keeps its 1M context cap.
