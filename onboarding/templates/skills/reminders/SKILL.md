---
name: reminders
description: Read or add Apple Reminders. Use when your person asks what's on their to-do list, wants something remembered as a task, or asks you to check things off.
---

# Reminders

## Reading open reminders

```bash
osascript -e 'tell application "Reminders" to get name of reminders whose completed is false'
```

For due dates too:

```bash
osascript <<'EOF'
tell application "Reminders"
  set out to {}
  repeat with r in (reminders whose completed is false)
    set d to ""
    try
      set d to due date of r as string
    end try
    set end of out to (name of r) & " | " & d
  end repeat
  return out
end tell
EOF
```

## Adding one (only on their direct ask)

```bash
osascript -e 'tell application "Reminders" to make new reminder with properties {name:"REMINDER TEXT", due date:date "2026-08-05 09:00"}'
```

Note: `date "..."` parsing is locale-sensitive. If it errors, build the
date in AppleScript instead:

```applescript
set d to current date
set hours of d to 9
set minutes of d to 0
```

## Completing one

```bash
osascript -e 'tell application "Reminders" to set completed of (first reminder whose name is "REMINDER TEXT") to true'
```

## Judgment

- Error -600: `open -a Reminders`, wait, retry once.
- Adding/completing changes their data — do it only when they asked for
  exactly that, and echo back what you changed in one line.
- "Remind me at 9" with no list context goes to their default list;
  say which list it landed in.
- If they want a *recurring nudge from you* rather than a Reminders
  entry, that's the `routine` tool, not this skill — offer the choice.
