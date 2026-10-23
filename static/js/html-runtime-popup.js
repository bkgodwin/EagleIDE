(function(){
  const channelId = document.body.dataset.runtimeChannel;
  const channelName = "eagle-html-runtime-" + channelId;
  const frame = document.getElementById("runtimeFrame");
  const empty = document.getElementById("runtimeEmpty");
  const msgEl = document.getElementById("runtimeMsg");
  const titleEl = document.getElementById("runtimeTitle");
  let runtimeId = "";
  let timeoutHandle = null;
  let stopped = false;
  let channel = null;

  const setMsg = (text) => { if (msgEl) msgEl.textContent = text || ""; };
  const send = (payload) => {
    try { if (channel) channel.postMessage(payload); } catch {}
  };
  const sendLog = (level, message) => {
    send({ type: "eagle-html-runtime-log", level, message });
  };
  const cleanupRuntime = () => {
    if (!runtimeId) return;
    try {
      navigator.sendBeacon("/api/html-runtime/cleanup", new Blob([JSON.stringify({ runtime_id: runtimeId })], { type: "application/json" }));
    } catch {
      fetch("/api/html-runtime/cleanup", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ runtime_id: runtimeId }) }).catch(() => {});
    }
  };
  const terminate = (reason, cleanup = true) => {
    if (stopped) return;
    stopped = true;
    if (timeoutHandle) clearTimeout(timeoutHandle);
    frame.src = "about:blank";
    frame.style.display = "none";
    empty.style.display = "grid";
    empty.textContent = reason || "Execution stopped.";
    setMsg(reason || "Execution stopped.");
    sendLog("warn", reason || "Execution stopped.");
    if (cleanup) cleanupRuntime();
  };
  const loadRuntime = (runtime) => {
    if (!runtime || !runtime.runtime_id || !runtime.view_url) {
      terminate("Invalid HTML runtime response.", false);
      return;
    }
    stopped = false;
    runtimeId = String(runtime.runtime_id);
    const timeoutSeconds = Number(runtime.timeout_seconds || 30);
    const sandboxFlags = ["allow-scripts"];
    if (runtime.allow_popups) sandboxFlags.push("allow-popups");
    frame.setAttribute("sandbox", sandboxFlags.join(" "));
    if (titleEl) titleEl.textContent = runtime.title || "HTML WebView";
    empty.style.display = "none";
    frame.style.display = "block";
    setMsg("Running...");
    timeoutHandle = setTimeout(() => terminate("Execution time limit reached."), Math.max(1000, Math.floor(timeoutSeconds * 1000)));
    frame.src = runtime.view_url;
  };

  if ("BroadcastChannel" in window) {
    channel = new BroadcastChannel(channelName);
    channel.onmessage = (event) => {
      const data = event.data || {};
      if (data.type === "load") {
        loadRuntime(data.runtime || {});
      } else if (data.type === "stop") {
        terminate(data.reason || "Execution stopped.");
      } else if (data.type === "error") {
        terminate(data.message || "Could not start HTML runtime.", false);
      }
    };
    send({ type: "ready" });
  } else {
    empty.textContent = "This browser does not support isolated HTML previews.";
    setMsg("BroadcastChannel unavailable.");
  }

  window.addEventListener("message", (event) => {
    if (event.source !== frame.contentWindow) return;
    const data = event.data || {};
    if (!data.__eagleHtmlRuntime) return;
    if (data.type === "limit") {
      terminate(data.message || "Execution time limit reached.");
    } else if (data.type === "error") {
      sendLog("error", data.message || "JavaScript runtime error");
    } else if (data.type === "console" && data.level === "error") {
      sendLog("error", data.message || "console.error");
    } else if (data.type === "status") {
      sendLog("warn", data.message || "Runtime status");
    }
  });
  frame.addEventListener("load", () => {
    if (!stopped && runtimeId) setMsg("Running...");
  });
  frame.addEventListener("error", () => terminate("Execution stopped due to iframe load error."));
  document.getElementById("runtimeExitBtn").addEventListener("click", () => {
    cleanupRuntime();
    window.close();
  });
  window.addEventListener("beforeunload", () => {
    cleanupRuntime();
    send({ type: "closed", runtime_id: runtimeId });
    try { if (channel) channel.close(); } catch {}
  });
})();
