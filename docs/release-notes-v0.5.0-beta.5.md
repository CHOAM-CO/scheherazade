# 0.5.0-beta.5 — model switching and speech recognition (private rehearsal)

- Switching the model from the control panel no longer leaves a silent dead agent.
  A failed selection now stops the agent, shows the engine's reason in the panel
  and points to the model picker. (Tonight's failures: `medium` effort was not
  declared on hand-declared routes; Claude 5.5 ids were missing from the bundled
  catalog.)
- Every picker effort level (low / medium / high / xhigh / max) is declared to the engine.
- Claude models are declared by the app itself (Opus 5.5 / Sonnet 5.5 included)
  instead of relying on the bundled catalog.
- Korean speech recognition decodes with beam search (8 paths) instead of greedy;
  the model's published accuracy is measured that way.

Known: a repeated short utterance within 2 s is dropped; one failed audio upload
ends a call; interruption works only between sentences. Retryable upstream
overload errors are still shown as errors while retrying.
