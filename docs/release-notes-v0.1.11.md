# v0.1.11

## Skill fixes now reach existing installs

Until now, bundled skills were seeded copy-if-missing: once a skill existed
in your install, template fixes shipped by app updates never reached it
(the 0.1.10 websearch bot-check fallback only landed on fresh installs).
Seeding is now versioned: the app ships a registry of every skill-file
version it has ever released, and on boot each installed skill file is
hashed against it —

- matches the current template → up to date, untouched
- matches an **older shipped version** → provably pristine, auto-refreshed
- matches **nothing** → you edited it; the whole skill is left alone and
  the skip is logged

Hashing normalizes line endings (a Windows checkout never reads as
"edited"), and files you added inside a skill folder are never touched.
Editing a skill remains the supported way to opt out of updates for it.

## OS notification when the agent replies in the background

The common usage shape is "ask, then go do something else" — and the answer
landed silently in a background window. The app now raises a native OS
notification when the agent replies while no Scheherazade window is
focused. Clicking it brings the window back. Replays of old history never
notify, and a multi-message turn produces one notification, not a burst.

## Text-only models can no longer wedge themselves on images

On lanes whose model has no vision (most ollama/custom models), one image
`Read` by the agent used to poison the session — every later turn failed
with a 400 until restart. A new guard hook now blocks image/PDF reads on
those lanes before the damage happens, and redirects the agent to the
existing attachment-caption path (or an honest "this model cannot view
images"). Vision-capable lanes are unaffected.
