Click-test round-2 build. Branch feat/login-shellout @ e20b9c7 (Mino 07-13 feedback items 1-8).

- Onboarding: three connect buttons on step 4 (Discord keeps tutorial flow; Slack/Telegram redirect + 지원예정 label) (2c1ab01)
- Onboarding: invite URL minted in-app from the pasted bot token — client_id derived from the token itself, permissions baked in; URL Generator tutorial steps removed, 6 -> 4 steps (d2d7472)
- Channel: MAGI-style 🤔 thinking reaction + typing indicator, cleared on reply (2c1ab01)
- Channel: send_file_to_discord tool — reply was text-only, found in Scheherazade's own boot test (10MB guard, returns CDN URL) (d2d7472)
- Memory page: manual refresh button; local-timezone rendering (was UTC hardcode) (d2d7472, 2c1ab01)
- Agent control: effort selector next to model dropdown (low/medium/high/max); spawn default lowered max -> high (6dfd037, d94ad8a)
- Multi-provider: settings page 추가 인증 section (ChatGPT = codex login, Ollama Cloud = ollama signin — reuses the onboarding login lane); authenticated providers unlock their models in the dropdown; provider switch validated server-side (6dfd037, 5086dd6)
- Fix: persona-reflux 🔒 grep anchored to line lead — mid-line mentions no longer propose fake corrections (Scheherazade boot-test catch) (22551ba)

Known caveats:
- Unsigned/un-notarized DMG: first launch needs right-click > Open
- Existing installs need re-onboarding to see the new step-4 connect buttons / invite flow (post-onboarding pages update without it)
- Login shell-outs require the CLIs: ChatGPT auth needs `codex`, Ollama Cloud auth needs the Ollama app installed
- Login flow / cross-provider switch: node --check + provider-env suite 49/49 + spark review passed, but NO live end-to-end round-trip yet — this build IS that test

Acquit criteria: pasting a bot token surfaces a working invite link that installs the bot with correct permissions; a file lands in Discord via send_file_to_discord; after settings-page auth the dropdown unlocks that provider's models and a cross-provider swap produces a reply from the new model; effort swap restarts the agent and visibly changes latency.
