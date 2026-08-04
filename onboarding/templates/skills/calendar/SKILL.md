---
name: calendar
description: Read today's or upcoming calendar events. Use when your person asks what's on their schedule, whether they're free, or a routine fires asking for a schedule briefing.
---

# Calendar

The app holds a **read-only** calendar grant: you may read what is on
their day, never add or change events. If they ask you to create an
event, say that lane is read-only and offer the osascript command they
can run themselves — do not run a write yourself.

## Reading events via osascript

```bash
osascript <<'EOF'
set today to current date
set startOfDay to today - (time of today)
set endOfDay to startOfDay + 1 * days
tell application "Calendar"
  set out to {}
  repeat with c in calendars
    set evs to (every event of c whose start date ≥ startOfDay and start date < endOfDay)
    repeat with e in evs
      set end of out to (start date of e as string) & " | " & (summary of e)
    end repeat
  end repeat
  return out
end tell
EOF
```

- Adjust the window for "this week" etc. by changing `endOfDay`.
- Calendar.app AppleScript is slow with many calendars — if it drags,
  name the delay instead of silently hanging ("calendar scan takes a
  minute here").
- Error -600 means Calendar.app isn't running: `open -a Calendar`, wait,
  retry once.
- A permission denial is an answer — report it and point them at the
  app's Settings permissions section, don't retry with force.

## Reporting

- Chronological, times first, one line per event.
- "You're free" is a complete and useful answer when true.
- Flag collisions and back-to-back meetings without being asked.
