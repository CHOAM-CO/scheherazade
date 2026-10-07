# v0.4.0

UI polish of the three admin tabs. No engine changes.

- Model & Providers: one card on top for model and effort, with a chip showing what is running now and whether the lane is live. Below it one card per provider (Claude web login, ChatGPT Codex, Ollama Cloud) with usage bars of equal length and the reset time in its own column; the Claude API-key card is gone, its slot is a "Coming soon" placeholder for providers added later. "Add a provider" is a collapsed panel at the bottom for custom OpenAI-compatible endpoints.
- Settings: a left rail (General / Channels / Appearance / System / Permissions) replaces the old sub-tab row; one column of cards, each with one Save button; permission status as rows.
- Logs: a sticky toolbar with source chips (App / Agent / Engine), level chips (Info / Warn / Error) with counts, text or regex search, wrap toggle, Pause/Resume with a "N new lines" pill while paused, Copy all and Open file. Warn and error lines are tinted.
- All three tabs reflow for narrow windows (one column, rail becomes a tab row, toolbar wraps); no horizontal page scroll.
