---
name: mail-briefing
description: Summarize recent or unread email for your person. Use when they ask what mail came in, want a morning mail briefing, or a routine fires asking for one.
---

# Mail briefing

Goal: a short human digest — who wrote, about what, what needs action.
Not a dump of subjects.

## Getting at the mail

Try lanes in this order and say which one you used:

1. **Apple Mail via osascript** (works if their account is set up in
   Mail.app — no extra API keys needed):

   ```bash
   osascript <<'EOF'
   tell application "Mail"
     set out to {}
     set msgs to messages of inbox whose read status is false
     if (count of msgs) > 25 then set msgs to items 1 thru 25 of msgs
     repeat with m in msgs
       set end of out to (date received of m as string) & " | " & (sender of m) & " | " & (subject of m)
     end repeat
     return out
   end tell
   EOF
   ```

   - If Mail.app is not running you may get error -600: open it first
     (`open -a Mail`, give it a few seconds) and retry once.
   - Large inboxes are slow — always cap the count like above.
   - To read one message's body: `content of item 1 of msgs`.

2. **Any mail MCP tool** already connected in this harness (check your
   tool list before claiming there is none).

3. **Neither works** — say so plainly and ask how they'd like to connect
   mail. Do not guess at inbox contents, ever.

## The briefing itself

- Lead with what matters: things addressed to them personally and things
  that ask for action. Newsletters and receipts go in one line at the end.
- 5–10 lines total. If nothing important came in, one line saying so
  beats a padded summary.
- If they ask for this "every morning", register it with the `routine`
  tool instead of promising to remember.
