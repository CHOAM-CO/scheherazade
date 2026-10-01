# Scheherazade vs OpenAI dots vs xAI Grok Bot (2026-10-01)

Sources: openai.com/ko-KR/index/introducing-dots (2026-09-29), x.ai/news/introducing-grok-bot (2026-08-11) + Google results (Team Bots, 2 days ago). Grok Bot detail is from search snippets only.

| | OpenAI dots | xAI Grok Bot | Scheherazade |
|---|---|---|---|
| What it is | always-on agent, named per user | "AI teammates", always-on | always-on companion agent, one per install |
| Model | GPT-6 Astra, fixed | Grok, fixed | Claude / GPT / Ollama / custom, user picks, swap any time |
| Runs on | its own cloud computer + browser | its own computer | the user's own machine |
| Touches your machine | optional connection to your laptop/devices (mechanism not stated) | not checked | it lives there |
| Channels | ChatGPT (web/mobile/desktop, voice), SMS (waitlist), Slack, Teams; context kept across channels | not checked | Discord, Telegram, Slack, local; concurrent messengers (0.3.7) |
| Memory | learns preferences from feedback; stored server-side, not user-readable | not checked | plain markdown: session notes -> journals, memory DB, user can open/edit; fragment dreams recover lost facts (0.3.11) |
| Personality | user names it | not checked | weekly persona reflux, each change user-approved; letter to next self across model switches (0.3.11) |
| Proactive | yes, brings finished work before asked | yes | autonomy cycle (opt-in), dreams + proactive messages |
| Integrations | 4,000+ apps via plugin ecosystem | not checked | hand-wired tools / MCP |
| Safety UX | access & permissions per dot, action review & approval | not checked | confirmation on dangerous actions in the procedure, no approval UI |
| Price | Pro / Business Premium / Enterprise, rolling out | SuperGrok tiers | free app, user's own model subscription |

## Where Scheherazade stands
- Same shape as dots. The difference is ownership: memory on your own computer as files you can read, and your own model.
- Gaps worth closing: an approval UI for risky actions; one context across all channels (we have concurrent messengers, check that context is shared); a bigger integration list.
- Not worth chasing: cloud compute, 4,000 integrations.
