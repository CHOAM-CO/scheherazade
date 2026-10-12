# Bug report (outside user sanha, Instagram DM 2026-10-12, relayed by Mino 11:58 KST)

App 0.4.2 Windows, lane dsh-lane, provider claude-subscription (route proxy key=passthrough -> api.anthropic.com), model claude-opus-5-5. Since 10-04 daily, 32 failed turns.

Symptom: hours after a restart every turn ends in <0.5s with 401 "OAuth access token has expired. Re-authenticate to continue." Process alive, Slack socket up, boot messages still posted; user only notices "no reply". Inbound messages + scheduled routines bounced and not reprocessed. Longest outage 10-08 16:10 -> 10-11 09:00 UTC (~65h).

Restart -> first AUTH failure: 14h20m / 8h12m / 12h48m / 11h54m / 9h06m. Failure is logged at the first turn after expiry, so real lifetime <= 8h12m. Control-panel restart fixed it every time (6x) without re-login, so the login session is valid; only the running process's access token expired.

Lane recycle (3 consecutive turn errors -> fresh session) ran 7x and failed immediately with AUTH again: supervisor respawn inherits the old env (ANTHROPIC_AUTH_TOKEN). Control-panel restart goes through [main] (route-proxy re-init + spawn) and works.

Requests: (1) refresh access token before expiry while running, or read latest credentials per request (proxy can swap the header); (2) at minimum, on turn end AUTH route the recycle through main (re-acquire credentials -> spawn); (3) show "auth expired, agent cannot respond" in app UI + tray.

Notes: ~/.claude/.credentials.json mtime 2026-09-13 (app manages creds elsewhere). Separate: 2026-08-20/21 "Your organization has disabled Claude subscription access for Claude Code".

Matches docs/sera_crash_audit_20261012.md candidate 2 (MAGI repo).
