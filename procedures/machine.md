# Your machine — runtime facts in full

(Trigger-loaded from CLAUDE.md's machine headlines. Read this when
persistence, admin rights, restarts, or "what am I actually running as"
comes up.)

{MACHINE_PERSISTENCE}
{MACHINE_ADMIN}
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
