# 0.4.6 — Slack / Discord / Telegram restart-loop hotfix

- **Fixes the engine dying every few seconds with `auth.test failed: invalid_auth`**
  (Slack; the same line hits Discord and Telegram). Since 0.4.4, when a
  `lane.patch.yml` with your own providers existed, the launcher rewrote the
  engine config through a YAML library that did not understand the channel
  token placeholders, so the engine was handed the literal text
  `process.env.SLACK_BOT_TOKEN` as its token. The placeholders now survive.
- No action needed after updating: the agent comes back on its own. If the
  red "Claude login expired" banner is still showing, press Dismiss.
