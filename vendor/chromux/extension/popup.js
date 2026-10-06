// Popup: connection status, attached tabs, and the kill switch.

const dot = document.getElementById("dot");
const statusText = document.getElementById("statusText");
const portText = document.getElementById("portText");
const tabsEl = document.getElementById("tabs");
const emptyState = document.getElementById("emptyState");
const attachedLabel = document.getElementById("attachedLabel");
const killBtn = document.getElementById("killBtn");
const enableBtn = document.getElementById("enableBtn");

function render(status) {
  const connected = status.connected;
  const enabled = status.enabled;
  dot.className = "dot " + (connected ? "on" : enabled ? "" : "off");
  if (connected) statusText.textContent = "Connected";
  else if (enabled) statusText.textContent = "Waiting for chromux…";
  else statusText.textContent = "Disconnected (kill switch)";
  portText.textContent = status.port ? `port ${status.port}` : "";

  killBtn.hidden = !enabled;
  enableBtn.hidden = enabled;

  const tabs = status.attachedTabs || [];
  tabsEl.innerHTML = "";
  attachedLabel.hidden = tabs.length === 0;
  emptyState.hidden = tabs.length !== 0;
  for (const tab of tabs) {
    const li = document.createElement("li");
    const t = document.createElement("div");
    t.className = "t";
    t.textContent = tab.title || "(untitled)";
    const u = document.createElement("div");
    u.className = "u";
    u.textContent = tab.url || "";
    li.appendChild(t);
    li.appendChild(u);
    tabsEl.appendChild(li);
  }
}

function refresh() {
  chrome.runtime.sendMessage({ type: "status" }, (status) => {
    if (chrome.runtime.lastError || !status) {
      statusText.textContent = "Service worker asleep — retrying…";
      return;
    }
    render(status);
  });
}

killBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "kill" }, refresh);
});
enableBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "enable" }, refresh);
});

refresh();
setInterval(refresh, 1500);
