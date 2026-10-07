# v0.3.14

GPT switches live too.

- Picking a different effort on the ChatGPT (GPT) row no longer restarts the agent: the next message simply uses it. Effort now actually reaches the GPT backend (before, every level except off was served as "high").
- Picking a different GPT model switches live when the bundled backend knows the id; otherwise the agent restarts as before, and the dialog says so.
- The confirm dialog now says what will happen: "Takes effect on the next message." for a live switch, "The agent will restart." only when a restart is really coming. Model and effort pickers in both the chat header and the Engine page.
