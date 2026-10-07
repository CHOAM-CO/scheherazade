# v0.3.15

- Live model/effort switches no longer ask for confirmation; the dialog appears only when a restart is really coming. After a live switch the chat status row shows one short "Switched to … / …. Takes effect on the next message." line and the Engine page's apply-state line updates.
- The agent now sees the effort you picked: a live effort change reaches the engine session on every provider (not only Claude), and `.live-route.json` in the data directory holds the current model/effort for the agent to read instead of its stale spawn env.
