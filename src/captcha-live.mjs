import { WebSocket, WebSocketServer } from "ws";

const MAX_FRAME_BYTES = 256 * 1024;
const FRAME_INTERVAL = 125;
const fail = (message, status = 409) =>
  Object.assign(new Error(message), { status });

// CDP stays on the server. The transport receives only bounded JPEG pixels;
// human inputs go through the existing allowlisted Playwright input handler.
export async function startBrowserScreencast({
  page,
  context,
  validate,
  onFrame,
  onClose = () => {},
  clock = () => Date.now(),
}) {
  let cdp,
    closed = false,
    busy = false,
    lastFrameAt = -Infinity;
  let closing,
    snapshot,
    refreshTimer,
    lastSnapshotAt = -Infinity;
  const valid = () => !closed && validate() === true;
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(refreshTimer);
    clearTimeout(snapshot?.deadline);
    clearTimeout(snapshot?.retry);
    snapshot?.resumeRetry?.();
    closing = (async () => {
      page.off?.("framenavigated", navigated);
      page.off?.("close", pageClosed);
      cdp?.off("Page.screencastFrame", frame);
      try {
        await cdp?.send("Page.stopScreencast");
      } catch {}
      try {
        await cdp?.detach();
      } catch {}
      try {
        await onClose();
      } catch {}
    })();
    return closing;
  };
  const navigated = () => {
    if (!valid()) void close();
  };
  const pageClosed = () => {
    void close();
  };
  const publish = async (bytes) => {
    if (!valid() || busy || clock() - lastFrameAt < FRAME_INTERVAL) return;
    busy = true;
    lastFrameAt = clock();
    try {
      if (valid()) await onFrame(bytes);
    } catch {
      await close();
    } finally {
      busy = false;
    }
  };
  const captureSnapshot = () => {
    if (
      !valid() ||
      busy ||
      snapshot ||
      clock() - Math.max(lastFrameAt, lastSnapshotAt) < 4000
    )
      return;
    const capture = { expired: false, previousFrameAt: lastFrameAt };
    snapshot = capture;
    lastSnapshotAt = clock();
    capture.deadline = setTimeout(() => {
      capture.expired = true;
    }, 2500);
    capture.deadline.unref?.();
    void (async () => {
      try {
        for (let attempt = 0; attempt < 2; attempt++) {
          if (
            !valid() ||
            capture.expired ||
            lastFrameAt !== capture.previousFrameAt
          )
            break;
          let result;
          try {
            result = await cdp.send("Page.captureScreenshot", {
              format: "jpeg",
              quality: 60,
              fromSurface: true,
              captureBeyondViewport: false,
            });
          } catch {
            if (attempt || !valid() || capture.expired) break;
            // A new headless compositor can reject its first screenshot before
            // its surface exists. One delayed retry allows the first paint.
            await new Promise((resolve) => {
              capture.resumeRetry = resolve;
              capture.retry = setTimeout(resolve, 125);
              capture.retry.unref?.();
            });
            continue;
          }
          if (
            capture.expired ||
            !valid() ||
            lastFrameAt !== capture.previousFrameAt ||
            typeof result?.data !== "string" ||
            result.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4
          )
            break;
          const bytes = Buffer.from(result.data, "base64");
          if (bytes.length && bytes.length <= MAX_FRAME_BYTES)
            await publish(bytes);
          break;
        }
      } finally {
        clearTimeout(capture.deadline);
        clearTimeout(capture.retry);
        if (snapshot === capture) snapshot = null;
      }
    })().catch(() => {});
  };
  const frame = (event) => {
    // Chromium must be acknowledged before slow receivers or frame decoding.
    void cdp
      .send("Page.screencastFrameAck", { sessionId: event.sessionId })
      .catch(() => close());
    if (closed || busy || clock() - lastFrameAt < FRAME_INTERVAL) return;
    if (!valid()) {
      void close();
      return;
    }
    if (
      typeof event.data !== "string" ||
      event.data.length > Math.ceil(MAX_FRAME_BYTES / 3) * 4
    )
      return;
    const bytes = Buffer.from(event.data, "base64");
    if (!bytes.length || bytes.length > MAX_FRAME_BYTES) return;
    void publish(bytes);
  };
  try {
    if (typeof onFrame !== "function" || !valid()) throw Error();
    cdp = await context.newCDPSession(page);
    if (!valid()) throw Error();
    cdp.on("Page.screencastFrame", frame);
    page.on?.("framenavigated", navigated);
    page.on?.("close", pageClosed);
    await cdp.send("Page.startScreencast", {
      format: "jpeg",
      quality: 60,
      maxWidth: 1280,
      maxHeight: 900,
      everyNthFrame: 2,
    });
    if (!valid()) throw Error();
    // A static page can emit only one compositor frame. everyNthFrame: 2
    // therefore needs a background snapshot for its initial display.
    // Use private CDP directly: Playwright screenshots wait for stable fonts,
    // which can stall Linux pages. The bounded read never holds the input lane.
    captureSnapshot();
    refreshTimer = setInterval(() => {
      if (!valid()) void close();
      else captureSnapshot();
    }, 1000);
    refreshTimer.unref?.();
    return { width: 1280, height: 900, close, validate: valid };
  } catch {
    await close();
    throw fail("브라우저 실시간 화면 연결을 준비하지 못했습니다.", 503);
  }
}

function inputMessage(bytes, binary) {
  if (binary || bytes.length > 8192) throw Error();
  const message = JSON.parse(String(bytes));
  if (
    !message ||
    typeof message !== "object" ||
    Array.isArray(message) ||
    Object.keys(message).some((key) => !["type", "id", "data"].includes(key)) ||
    message.type !== "input" ||
    !(
      (Number.isSafeInteger(message.id) && message.id >= 0) ||
      (typeof message.id === "string" && /^[\w-]{1,64}$/.test(message.id))
    ) ||
    !message.data ||
    typeof message.data !== "object" ||
    Array.isArray(message.data)
  )
    throw Error();
  return message;
}

// Cookie and exact Origin callbacks use the parent server's administrator
// session. Recheck on every input/frame, including after queued operations.
export function createCaptchaLiveUpgrade({
  captchaSession,
  isAuthenticated,
  isAllowedOrigin,
}) {
  const server = new WebSocketServer({
    noServer: true,
    maxPayload: 8192,
    perMessageDeflate: false,
  });
  let disposed = false;
  const authorized = async (request) => {
    try {
      return (
        (await isAuthenticated(request)) === true &&
        (await isAllowedOrigin(request)) === true
      );
    } catch {
      return false;
    }
  };
  const reject = (socket, status) => {
    socket.end(
      `HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
  };
  server.on("connection", (socket, request) => {
    let lease,
      initialFrame,
      ended = false,
      pending = 0,
      sequence = Promise.resolve(),
      timer;
    let rateAt = Date.now(),
      rateCount = 0;
    const ids = new Set();
    const cleanup = () => {
      if (ended) return;
      ended = true;
      initialFrame = null;
      clearInterval(timer);
      void lease?.close().catch(() => {});
    };
    const terminate = () => {
      cleanup();
      if (socket.readyState === WebSocket.OPEN)
        socket.close(1008, "Session unavailable");
    };
    const send = (data) => {
      if (!ended && socket.readyState === WebSocket.OPEN)
        socket.send(JSON.stringify(data));
    };
    const guard = async () =>
      !ended && (await authorized(request)) && lease?.validate() === true;
    socket.on("close", cleanup);
    socket.on("error", cleanup);
    socket.on("message", (bytes, binary) => {
      let message;
      try {
        message = inputMessage(bytes, binary);
        if (Date.now() - rateAt >= 1000) {
          rateAt = Date.now();
          rateCount = 0;
        }
        if (!lease || ids.has(message.id) || pending >= 16 || ++rateCount > 120)
          throw Error();
      } catch {
        terminate();
        return;
      }
      ids.add(message.id);
      if (ids.size > 64) ids.delete(ids.values().next().value);
      pending++;
      sequence = sequence
        .catch(() => {})
        .then(async () => {
          if (!(await guard())) {
            terminate();
            return;
          }
          try {
            await captchaSession.input(message.data);
            if (!(await guard())) {
              terminate();
              return;
            }
            send({ type: "ack", id: message.id, ok: true });
          } catch {
            if (!(await guard())) {
              terminate();
              return;
            }
            send({
              type: "ack",
              id: message.id,
              ok: false,
              error: "화면 입력을 완료하지 못했습니다.",
            });
          }
        })
        .catch(terminate)
        .finally(() => {
          pending--;
        });
    });
    void (async () => {
      try {
        if (!(await authorized(request))) {
          terminate();
          return;
        }
        lease = await captchaSession.live({
          onClose: terminate,
          onFrame: async (bytes) => {
            if (ended) return;
            if (!lease) {
              if (Buffer.isBuffer(bytes) && bytes.length <= MAX_FRAME_BYTES)
                initialFrame = bytes;
              return;
            }
            if (!(await guard())) {
              terminate();
              return;
            }
            if (
              !Buffer.isBuffer(bytes) ||
              bytes.length > MAX_FRAME_BYTES ||
              socket.bufferedAmount > MAX_FRAME_BYTES ||
              socket.readyState !== WebSocket.OPEN
            )
              return;
            socket.send(bytes, { binary: true });
          },
        });
        if (!(await guard())) {
          await lease.close();
          terminate();
          return;
        }
        send({ type: "ready", width: lease.width, height: lease.height });
        if (initialFrame && (await guard()))
          socket.send(initialFrame, { binary: true });
        initialFrame = null;
        timer = setInterval(() => {
          void guard()
            .then((ok) => {
              if (!ok) terminate();
            })
            .catch(terminate);
        }, 1000);
        timer.unref?.();
      } catch {
        terminate();
      }
    })();
  });
  const upgrade = (request, socket, head) => {
    void (async () => {
      let url;
      try {
        url = new URL(request.url, "http://localhost");
      } catch {
        reject(socket, 400);
        return;
      }
      if (
        disposed ||
        url.pathname !== "/api/captcha-session/live" ||
        url.search
      ) {
        reject(socket, 400);
        return;
      }
      let authenticated = false,
        allowed = false;
      try {
        authenticated = (await isAuthenticated(request)) === true;
        allowed = (await isAllowedOrigin(request)) === true;
      } catch {}
      if (!authenticated || !allowed) {
        reject(socket, authenticated ? 403 : 401);
        return;
      }
      if (socket.destroyed) return;
      server.handleUpgrade(request, socket, head, (ws) =>
        server.emit("connection", ws, request),
      );
    })().catch(() => reject(socket, 400));
  };
  upgrade.dispose = () => {
    disposed = true;
    for (const socket of server.clients) socket.terminate();
    server.close();
  };
  return upgrade;
}
