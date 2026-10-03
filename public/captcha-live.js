"use strict";
(() => {
  let standaloneOpened = false;
  function showTestConnection() {
    const label = document.getElementById("captcha-session-network");
    if (!label) return;
    const network = window.CollectorUI?.status?.()?.testConnection;
    label.textContent = network?.active
      ? "테스트 경로 · SpoofDPI (IP 그대로)"
      : "기본 연결";
  }
  document.addEventListener("collector:status", showTestConnection);
  showTestConnection();
  function standalone({ authenticated, sites, open }) {
    if (!authenticated) {
      standaloneOpened = false;
      return;
    }
    if (
      standaloneOpened ||
      new URLSearchParams(location.search).get("captcha") !== "1"
    )
      return;
    const site = sites.find((item) => item.held !== false);
    if (!site) return;
    standaloneOpened = true;
    document.body.classList.add("captcha-standalone");
    open(site.host);
  }
  function connect({ current, onReady, onFrame, onFallback }) {
    const pending = new Map();
    let socket,
      stopped = false,
      established = false,
      sequence = 0,
      startup,
      frameDeadline,
      rendering = false,
      queuedFrame = null;
    const uncertain = () =>
      Object.assign(
        new Error(
          "입력 처리 확인이 끊겼습니다. 화면을 확인한 뒤 다시 조작하세요.",
        ),
        { unconfirmed: true },
      );
    function end(notify = false, reason = null) {
      if (stopped) return;
      stopped = true;
      established = false;
      clearTimeout(startup);
      clearTimeout(frameDeadline);
      for (const task of pending.values()) {
        clearTimeout(task.timer);
        task.reject(uncertain());
      }
      pending.clear();
      queuedFrame = null;
      try {
        socket?.close();
      } catch {
        /* Already disconnected. */
      }
      if (notify && current()) onFallback?.(reason);
    }
    function valid() {
      return !stopped && current();
    }
    function image(data) {
      const size = data?.byteLength ?? data?.size;
      if (!(size > 0 && size <= 4 * 1024 * 1024)) {
        end(true);
        return;
      }
      clearTimeout(frameDeadline);
      frameDeadline = setTimeout(() => end(true), 8000);
      const blob = new Blob([data], { type: "image/jpeg" });
      if (rendering) {
        queuedFrame = blob;
        return;
      }
      render(blob);
    }
    function render(blob) {
      if (!valid()) return;
      rendering = true;
      Promise.resolve(onFrame?.(blob))
        .catch(() => end(true))
        .finally(() => {
          rendering = false;
          const latest = queuedFrame;
          queuedFrame = null;
          if (latest && valid()) render(latest);
        });
    }
    function message(event) {
      if (!valid()) return;
      if (typeof event.data !== "string") {
        if (established) image(event.data);
        return;
      }
      if (event.data.length > 4096) {
        end(true);
        return;
      }
      let data;
      try {
        data = JSON.parse(event.data);
      } catch {
        end(true);
        return;
      }
      if (data?.type === "ready") {
        if (
          ![data.width, data.height].every(
            (value) =>
              Number.isSafeInteger(value) && value > 0 && value <= 8192,
          )
        ) {
          end(true);
          return;
        }
        if (established) return;
        clearTimeout(startup);
        frameDeadline = setTimeout(() => end(true), 3000);
        established = true;
        onReady?.({ width: data.width, height: data.height });
      } else if (data?.type === "ack" && Number.isSafeInteger(data.id)) {
        const task = pending.get(data.id);
        if (!task) return;
        pending.delete(data.id);
        clearTimeout(task.timer);
        if (data.ok === true) task.resolve();
        else
          task.reject(
            new Error(
              typeof data.error === "string"
                ? data.error.slice(0, 500)
                : "서버 입력을 처리하지 못했습니다.",
            ),
          );
      } else if (data?.type === "error") end(true);
    }
    const api = {
      ready: () => valid() && established && socket?.readyState === 1,
      input(data) {
        if (!api.ready())
          return Promise.reject(new Error("실시간 화면 연결을 확인하세요."));
        const id = ++sequence;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => end(true, uncertain()), 6000);
          pending.set(id, { resolve, reject, timer });
          try {
            socket.send(JSON.stringify({ type: "input", id, data }));
          } catch {
            end(true, uncertain());
          }
        });
      },
      close: () => end(),
    };
    if (typeof WebSocket !== "function") {
      setTimeout(() => end(true), 0);
      return api;
    }
    try {
      const url = new URL("/api/captcha-session/live", location.href);
      url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
      socket = new WebSocket(url.href);
      socket.binaryType = "arraybuffer";
      socket.addEventListener("message", message);
      socket.addEventListener("error", () => end(true));
      socket.addEventListener("close", () => end(true));
      startup = setTimeout(() => end(true), 2500);
    } catch {
      setTimeout(() => end(true), 0);
    }
    return api;
  }
  window.CaptchaLiveStream = { connect, standalone };
})();
