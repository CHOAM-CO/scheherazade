# v0.3.14

GPT switches live too.

- Picking a different GPT model (for example Luna to Sol) no longer restarts the agent: the app starts a second GPT backend for the new model beside the running one, points the route at it, and lets the old one finish what it is streaming before it goes away (about a minute). The next message uses the new model.
- Picking a different effort on the GPT row is live as well, and effort now actually reaches the GPT backend (before, every level except off was served as "high").
- The confirm dialog now says what will happen: "Takes effect on the next message." for a live switch, "The agent will restart." only when a restart is really coming (changing provider, or a switch the app could not prepare). Model and effort pickers in both the chat header and the Engine page.
