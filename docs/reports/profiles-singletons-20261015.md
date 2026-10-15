# Sera profiles fact sheet (repo /Users/narr/Desktop/scheherazade, HEAD da80bcf, branch main)
pkg: name=scheherazade, productName=Scheherazade, version=0.5.0-beta.10 (package.json; appId com.choam.scheherazade :66)
Legend: DH=derived from data home, UD=Electron userData, HC=hardcoded

## 1. main.cjs
- main.cjs:48 app.setPath('userData', appData/'scheherazade') HC (not per-profile; overrides default productName dir)
- main.cjs:166 app.requestSingleInstanceLock() no args; Electron keys lock on userData -> UD. Changing :48 per profile would isolate lock.
- main.cjs:184 'second-instance' focuses window / reopenMainWindow
- main.cjs:576 AGENT_PIDFILE = DATA_HOME/.agent.pid (DH); :577-ish AGENT_FAILFILE DATA_HOME/.agent-failed.json (DH)
- main.cjs:555 SUPERVISOR_SIGNATURE = `${SUPERVISOR_MJS_PATH} __loop`; ps-cmdline match, NOT per-profile (same script path for all profiles) -> pid verify cannot distinguish instances, but pidfile path does
- main.cjs:1469,1934,2366,2417 export AGENT_DATA_HOME: DATA_HOME to children (DH)
- main.cjs:1934 child env also spreads process.env (inherits shell env)
- main.cjs:71-110 one-shot fold-in Documents/Scheherazade02 -> Scheherazade and appData/scheherazade02 -> scheherazade (HC legacy names)
- main.cjs:971 CHATGPT_PROXY_PORT config; default 0 (kernel-picked) unless user sets explicit; :2676 health poll localhost:port
- main.cjs:1119 route proxy 127.0.0.1 ephemeral (route-proxy.cjs:284 listen(0))
- codex-proxy-shim.cjs:69 inner listen(0); :107 outer listen(port) = explicit port only if configured
- No tray (main.cjs:2845 "still owed"), no protocol handler / setAsDefaultProtocolClient / open-url (grep empty)
- companion window: main.cjs:187 win.isSeraCompanion; one per process, no cross-process singleton
- notifications: notify-agent-reply.cjs:59 setAppUserModelId('com.choam.scheherazade') win HC; :101 title 'Scheherazade' HC; no ids otherwise
- main.cjs:2792 initReplyNotifications gets DATA_HOME

## 2. data-home.cjs
- data-home.cjs:42-46 resolveDataHome: AGENT_DATA_HOME > (allowMem? MEM) > ~/Documents/<agentName||'Scheherazade'> ; DEFAULT_AGENT_NAME :36
- data-home.cjs:51 resolveMemoryDb: SCHEHERAZADE_MEMORY_DB > DH/memory.db
- callers allowMem:false: onboarding/http-server.cjs:192, memory/service.mjs:72, onboarding/bootstrap.cjs:55, attach-topology.cjs:42, lane-providers.cjs:22, supervisor.mjs:124 (passes agentName=merged.AGENT_NAME)
- model-discovery.cjs:45 resolveDataHome() default args (allowMem TRUE -> reads MEM)
- channel-runtime.mjs:25,50 wrapper resolveDataHome(agentName)
- http-server AGENT_NAME hardcoded 'scheherazade' onboarding/http-server.cjs:162 (not per-profile)
- DATA_HOME is computed at require-time from process.env: profile must be selected via AGENT_DATA_HOME env BEFORE main.cjs requires http-server (main.cjs:~118), and after the :48 setPath.
- LOCKED rule: data-home.cjs:15-19 default fixed name, not keyed on AGENT_NAME/DISPLAY_NAME

## 3. onboarding server
- onboarding/http-server.cjs:2968 server.listen(0,'127.0.0.1') ephemeral; allowedHosts Set 127.0.0.1:port/localhost:port :2970
- renderer finds it: main.cjs:346 win.loadURL(url) from createOnboardingServer() return (no fixed URL)
- discovery files in DH: .spawn-info-endpoint.json :2982 ({port,spawnInfoUrl}); .sudo-askpass-endpoint.json :2997; .usage-endpoint.json :3020 (0600 token)
- ollama: provider-env.cjs:69 OLLAMA_BASE_URL http://localhost:11434 HC; onboarding/ollama-daemon.cjs:65 OLLAMA_PORT 11434 HC, daemon shared machine-wide (OLLAMA_HOST :188)
- fixed 127.0.0.1 route/codex ports only per-process ephemeral (see 1)

## 4. supervisor.mjs / channel-runtime.mjs
- supervisor.mjs:132-135 pidfile DH/.agent.pid, logfile DH/logs/agent.log, stopflag DH/.stop_requested, failfile DH/.agent-failed.json
- supervisor.mjs:151,153 legacy leaf patterns --patch DH/.dsh-lane-home/lane.patch.yml and lane.runtime.patch.yml (DH)
- lane-providers.cjs:22 laneHome = DH/.dsh-lane-home; dsh-lane.mjs:148 dshHome = MEM/.dsh-lane-home; dsh-lane.mjs:589 DSH_HOME env
- supervisor.mjs:714-716 child env AGENT_NAME, MEM=cfg.mem, CLAUDE_BIN; :112 AGENT_NAME from .agent-config
- supervisor.mjs:389 transcriptDirFor: ~/.claude/projects/<mem path sanitized> (HC ~/.claude; keyed by data-home path so per-profile OK)
- CLAUDE_CONFIG_DIR: never set by app (provider-env.cjs:47 comment, :559 set undefined); Claude CLI uses global ~/.claude + ~/.claude.json (harness-render ensureClaudeOnboardingDone http-server.cjs:2818) HC shared
- Claude CLI login: onboarding/http-server.cjs:416 ~/.claude/.credentials.json; provider-env.cjs:600 mac Keychain service 'Claude Code-credentials' (shared by all profiles, HC)
- codex: http-server.cjs:2018 ~/.codex/auth.json; :3438 CODEX_HOME||~/.codex; model-discovery.cjs:16 CODEX_HOME||~/.codex/models_cache.json (HC, shared)
- channel-runtime.mjs:210-211 liveness .agent-live[.suffix], failure .agent-failed[.suffix].json (DH)
- channel-runtime.mjs:657 DH/.gates/schedule-tick.lock; :681 DH/schedules.json
- channel-runtime.mjs:1052-1054 companion server listen(0), endpoint file via companionEndpointPath(dataHome, backend)
- tokens: no plaintext path; Discord/Slack/Telegram via readProviderKey('slack-bot'|'telegram-bot'|discord) -> DH/.credentials/<provider>.key.enc (http-server.cjs:1005,1029, :1077,:1089)
- ~/.config: none found by grep
- temp dirs: channel.mjs:124 os.tmpdir()/agent-portable-<AGENT_NAME>; channel-slack.mjs:487 same; channel-telegram.mjs:101 agent-portable-<AGENT_NAME>-telegram (keyed by AGENT_NAME only; AGENT_NAME=scheherazade for all app profiles -> COLLIDES)
- .agent-config DH http-server.cjs:207; .env :208; .mcp.json :209 (DH)

## 5. Credentials
- http-server.cjs:991-1003 safeStorage.encryptString -> DH/.credentials/<p>.key.enc; meta <p>.meta.json :1014 (DH)
- mac keychain item "Scheherazade Safe Storage" = productName-keyed (main.cjs:38-42 comment), ONE per app not per profile: key shared across profiles (ciphertext files per DH so fine)
- Win: OSCrypt key in userData/'Local State' (main.cjs:102-110); DH/.credentials undecryptable without matching userData -> profile must pair its DH with its own userData (or share userData)
- Win DPAPI per-user (main.cjs:45)
- Linux: keyring probe tier http-server.cjs:126

## 6. Data under DH
- memory.db DH (data-home.cjs:51; memory/service.mjs:73) ; env SCHEHERAZADE_MEMORY_DB override
- journals/dreams/logs/session_notes/.review: onboarding/harness-render.cjs:1730, hooks/session-start.mjs:22 (MEM)
- logs/app.log: main.cjs log-buffer sink DH/logs
- model-catalog-cache.json: model-discovery.cjs:45 DH
- schedules.json: channel-runtime.mjs:681, hooks/session-start.mjs:44 DH
- ALL under DH. Outside DH: ~/.claude*, ~/.codex*, keychain, userData, os.tmpdir, ~/.chromux (below)

## 7. Install dir / chromux / temp
- chromux synced to DH/bin/chromux-portable harness-render.cjs:1619; launchers DH/bin :1641 (DH)
- BUT vendor/chromux/chromux.mjs:27 CHROMUX_HOME = env||~/.chromux (HC global); :28 PROFILES_DIR=$HOME/profiles; :230 profileDir(name)=PROFILES_DIR/name; :229 RUN_DIR; :44 live.json; no app code sets CHROMUX_HOME (grep) -> chromux Chrome profiles/ports/run state SHARED across Sera instances
- chromux live gate onboarding/chromux-live-gate.cjs:20 sets CHROMUX_PROFILE=live
- onboarding/bootstrap.cjs:55 managed install under DH/bin (DH)
- dsh lane home DH/.dsh-lane-home (see 4)
- temp: os.tmpdir()/agent-portable-<AGENT_NAME>* (see 4); no /tmp/scheherazade* literal

## 8. Updater / installer
- updater.cjs:72-78 electron-updater autoDownload, autoInstallOnAppQuit; :102 quitAndInstall() after user prompt; quits THE process (before-quit tears down its own supervisor tree); other instances not restarted
- package.json:235-239 publish github CHOAM-CO/scheherazade-releases
- NSIS: package.json:212 target nsis x64, no "nsis" block (oneClick default true, per-user default install), artifactName :218; no perMachine/protocols entries
- CLI args: none read. grep process.argv / app.commandLine in main.cjs, updater.cjs = no hits (main.cjs:620 'commandLine' is a ps var). Adding --profile needs new parse before :48.
- app update replaces app files shared by all profiles (single install)

## 9. Settings UI / rename lock
- DISPLAY_NAME: onboarding/routes/settings.cjs:276 writeAgentConfig({DISPLAY_NAME}); onboarding/routes/onboarding-meta.cjs:572 (onboarding); http-server.cjs:166-173 comment
- AGENT_NAME: http-server.cjs:162 const 'scheherazade'; :962 written into .agent-config; :1759 process.env.AGENT_NAME default
- Lock text: data-home.cjs:15-19; docs/HISTORY.md:14 (§DATA_HOME); decisions.log NOT in this repo (ls: absent)

## 10. Tests (names)
- test-data-home.mjs, test-credential-store.mjs, test-credential-guard.mjs, test-supervisor.mjs, test-liveness-marker.mjs, test-channel-runtime.mjs, test-harness-refresh.mjs, test-model-discovery.mjs, test-lane-providers.mjs, test-memory-at-rest.mjs, test-memory-routes-e2e.mjs, test-multi-channel.mjs, test-local-channel.mjs, test-companion-routes.mjs, test-companion-settings.mjs, test-agent-status-read.mjs, test-agent-usage-route.mjs (all reference AGENT_DATA_HOME/resolveDataHome)
- No test names single-instance lock/pidfile in main.cjs (main.cjs:3098-3110 exports AGENT_PIDFILE for harness)
