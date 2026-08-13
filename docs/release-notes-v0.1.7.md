# v0.1.7 — the follow-through

0.1.6 made failures loud; 0.1.7 makes the recovery and the visibility
complete. Same-day batch, all four items requested together.

- **Messages swallowed by a failing turn now come back.** A question that
  merged into a doomed turn (rate-limit storm, poisoned transcript) used to
  vanish when that turn errored — the error "paid for" the queue. Only
  successful turns pay now; survivors are redelivered exactly once after a
  recycle, with the existing no-double-reply note.
- **Chat shows the work, not just Bash.** The in-app chat's live activity
  fold now carries WebSearch (query), WebFetch (host+path), and subagent
  spawns (description) alongside Bash commands. A 20-call research turn no
  longer looks like a dead agent in the chat while the Logs page scrolls.
- **Ollama model list is live.** The picker's Ollama group merges the
  current ollama.com catalog at page load (curated rows keep their labels;
  the by-URL escape hatch stays). Claude went dynamic in 0.1.6; Codex stays
  static for now — the bundled proxy's own table is older than the models
  it actually serves, so scanning it would make the list worse.
- **Slack images get described.** On a lane that provably cannot see
  images, inbound Slack images now arrive with a small-vision-model caption
  (same policy as the in-app chat: known-blind lanes only, three per
  message, silent degrade to the honest "cannot view" marker). The ollama
  key never leaves the app process — the channel asks the app to caption
  over an authenticated per-boot loopback endpoint.
- Mute notices in the messenger now point at the panel's one-click model
  revert — and only claim the button exists once it actually does.
