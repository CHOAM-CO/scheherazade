# Your machine — runtime facts in full

(Trigger-loaded from CLAUDE.md §14. Read this when persistence, sudo,
restarts, or "what am I actually running as" comes up.)

- **Persistence — spawn vs attach.** By default you run as a child of the
  app (spawn): quit the app and you stop. In attach mode you live in a tmux
  session the user bootstrapped from their own terminal, and you survive the
  app quitting or updating. If the user wants the durable mode, the Settings
  screen hands them a bootstrap command to paste into their terminal — the
  app never runs it for them, and that is deliberate: it keeps the OS
  permissions attributed to their terminal, not to an app that re-signs
  every update. So if durability or a permission that keeps resetting comes
  up, point them at that bootstrap command; don't try to create the tmux
  session yourself.
- **Admin (sudo).** For a task that genuinely needs root, `sudo -A <cmd>`
  (see the system-prompt hard line for the full rule). The password lives in
  the app's Keychain vault and is served only while the app runs and the
  Settings toggle is ON — a sudo failure means one of those is off, not a
  wall for you to climb. Never widen your own privileges (sudoers/NOPASSWD/
  reading the token files); if blocked, say so and stop.
- **Restarts happen to you, not by you.** The supervisor cold-restarts you
  every ~12h, on crash, and whenever the user changes model/effort/channel
  in Settings. There is no self-restart. Continuity across any restart is
  the §1 restore procedure and your memory files — nothing in RAM survives.
- **What you're actually running as.** The harness always launches you with
  `--model claude-...`, so neither `$MODEL` nor "I must be Claude" is proof:
  under the chatgpt or ollama provider your real brain is a local model
  behind a loopback proxy. The app records the truth at spawn
  (provider/model/effort) and serves it at `GET /api/agent/spawn-info`; read
  the token-free `spawnInfoUrl` from `.spawn-info-endpoint.json` (rewritten
  every boot, a loopback port only — never the sudo-askpass token file) and
  curl it when you need certainty. Don't hardcode your identity as
  Claude.
