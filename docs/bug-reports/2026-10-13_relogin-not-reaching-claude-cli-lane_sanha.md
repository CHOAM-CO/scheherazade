# Bug report (outside user sanha, 2026-10-13, relayed by Mino)

App 0.4.3 or 0.4.4 Windows, provider claude-cli (route proxy key=passthrough -> api.anthropic.com).

Symptom: every turn 401 "OAuth access token has expired". Settings > Connectors "Re-login" completes, yet turns keep failing. The Claude usage card shows Connected the whole time. The AUTH auto-restart does not help.

Trace (pre-fix line numbers, verified against code at 5f01e95):
- The claude-cli route reads only Claude Code's own store: provider-env.cjs:606 readClaudeCliStore (~/.claude/.credentials.json; keychain only on darwin), :720 readClaudeCliToken, :651 refreshClaudeCliToken. Once that file's refresh token is rejected, the read is always "expired".
- Re-login stores the new token under 'claude-subscription' (onboarding/http-server.cjs:2169, storeProviderKeyVerified). The store listener only drops the proxy credential cache (main.cjs onProviderKeyStored -> invalidateClaudeAuthSources). The claude-cli loader (main.cjs claudeAuthSourceFor) re-reads the same dead CLI file and returns null, so the proxy (route-proxy.cjs:259) forwards the lane's spawn-frozen header unchanged. Re-login changed nothing on this route.
- Spawn path: buildProviderEnv('claude-cli') also read only the CLI store, so the AUTH restart (dsh-lane.mjs:1069 -> main.cjs RESTART_REQUEST_COOLDOWN_MS) re-ran the same failing refresh and hit not_ready.
- Usage card: fetchClaudeSubscriptionUsage (onboarding/http-server.cjs:3334) reads its own 'claude-usage' token first, so it reads the meter and shows Connected while the chat lane is dead.

Fix:
- provider-env.cjs resolveClaudeLaneToken: claude-cli order is (1) CLI login if valid, (2) stored 'claude-subscription' token if present and not expired, (3) error with the CLI reason. claude-subscription is unchanged (slot only, empty -> not_ready). The claude-cli row's pre() uses it, so spawn and AUTH restart pick the Re-login token up.
- main.cjs claudeAuthSourceFor('claude-cli'): after refresh + CLI read fail, returns the 'claude-subscription' source's token (blob refresh included). Re-login invalidates the cache, the next proxy request loads the new token and applyAuthToken overwrites the frozen header. No restart needed. Pre-spawn also warms the subscription source when the CLI login is dead.
- AUTH banner: /api/agent/turn-error returns loginHint 'cli-terminal' only when the route is claude-cli and no subscription token is stored; the banner then adds "or log in again by running `claude` in a terminal". Otherwise text unchanged.
- Usage card: /api/usage/claude adds laneAuthFailing (AUTH marker present on a Claude login route); the Claude chip then reads "Chat token expired, re-login needed" instead of Connected.
- tests/test-claude-auth-fallback.mjs: resolution order with fake stores, spawn path, hint branch, banner text.

Untested:
- Windows live: Re-login on a box with a dead ~/.claude/.credentials.json, then a turn without restart. Only unit-level and static checks here.
- Proxy header override with a real Anthropic 401 -> Re-login -> 2xx cycle (route-proxy override path is covered by existing test-route-proxy, the fallback hookup in main.cjs is not exercised by any test since main.cjs needs Electron).
- Usage chip rendering in the real window.
- Cost note: with the fallback, a claude-cli user whose CLI login dies silently runs on the Sera-login token; both spend the same subscription.
