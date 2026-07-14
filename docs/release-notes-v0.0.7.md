# Scheherazade v0.0.7

2026-07-14. v0.0.6 shipped this morning and kept moving under the same
version string (three rebuilds during the day's work) — 0.0.7 exists so the
artifact name and its contents agree again.

## Since v0.0.6 (this morning's DMG)

- **Model selector reorganized by provider** (Mino 09:45 directive): grouped
  Claude / GPT / Ollama with explicit versioned model ids (Fable 5, Opus
  4.8 / 4.6, Sonnet 5; GPT 5.6 Sol / Terra / Luna; DeepSeek V4 Pro, GLM
  5.2). Old stored aliases surface as "(current)" and heal on next swap.
- **Kimi dropped entirely** (Mino 09:27 "프로바이더째로 드랍하자"): catalog
  entry removed. The mute-strike ledger stays as the model-agnostic
  backstop.
- **Journal reader fix**: boot restore now reads the DB journal for the
  last 3 days — a letter with a reader. First live verification = first
  boot after installing this build: the agent's restore should mention
  yesterday's journal.
- **Windows-port groundwork, all inert on mac**: node supervisor lane
  (`SUPERVISOR_LANE=node`, default stays bash), node-pty bundled with two
  upstream defects repaired at postinstall, per-platform CLI bundling.
- **bash removed from hooks + cycle scripts**: 6 files ported to node.
  Existing installs are migrated automatically at boot (hook commands
  rewritten to the node ports; hand-edited commands untouched).

## Upgrade

Replace the app, then restart the agent once (설정 → 재시작, or quit and
reopen). No re-onboarding; memory/journals/config untouched.

macOS Gatekeeper: unsigned build — first open needs right-click → 열기.

## Suite receipts at build

provider-env 56 · mute-ledger 16 · packaging 29 · journal 35 ·
supervisor 79 · hooks-port 44 — all green, packaging verified against the
built artifact.
