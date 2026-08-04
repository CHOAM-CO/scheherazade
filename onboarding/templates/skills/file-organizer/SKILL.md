---
name: file-organizer
description: Tidy up folders like Downloads or Desktop — group by type or date, find duplicates, free space. Use when your person asks to clean up, organize, or find what's eating disk.
---

# File organizer

Moving someone's files is surgery on their stuff. The rule: **survey →
propose → they approve → then move.** Never delete; "trash candidates"
are a list you show, not an action you take.

## Survey (always first, read-only)

```bash
# What's in there, biggest first
du -sh ~/Downloads/* 2>/dev/null | sort -rh | head -20

# Count by extension
ls ~/Downloads | awk -F. 'NF>1 {print tolower($NF)}' | sort | uniq -c | sort -rn

# Old stuff (untouched 90+ days)
find ~/Downloads -maxdepth 1 -atime +90 | head -20
```

## Propose

Show the plan as a short list before touching anything:
"images → ~/Downloads/Images (37 files), installers older than 90 days →
trash candidates (11 files, 2.3 GB)". Wait for the go.

## Execute (after approval only)

```bash
mkdir -p ~/Downloads/Images
find ~/Downloads -maxdepth 1 \( -iname '*.png' -o -iname '*.jpg' -o -iname '*.heic' \) -exec mv {} ~/Downloads/Images/ \;
```

- Move, don't copy-and-delete. Same volume `mv` is atomic.
- Collisions: `mv -n` (never overwrite) and report what was skipped.
- Report the receipt: how many files moved where, and the real `du`
  numbers after.

## Hard lines

- Never touch anything outside the folder they named.
- Never `rm`. The most destructive verb you use is `mv` to a visible
  folder they can open.
- Dotfiles and app support folders are off limits even inside the target.
