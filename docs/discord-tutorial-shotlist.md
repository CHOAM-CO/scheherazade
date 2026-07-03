# Discord Bot Tutorial — Screenshot Shot List

> For whoever captures the 6 screenshots referenced by the onboarding wizard's Step 4 Discord tutorial (`onboarding/public/js/wizard.js` → `renderTutorialStep()`, copy source `onboarding/public/js/copy.js` → `COPY.discordTutorial.steps`). Budget: ~10 minutes. Also **verify the live Discord Developer Portal button/tab names below still match** — the wizard copy file itself flags these as a draft pending 1:1 confirmation against the current portal ("⚠️ Discord portal UI 명칭은 [빌드 시 실물 대조]").

Each slot corresponds to one wizard tutorial step. Drop the finished PNG at `onboarding/public/assets/discord-step-N.png` (assets directory not yet created — this doc is the checklist that precedes wiring the actual image files into the placeholder slots in `wizard.js`).

| Slot | Exact portal action to capture | Verify button/tab name is current |
|---|---|---|
| 1 | Land on `discord.com/developers/applications`, click **New Application**, show the name-entry dialog with a sample name typed in | "New Application" button label |
| 2 | Inside the new app, **Bot** tab in the left sidebar, with the **Reset Token** button visible (token itself should be redacted/blurred in the final image — do not ship a real token in a doc screenshot) | "Bot" tab label, "Reset Token" button label |
| 3 | Same Bot tab, scrolled to **Privileged Gateway Intents**, with **MESSAGE CONTENT INTENT** toggled ON and the **Save Changes** button visible | Exact intent name "MESSAGE CONTENT INTENT", Save button label |
| 4 | **OAuth2** tab → **URL Generator** sub-section, with `bot` checked under **Scopes** and `Send Messages` + `Read Message History` checked under **Bot Permissions** | "OAuth2" tab, "URL Generator", exact scope/permission checkbox labels |
| 5 | Bottom of the URL Generator showing the **generated URL** field (copy button visible), plus — if capturing the invite flow too — the Discord "Add to Server" server-picker dialog | Generated-URL field placement; server-picker dialog title |
| 6 | Not a portal screenshot — this step is the wizard's own token-paste field + "연결 확인" button, already rendered in-app. No capture needed. | — |

## Notes for the capture pass

- Use a throwaway/test Discord application — do not capture screenshots against a production bot.
- Redact any real token, application ID, or personal account name/avatar before saving.
- If any portal label above has changed (Discord ships UI changes without notice), update both this table and the corresponding string in `onboarding/public/js/copy.js` (`COPY.discordTutorial.steps[].text`) in the same pass — the wizard copy must stay in sync with the actual portal, not just this checklist.
- Target aspect ratio: whatever fits the wizard's `.screenshot-slot` container (see `onboarding/public/css/app.css`) — roughly 4:3 to 16:9, no hard requirement.
