# 0.4.5 — Re-login hotfix

- **Re-login now reaches the chat lane.** When Sera runs on the Claude Code login
  and that login's refresh is rejected, the chat lane falls back to the token you
  get from Settings > Re-login, without a restart. Before, Re-login stored the
  token in a slot the Claude Code route never read, so chat kept failing with
  "OAuth access token has expired" while the usage card still said Connected.
- The expired banner suggests running `claude` in a terminal only when there is
  no Re-login token to fall back to.
- The Claude status chip says "Chat token expired, re-login needed" instead of
  Connected while the chat lane is failing auth.
- Codex usage windows are labeled from their real length instead of a fixed 5h.
