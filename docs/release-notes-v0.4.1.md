# v0.4.1

Claude Haiku 5.5 and automatic model discovery. No engine changes.

- Model & Providers: Claude Haiku 5.5 (released 2026-10-07) is in the picker. New Claude models are now discovered automatically from your Claude login, the way ChatGPT models already were; only the newest model of each family is added, so the list stays short. Discovered models are cached, so they stay listed offline.
- Agent: the operating rules now depend on the engine model. On a top-tier model (Claude Opus / Fable, GPT Sol / Astra) the agent delegates heavy reading, searching and bulk edits to background subagents and keeps only the conclusion. On smaller models (Sonnet, Haiku, Luna, local) it does the work itself and spawns nothing.
- Memory: the "Import from another AI" controls use the app's own themed dropdown and file picker instead of the browser defaults.
