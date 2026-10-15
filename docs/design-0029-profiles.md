# design-0029 — Profiles: several Seras on one computer (0.5.0)

Status: SPEC, 2026-10-15. Owner: Idea (spec + review). Builder: one worker, Mino picks the lane.
Asked by Mino 2026-10-15 13:26–13:29 (idea home), relaying 황병권 (Danstruct internal
user): "세라 클론이나 두개 이상 쓰고싶다". Mino: "스펙부터 써줘", "묶어서 0.5.0으로 나가도
좋겠다", "마기도 그렇고 cc/codex/agy도 다중세션 돌릴 수 있으니까".
Fact base: a repo survey of every per-machine singleton (HEAD da80bcf), kept at
`docs/reports/profiles-singletons-20261015.md`.

## What it is

A *profile* is one complete Sera: her own data home (memory.db, journals, config,
credentials, schedules, lane home, managed install), her own Electron userData, her own
agent supervisor, and her own window. Two profiles are two Seras running at the same
time on one OS account, like two MAGI agents on one Mac: separate homes, separate
processes, ports picked at runtime, nothing shared except the installed app and the
machine-wide logins.

Today the app assumes exactly one of her per OS account, in two places that reinforce
each other: the data home is the fixed `~/Documents/Scheherazade` (data-home.cjs:15-19,
locked: a rename must never move the database), and `main.cjs:166` takes Electron's
single-instance lock, which is keyed on the userData path that `main.cjs:48` hardcodes.
A second launch therefore only focuses the first window. The 0.2 test track ran a second
copy out of `Scheherazade02` and collided on `.agent-config`, memory.db and the channel
token, which is why that home was folded back (main.cjs:66-110). Profiles make that split
deliberate instead of accidental.

## The rule

One profile = one name, chosen once, never renamed. The name selects BOTH the data home
and the userData, in lockstep:

| | default profile (no name) | named profile `<name>` |
|---|---|---|
| data home | `~/Documents/Scheherazade` | `~/Documents/Scheherazade-<name>` |
| userData | `<appData>/scheherazade` | `<appData>/scheherazade-<name>` |
| `AGENT_NAME` | `scheherazade` | `scheherazade-<name>` |
| single-instance lock | keyed on its userData (unchanged Electron behaviour) | same, so profiles never block each other |

The default profile is byte-for-byte what every user has today. Nothing moves, nothing is
migrated, the legacy `Scheherazade02` fold-in keeps running for the default only.
`DISPLAY_NAME` stays free to edit; the profile name is a path, not a persona.

The pair above MUST be set before anything else in `main.cjs`: before the `setPath` at
:48, before the fold-in, before `http-server.cjs` is required (data-home.cjs resolves from
`process.env` at require time). The whole feature is one env variable
(`AGENT_DATA_HOME`) plus one `setPath`, placed early; every module below already keys on
the data home.

`<name>`: 1–24 chars, `[a-z0-9-]`, not `default`. Validate at creation and at launch; an
unknown name at launch offers to create it.

## How a user gets a second Sera

1. Settings > 프로필 (new page): a list of existing profiles with name, display name,
   state (running / stopped, from each profile's `.agent.pid`), and three actions:
   **열기** (spawns `process.execPath --profile <name>` detached, same binary), **새 세라
   만들기** (name field → creates the two dirs, then opens it; the new instance runs the
   normal first-boot onboarding), **바로가기 만들기** (Windows: `shell.writeShortcutLink`
   on the Desktop with `--profile <name>`; macOS: a `.command` file in the data home that
   runs `open -n -a Scheherazade --args --profile <name>`; Linux: a `.desktop` file).
2. `--profile <name>` on the command line does the same without the UI. This is the only
   CLI argument the app reads; parse it from `process.argv` ahead of `main.cjs:48`.
3. The window title and the companion face carry the profile name when it is not the
   default, so two open Seras are tellable apart at a glance.

## What stays shared on purpose (v1), and what the UI must say about it

- **Claude / Codex logins.** `~/.claude`, `~/.claude.json`, the Keychain item
  `Claude Code-credentials`, `~/.codex/auth.json` are machine-wide; the app never sets
  `CLAUDE_CONFIG_DIR` (provider-env.cjs:559 unsets it on purpose). All profiles use the
  same login and the same weekly meter. Different model, provider or effort per profile is
  fine. Per-profile logins are out of scope: it would mean redoing the provider env
  contract and the Keychain item cannot be redirected. Copy on the profile page: "로그인은
  이 컴퓨터에서 하나야. 세라마다 모델은 다르게 고를 수 있어."
- **Ollama daemon** on 11434: one per machine, as now.
- **The installed app and its updater.** One install, one update. See Updater below.
- **The mac Safe Storage keychain item** (`Scheherazade Safe Storage`): one key, but
  each profile's ciphertext lives in its own data home, so this is already safe.
- **Chat channels.** A Discord/Slack/Telegram bot token drives one process. Two profiles
  need two bot tokens; the onboarding step says so when a token that another local profile
  already uses is pasted (compare the stored ciphertext's meta, not the secret).

## Collisions the builder must actually fix

Each line is a singleton the survey found outside the data home. All others already
follow `AGENT_DATA_HOME`.

1. `main.cjs:48` userData → `scheherazade-<name>`. This alone isolates the lock, the
   Chromium state and, on Windows, the OSCrypt `Local State` that the profile's
   `.credentials/*.key.enc` need (main.cjs:102-110). Never pair one profile's data home
   with another's userData.
2. `onboarding/http-server.cjs:162` `AGENT_NAME` constant → derive from the profile. This
   fixes the shared temp dirs `os.tmpdir()/agent-portable-<AGENT_NAME>*`
   (channel.mjs:124, channel-slack.mjs:487, channel-telegram.mjs:101).
3. `main.cjs:555` supervisor signature `supervisor.mjs __loop` is identical for every
   profile; add `--profile <name>` to the loop argv so the ps-match at pid verify cannot
   adopt another profile's supervisor. The pidfile path already differs.
4. `vendor/chromux/chromux.mjs:27` `CHROMUX_HOME` defaults to `~/.chromux` and nothing
   sets it → export `CHROMUX_HOME=<data home>/.chromux` to children. Otherwise browser
   profiles, run state and ports are shared between Seras.
5. `model-discovery.cjs:45` still reads `MEM` as a data-home input (allowMem default);
   pass `allowMem:false` like the other in-app callers.
6. Windows notifications: `notify-agent-reply.cjs:59` AUMID and :101 title are fixed to
   the product; append the profile name to the title for named profiles (AUMID can stay).
7. Updater (`updater.cjs:86-102`): `quitAndInstall` from one instance while another
   profile runs leaves NSIS trying to replace files in use. Before offering "지금 재시작",
   read the other profiles' `.agent.pid`; if any is live, the prompt says "다른 세라
   (<names>)도 닫혀야 설치돼" and offers only "나중에" (autoInstallOnAppQuit still
   applies on the last quit). Also do not prompt in every instance: the instance that
   downloaded prompts, the others log.

## Limits (say them in the UI copy, do not fight them)

- Memory is not shared between profiles. A profile is a different person, not a second
  window on the same one. A read-only shared "household" memory is a later design.
- Two profiles cost two agent processes and two model sessions. On a weekly-metered
  login the meter is shared.
- A profile cannot be renamed. It can be deleted (Settings > 프로필 > 삭제, confirm, both
  dirs moved to the Trash, never `rm`).
- macOS `open -a` reuses the running app unless `-n` is passed; the shortcut must pass
  `-n`, and the profile page's **열기** must spawn the executable directly.

## Settings

- New page `프로필` under Settings (list, 열기, 새 세라 만들기, 바로가기 만들기, 삭제).
- `.agent-config` gains `PROFILE=<name>` (empty for default), written at creation, read
  back only to label the UI; the path is the truth, not this field.

## Deliverables for 0.5.0

1. `--profile` parse + early `AGENT_DATA_HOME` / `setPath('userData')` in `main.cjs`;
   `AGENT_NAME` derived; supervisor loop argv; `CHROMUX_HOME` export; `allowMem:false` in
   model-discovery; notification title.
2. Profiles page + routes (`/api/profiles` list/create/open/shortcut/delete), window
   title and companion label.
3. Updater guard for other live profiles.
4. Tests: `test-data-home.mjs` (profile → both paths), a `test-profiles-routes.mjs`
   (create/list/delete on a temp appData), `test-supervisor.mjs` (signature carries the
   profile), `test-updater.mjs` (prompt withheld while another profile's pid is live), and
   a packaging rehearsal that launches two profiles on the Windows box and shows two
   windows, two `.agent.pid`, two memory.db, one login.
5. Release notes entry in the new agent-readable format (`docs/release-notes-TEMPLATE.md`):
   "What you need to do: nothing; your Sera is the default profile."
