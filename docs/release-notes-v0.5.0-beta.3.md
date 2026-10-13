# 0.5.0-beta.3 — Voice beta + the 0.4.5/0.4.6 fixes (private rehearsal)

Same features as 0.5.0-beta.2 (read aloud, voice input, companion; all off by
default). This build carries the two hotfixes shipped to the stable line today:

- **Re-login reaches the chat lane** (0.4.5): a token saved from Settings > Re-login
  is now also used by the Claude CLI route and the usage card; the status chip says
  "Chat token expired, re-login needed" instead of failing silently.
- **Slack/Discord/Telegram tokens survive the lane merge** (0.4.6): the engine no
  longer receives the literal text `process.env.SLACK_BOT_TOKEN` as a token when
  `lane.patch.yml` carries providers, which caused the `auth.test invalid_auth` loop.
- Build: onnxruntime binaries for other platforms are dropped from the installer.

Known: the chat window rechecks the companion toggle every 15 s. Windows mic and
orb hit area untested.
