# v0.1.8 — the gauge, the storm, and the polish

A wide batch: the Claude usage gauge is made to actually work (not just fail
politely), two message-reliability bugs are killed, the supervisor becomes a
first-class Windows citizen, the UI gets a real once-over, and the Codex proxy
is brought current.

- **The Claude usage gauge works now — for real.** The old gauge asked an
  endpoint its token wasn't scoped for, drew a 403, and under polling those
  403s hardened into a persistent 429. The fix isn't a nicer error message: a
  full-scope OAuth login (loopback + PKCE, 8-hour access token with a rotating
  refresh) now backs the gauge, with a three-tier fallback (dedicated login →
  setup-token → CLI session) that always keeps the better reading. Connect it
  from Settings → Model & Providers.

- **A dual-channel reply storm is fixed.** With Discord and in-app chat both
  connected, after a restart the agent could fire the same reply four or five
  times. The silent-death guard was reading a reply to one channel as "never
  answered the other" and forcing resend after resend as pings interleaved. It
  now treats a message delivered to *any* channel as proof the agent isn't
  mute — no more forced cross-channel resends — while still catching a genuinely
  silent turn.

- **A failed send no longer suppresses its own retry.** The outbound
  de-duplicator recorded a message as "sent" before the send actually
  succeeded, so a retry after a failed send looked like a duplicate and was
  dropped. It now commits the dedup key only after delivery lands.

- **The stall watchdog stops going blind on resume, and Windows joins the
  club.** A resumed session appends to its old transcript, which the watchdog's
  freshness filter mistook for stale — so a hung resumed agent was never
  bounced. Fixed by admitting the live session's own transcript. And the
  watchdog is now enabled on Windows (with the powershell.exe path resolved
  absolutely, fixing an ENOENT that had kept it off).

- **The control panel got a real once-over.** Running/stopped state is now a
  green/red "bean" dot instead of a word; Start / Stop / Restart show their
  live state (enabled, pressed, busy-spinner) at a glance in an Apple-aligned
  green/orange/red palette. The seven flat tabs collapse to four daily surfaces
  — Chat, Memory, Settings, Logs — with Channels, Model & Providers, and
  Appearance tucked under a Settings sub-nav. A provider-config blip no longer
  paints every provider as "Not connected."

- **Codex proxy brought current (0.6.5).** The bundled proxy now knows the
  GPT-5.6 family natively instead of passing it through as an unknown model, so
  per-model settings (reasoning, service tier) apply correctly. Its context cap
  is corrected too: every GPT-5.x model is 272k, not the 372k the gauge used to
  show — the proxy actually auto-compacts around 245k, so the old number read
  the context as emptier than it was.
