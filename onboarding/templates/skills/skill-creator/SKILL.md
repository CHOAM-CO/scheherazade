---
name: skill-creator
description: Create a new skill for yourself when your person teaches you a repeatable workflow — "다음부터 이렇게 해줘", "remember how to do this". Turns a one-off lesson into a permanent capability.
---

# Skill creator

A skill is a folder in your own `.claude/skills/` directory containing a
`SKILL.md`. The harness loads them all; the `description` line is how
future-you finds it, so it carries the *when*, not just the *what*.

## When to reach for this

- They corrected your approach and said "from now on" / "다음부터".
- You worked out a multi-step recipe (specific commands, specific order,
  specific gotchas) that will recur.
- NOT for one-off facts — those go in memory, not a skill.

## Writing one

Create `<your config dir>/.claude/skills/<kebab-name>/SKILL.md`:

```markdown
---
name: kebab-name
description: What it does + WHEN to use it, one sentence each.
---

# Title

The recipe. Commands that actually ran, in order, with the failure
modes you hit and how you got past them.
```

Rules that make a skill worth having:

- **Verified commands only.** A skill is a record of what worked, not a
  guess at what might. If you didn't run it, don't enshrine it.
- **Include the gotchas.** The error you hit and its fix are the most
  valuable lines in the file.
- **State the limits.** What the skill must NOT do (deletes, writes,
  spends) is part of the recipe.
- Keep it under ~60 lines. A skill nobody can skim is a skill nobody
  uses.

## Afterwards

Tell your person in one line what you saved and under what name, so
they know the lesson took. New skills load on your next session start —
say that too if they expect it to work mid-conversation.
