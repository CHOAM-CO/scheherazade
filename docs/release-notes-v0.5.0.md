# Scheherazade 0.5.0

Companion mode, call mode, read-aloud, Korean speech-to-text, and now more than one Sera on the same computer.

## What changed
- You can make a second Sera. Settings > 프로필 > 새 세라 만들기 gives you another Sera with her own memory, settings and chat channels, running at the same time as this one. Each has her own window and name tag.
- Your current Sera is the "default" profile. Her folder, memory and settings stay exactly where they were.
- Companion mode: a small face in the corner that speaks in a bubble when something needs you (off by default, Settings > 컴패니언).
- Call mode: talk to Sera by voice and hear her answer; mic and voice can be toggled during the call.
- Read-aloud with the built-in "Sera" voice; Korean speech-to-text with a small (72M) or large (174M) model picker.
- Model switching errors now say why in the panel instead of failing silently.

## What you need to do
- Nothing. Your Sera is the default profile and keeps working as before.
- If you make a second Sera and want her on Discord, Slack or Telegram, she needs her own bot token; one token drives one Sera.

## Known issues
- 이미 켜져 있던 세라는 새 세라가 생겨도 "다른 세라에게 말하기"를 다음에 다시 켤 때부터 쓸 수 있어.
- 기본 세라 폴더에 .agent-config가 없으면 다른 세라 목록에 안 보여.
- Updating while two Seras are open: the installer needs both closed. The update prompt will say which other Sera is still running and offer "나중에"; it installs on the last quit.
- A profile name cannot be changed after creation. Pick a short lowercase name.
- Companion mode does not draw over exclusive-fullscreen games.

## Unchanged
- Claude and Codex logins are per computer: every profile shares the same login and the same weekly limit. Each profile can still pick a different model.
- Speech models and the Sera voice are the same files as the 0.5.0 betas; no new downloads if you already have them.
- Credits unchanged (Pocket-TTS Kyutai / seastar105 CC BY 4.0).

## For developers
- `profile_say` runs without a permission prompt, including in the default profile.
- design-0029 profiles: `--profile <name>` parsed before userData is set (profile.cjs, main.cjs); data home `~/Documents/Scheherazade-<name>`, userData `<appData>/scheherazade-<name>`; AGENT_NAME derived; supervisor loop argv carries the profile; CHROMUX_HOME per data home; model-discovery allowMem:false; notification title; updater guard with per-version prompt-owner pid file. Routes: onboarding/routes/profiles.cjs (`/api/profiles` list/create/open/shortcut/delete, `default` reserved). Page: onboarding/public/profiles.html + js/profiles.js.
- Tests: test-profile, test-profiles-routes, test-profiles-ui, test-supervisor, test-updater extended.
- Betas 0.5.0-beta.1..10 notes remain in docs/ for the per-feature detail.
