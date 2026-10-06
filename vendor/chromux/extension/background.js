// chromux live bridge — MV3 service worker.
//
// Connects to the local chromux live daemon's facade over a loopback
// WebSocket and relays chrome.debugger CDP traffic for the user's real tabs.
// There is no pairing token: the bridge only accepts local, non-web-origin
// connections, and this worker's chrome-extension:// Origin is its identity.
// The facade speaks a small JSON envelope protocol (op/result for calls,
// event for pushes) so the Node side never needs a CDP client for live tabs.
//
// Lifecycle notes: MV3 workers are killed when idle. We keep the socket warm
// with a periodic ping and an alarm-driven reconnect loop, and persist the
// kill-switch state so a disabled bridge stays disabled across worker
// restarts.

const CDP_VERSION = "1.3";
const PING_MS = 20000;
const RECONNECT_MS = 3000;

let ws = null;
let connecting = false;
let pingTimer = null;
// tabId -> true for tabs we currently hold a debugger session on.
const attached = new Map();

async function getConfig() {
  const cfg = await chrome.storage.local.get(["port", "enabled"]);
  return {
    port: cfg.port || 47700,
    enabled: cfg.enabled !== false,
  };
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

function reply(id, result) {
  send({ id, ok: true, result: result ?? {} });
}

function replyError(id, message) {
  send({ id, ok: false, error: String(message) });
}

function emit(event, extra) {
  send({ event, ...extra });
}

function tabSummary(tab) {
  if (!tab) return null;
  return {
    id: tab.id,
    url: tab.url || tab.pendingUrl || "",
    title: tab.title || "",
    active: !!tab.active,
    openerTabId: typeof tab.openerTabId === "number" ? tab.openerTabId : null,
  };
}


// Poll a tab until it finishes loading the requested document. Requires both
// status "complete" and a URL that matches the request (a fresh tab reports a
// transient "complete" on its empty initial document first). about:blank
// requests only need status complete. Runs inside one message handler's await.
async function waitTabLoaded(tabId, wantUrl, timeoutMs) {
  const wantBlank = !wantUrl || wantUrl === "about:blank";
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const urlOk = wantBlank ? true : (tab.url && tab.url !== "about:blank");
    if (tab.status === "complete" && urlOk) return;
    await new Promise((r) => setTimeout(r, 80));
  }
}

// Wait until the debugger's evaluated location.href matches the tab's real
// URL, so callers never read a stale about:blank context after a navigation.
async function reconcileDebuggerContext(tabId, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let reattached = false;
  while (Date.now() < deadline) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch { return; }
    const tabUrl = tab.url || "";
    // Empty URL means the tab is still committing a navigation — keep waiting.
    if (!tabUrl) { await new Promise((r) => setTimeout(r, 100)); continue; }
    // A genuinely blank tab needs no reconciliation.
    if (tabUrl === "about:blank") return;
    let dbgUrl = "";
    try {
      const e = await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", { expression: "location.href", returnByValue: true });
      dbgUrl = e?.result?.value || "";
    } catch { return; }
    if (dbgUrl === tabUrl) return;
    // The debugger is stuck on a stale context (reads a different URL than the
    // committed page). Once the page is settled, detach and reattach once to
    // bind the debugger session to the current document's context.
    if (!reattached && tab.status === "complete" && dbgUrl !== tabUrl) {
      reattached = true;
      try {
        await chrome.debugger.detach({ tabId });
        await chrome.debugger.attach({ tabId }, CDP_VERSION);
        await chrome.debugger.sendCommand({ tabId }, "Runtime.enable", {});
      } catch { return; }
      continue;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
}

// Visual "an agent is driving this tab" badge: while attached, the tab sits in
// a green "chromux" tab group so the tab strip shows who is being controlled.
// Feature-detected because not every Chromium-based browser exposes tab-group
// APIs (or renders the group UI); those browsers just skip the badge — the
// badge is best-effort and must never fail or delay an attach/detach.
const BADGE_GROUP_TITLE = "chromux";
const BADGE_GROUP_COLOR = "green";
// tabId -> groupId the tab was in before we badged it, so detach can restore
// the user's own grouping instead of just ungrouping.
const priorGroup = new Map();

function tabGroupsSupported() {
  return !!(chrome.tabs && chrome.tabs.group && chrome.tabs.ungroup &&
    chrome.tabGroups && chrome.tabGroups.query && chrome.tabGroups.update);
}

function noGroupId() {
  return (chrome.tabGroups && chrome.tabGroups.TAB_GROUP_ID_NONE) ?? -1;
}

// Groups are per-window; reuse this window's chromux group when one exists so
// multiple attached tabs share a single badge chip.
async function findBadgeGroup(windowId) {
  const groups = await chrome.tabGroups.query({ windowId, title: BADGE_GROUP_TITLE });
  return groups && groups[0] ? groups[0].id : null;
}

async function badgeTab(tabId) {
  if (!tabGroupsSupported()) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    const existing = await findBadgeGroup(tab.windowId);
    if (existing != null && tab.groupId === existing) return;
    if (!priorGroup.has(tabId)) priorGroup.set(tabId, tab.groupId ?? noGroupId());
    if (existing != null) {
      await chrome.tabs.group({ tabIds: [tabId], groupId: existing });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tabId] });
      await chrome.tabGroups.update(groupId, { title: BADGE_GROUP_TITLE, color: BADGE_GROUP_COLOR });
    }
  } catch {
    // Tab gone, group APIs rejected mid-drag, etc. — the attach still stands.
  }
}

async function unbadgeTab(tabId) {
  const prev = priorGroup.get(tabId);
  priorGroup.delete(tabId);
  if (!tabGroupsSupported()) return;
  try {
    const tab = await chrome.tabs.get(tabId);
    if (tab.groupId === noGroupId()) return;
    // Only undo our own badge: if the user moved the tab into another group
    // while it was attached, respect that and leave it there.
    const badgeGroup = await findBadgeGroup(tab.windowId);
    if (badgeGroup == null || tab.groupId !== badgeGroup) return;
    if (prev != null && prev !== noGroupId()) {
      try {
        await chrome.tabs.group({ tabIds: [tabId], groupId: prev });
        return;
      } catch {
        // Original group vanished (or lives in another window) — fall through.
      }
    }
    await chrome.tabs.ungroup(tabId);
  } catch {
    // Tab already closed.
  }
}

async function detachTab(tabId) {
  if (!attached.has(tabId)) return;
  attached.delete(tabId);
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // Already gone (tab closed, navigated to a restricted page, etc.).
  }
  await unbadgeTab(tabId);
}

async function detachAll() {
  const ids = [...attached.keys()];
  for (const tabId of ids) await detachTab(tabId);
}

async function handleCall(msg) {
  const { id, op } = msg;
  try {
    switch (op) {
      case "tabs.query": {
        const tabs = await chrome.tabs.query({});
        reply(id, tabs.map(tabSummary));
        break;
      }
      case "tabs.create": {
        const wantUrl = msg.url || "about:blank";
        const tab = await chrome.tabs.create({ url: wantUrl, active: msg.active !== false });
        // Wait for the requested document to actually load before the caller
        // attaches the debugger. A freshly created tab briefly reports
        // "complete" on its empty initial document before the real navigation
        // begins, so also require the URL to match the request.
        await waitTabLoaded(tab.id, wantUrl, 15000);
        let settled = tab;
        try { settled = await chrome.tabs.get(tab.id); } catch {}
        reply(id, tabSummary(settled));
        break;
      }
      case "tabs.remove": {
        await chrome.tabs.remove(msg.tabId);
        reply(id, { removed: true });
        break;
      }
      case "debugger.attach": {
        if (!attached.has(msg.tabId)) {
          await chrome.debugger.attach({ tabId: msg.tabId }, CDP_VERSION);
          attached.set(msg.tabId, true);
          // Enable Runtime so evaluate targets the page's *current* default
          // execution context. Without it, chrome.debugger evaluates against a
          // stale context after navigation (reads about:blank). Stealth is
          // irrelevant here: this is the user's own browser they connected.
          try { await chrome.debugger.sendCommand({ tabId: msg.tabId }, "Runtime.enable", {}); } catch {}
        }
        // A freshly navigated tab can briefly expose a stale about:blank
        // execution context to the debugger while the real document commits.
        // Don't report attached until the debugger's own location.href agrees
        // with the tab's committed URL, so the first evaluate reads the page.
        await reconcileDebuggerContext(msg.tabId, 8000);
        await badgeTab(msg.tabId);
        reply(id, { attached: true });
        break;
      }
      case "debugger.detach": {
        await detachTab(msg.tabId);
        reply(id, { detached: true });
        break;
      }
      case "debugger.send": {
        const target = { tabId: msg.tabId };
        if (msg.sessionId) target.sessionId = msg.sessionId;
        const result = await chrome.debugger.sendCommand(target, msg.method, msg.params || {});
        reply(id, result ?? {});
        break;
      }
      case "tabs.navigate": {
        // chrome.tabs.update navigates without the "Detached while handling
        // command" failures chrome.debugger Page.navigate hits on process
        // swaps. The facade (in Node, not subject to MV3 suspension) polls
        // tabs.get for completion and synthesizes the load event.
        const updated = await chrome.tabs.update(msg.tabId, { url: msg.url });
        reply(id, { ok: true, tabId: updated?.id, pendingUrl: updated?.pendingUrl || updated?.url });
        break;
      }
      case "tabs.get": {
        try {
          const tab = await chrome.tabs.get(msg.tabId);
          reply(id, { status: tab.status, url: tab.url || "", title: tab.title || "" });
        } catch {
          reply(id, { status: "gone" });
        }
        break;
      }
      case "detachAll": {
        await detachAll();
        reply(id, { detached: true });
        break;
      }
      default:
        replyError(id, `unknown op: ${op}`);
    }
  } catch (err) {
    replyError(id, err && err.message ? err.message : err);
  }
}

function onDebuggerEvent(source, method, params) {
  if (source.tabId == null || !attached.has(source.tabId)) return;
  emit("cdp", {
    tabId: source.tabId,
    method,
    params,
    ...(source.sessionId ? { sessionId: source.sessionId } : {}),
  });
}

function onDebuggerDetach(source, reason) {
  if (source.tabId == null) return;
  if (attached.has(source.tabId)) {
    attached.delete(source.tabId);
    emit("detached", { tabId: source.tabId, reason });
    unbadgeTab(source.tabId);
  }
}

async function connect() {
  if (connecting || (ws && ws.readyState === WebSocket.OPEN)) return;
  const cfg = await getConfig();
  if (!cfg.enabled) return;
  connecting = true;
  try {
    const socket = new WebSocket(`ws://127.0.0.1:${cfg.port}/relay`);
    ws = socket;
    socket.addEventListener("open", () => {
      connecting = false;
      chrome.action.setBadgeText({ text: "on" });
      chrome.action.setBadgeBackgroundColor({ color: "#1a7f37" });
      if (pingTimer) clearInterval(pingTimer);
      pingTimer = setInterval(() => {
        if (!send({ event: "ping" })) {
          clearInterval(pingTimer);
          pingTimer = null;
        }
      }, PING_MS);
    });
    socket.addEventListener("message", (ev) => {
      let msg;
      try { msg = JSON.parse(ev.data); } catch { return; }
      if (msg.op) handleCall(msg);
    });
    const onClose = () => {
      connecting = false;
      if (ws === socket) ws = null;
      chrome.action.setBadgeText({ text: "" });
      if (pingTimer) { clearInterval(pingTimer); pingTimer = null; }
      scheduleReconnect();
    };
    socket.addEventListener("close", onClose);
    socket.addEventListener("error", onClose);
  } catch {
    connecting = false;
    ws = null;
    scheduleReconnect();
  }
}

let reconnectTimer = null;
function scheduleReconnect() {
  if (reconnectTimer) return;
  reconnectTimer = setTimeout(async () => {
    reconnectTimer = null;
    const cfg = await getConfig();
    if (cfg.enabled && !(ws && ws.readyState === WebSocket.OPEN)) connect();
  }, RECONNECT_MS);
}

// Relay tab lifecycle so the facade's popup-adoption and target list stay live.
chrome.tabs.onCreated.addListener((tab) => emit("tabCreated", { tab: tabSummary(tab) }));
chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (changeInfo.url || changeInfo.title || changeInfo.status === "complete") {
    emit("tabUpdated", { tab: tabSummary(tab) });
  }
});
chrome.tabs.onRemoved.addListener((tabId) => {
  attached.delete(tabId);
  priorGroup.delete(tabId);
  emit("tabRemoved", { tabId });
});

chrome.debugger.onEvent.addListener(onDebuggerEvent);
chrome.debugger.onDetach.addListener(onDebuggerDetach);

chrome.downloads.onCreated.addListener((item) => emit("download", { phase: "created", item }));
chrome.downloads.onChanged.addListener((delta) => emit("download", { phase: "changed", id: delta.id, delta }));

// Keep-alive: MV3 workers sleep when idle. An alarm wakes the worker to
// re-check the connection; the socket itself keeps the worker alive while open.
chrome.alarms.create("chromux-keepalive", { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "chromux-keepalive") connect();
});

chrome.runtime.onStartup.addListener(() => connect());
chrome.runtime.onInstalled.addListener(() => connect());

// Re-connect as soon as config changes (port override or re-enable).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.port || (changes.enabled && changes.enabled.newValue)) {
    if (!(changes.enabled && changes.enabled.newValue === false)) connect();
  }
});

// Kill switch: block the bridge until re-enabled. Persisted disable so it
// survives worker restarts; detaches every tab and drops the relay.
async function killSwitch() {
  await chrome.storage.local.set({ enabled: false });
  emit("killswitch", {});
  await detachAll();
  if (ws) { try { ws.close(); } catch {} ws = null; }
  chrome.action.setBadgeText({ text: "" });
}
// Also reachable as self.__chromuxKillSwitch for the live harness, which cannot
// deliver a runtime message to the worker from the worker itself.
self.__chromuxKillSwitch = killSwitch;
// Test hook: simulate a dropped relay (worker restart / network blip). The
// onClose handler schedules a reconnect while still enabled, so the bridge
// should recover on its own.
self.__chromuxDropConnection = () => { if (ws) { try { ws.close(); } catch {} } };

// Popup and storage-driven control.
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === "status") {
      const cfg = await getConfig();
      let tabs = [];
      for (const tabId of attached.keys()) {
        try { tabs.push(tabSummary(await chrome.tabs.get(tabId))); } catch {}
      }
      sendResponse({
        connected: !!ws && ws.readyState === WebSocket.OPEN,
        enabled: cfg.enabled,
        port: cfg.port,
        attachedTabs: tabs,
      });
      return;
    }
    if (msg.type === "kill") {
      await killSwitch();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "enable") {
      await chrome.storage.local.set({ enabled: true });
      await connect();
      sendResponse({ ok: true });
      return;
    }
    if (msg.type === "pair") {
      // Compat name; sets the bridge port override and (re-)enables.
      await chrome.storage.local.set({ port: msg.port || 47700, enabled: true });
      await connect();
      sendResponse({ ok: true });
      return;
    }
    sendResponse({ ok: false, error: "unknown message" });
  })();
  return true;
});

// Reconnect shortly after load in case onStartup did not fire (dev reload).
setTimeout(connect, RECONNECT_MS);
connect();
