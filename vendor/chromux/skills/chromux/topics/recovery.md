# chromux deep guide: recovery and human handoff

On-demand guide (`chromux skill recovery`). Read when a flow is stuck,
ambiguous, or blocked on something only a human can do.

## Stale refs after a re-render

SPAs re-render and `@refs` go stale (`Element not found`). Do not guess CSS —
click by what a human sees:

```bash
chromux click <s> --text "로그인"
```

Exact label match wins; if several elements share the text the error lists
the candidates. Re-snapshot (`--diff`) when more than one action follows.

## Dialogs (alert/confirm/prompt)

Dialogs are auto-handled per session policy (default: dismiss; `beforeunload`
always accepted) and reported in the acting response's `dialog` field with
the dialog's message. If the flow NEEDS acceptance
(`confirm("Delete item?")` → OK), reopen with the policy and redo the action:

```bash
chromux open <s> <url> --dialog accept
```

## Popups / new tabs

A click that opens a new tab reports `newSession` — continue in that session
instead of hunting for changes on the old tab. If a popup was opened by page
JS outside click/press (rare), `chromux list` still shows only adopted
sessions; re-click the trigger if you missed it.

## "No visible change" after an action

The action was dispatched; the page may be slow, or the result may be in a
dialog/new tab (both are reported when detected). Escalate in this order:
`wait-for-text` for the expected outcome → `snapshot --diff` → `watch <s>
console` / `watch <s> network` for silent failures. Never blindly repeat a
submit-like action.

When several verified actions in a row change nothing, the verify hint adds a
`# stalled:` line. Treat it as a hard stop signal, not noise: you are almost
certainly stuck on a dead control, behind an overlay/dialog that is eating the
click, or in a loop. Do not repeat the action. Switch to a different element,
dismiss the overlay, `wait-for` the state you expect, or hand off to the user.

## Cross-origin frame refs

The default snapshot exposes an opaque frame ref, origin-only identity, and CSS rect without reading child DOM.
Use the rect for visible pointer actions when that is sufficient.

If reliable child text or DOM actions are required, reopen the page with `chromux open <s> <url> --oopif` and take a fresh snapshot.
Namespaced refs such as `@f1g1:2` support snapshot, click, fill, and waits.
Child navigation or detach changes the namespace; a stale-child error means re-snapshot, not retry.
Keep `--oopif` opt-in because child-target attachment adds payload and browser automation surface.

## Human handoff: login, 2FA, CAPTCHA, payment

Credential walls are user-owned. If the Bitwarden secret-store add-on is set
up, try `chromux fill <s> @<ref> --secret <host>:password` first (see the
main skill's Secret Store section) — a `not-found`/`locked` response falls
straight through to this same manual handoff. The formal handoff loop — the
profile is a real persistent Chrome profile, so one human login persists
across sessions:

```bash
# 1. Put the blocked page in front of the user (profile must be HEADED)
CHROMUX_PROFILE=<p> chromux open --foreground handoff-<slug> <login-url>
# 2. Hard-stop agent actions so nothing races the human (waits stay allowed)
CHROMUX_PROFILE=<p> chromux pause
# 3. Tell the user what to do and that you will not touch credentials
# 4. Wait for a signal only a logged-in page shows
CHROMUX_PROFILE=<p> chromux wait-for-selector handoff-<slug> "<authed-only-selector>" 300000
# 5. Resume and re-drive the interrupted flow FROM THE START
CHROMUX_PROFILE=<p> chromux resume
```

Redirects usually discard form/modal state, so after the handoff re-open the
modal, re-fill, re-submit; do not resume mid-flow. If the profile is
headless, relaunch headed first (`chromux kill <p> && chromux launch <p>`).
The same loop covers 2FA prompts, CAPTCHA walls, and payment confirmation
screens — anything where the human acts, then the agent resumes unattended.
