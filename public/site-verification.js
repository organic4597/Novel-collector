"use strict";
(() => {
  const UI = window.CollectorUI,
    $ = (id) => document.getElementById(id),
    loginRequests = new Map(),
    viewerOrigins = new Set(["https://sbxh9.com", "https://toki32.com"]);
  let retryTimer = null;
  function node(tag, className, text) {
    const element = document.createElement(tag);
    if (className) element.className = className;
    if (text != null) element.textContent = String(text);
    return element;
  }
  function attention(host) {
    return (UI.status?.().siteAttention || []).find(
      (site) => site.host === host,
    );
  }
  function loginState(site) {
    const request = loginRequests.get(site.host);
    return request && request.generation === UI.generation()
      ? { ...site.autoLogin, ...request.result }
      : site.autoLogin;
  }
  function accountHost(site) {
    const candidate =
      loginState(site)?.accountHost || UI.status?.().source?.host;
    return viewerOrigins.has("https://" + candidate) ? candidate : "sbxh9.com";
  }
  function retryTime(login) {
    return Date.parse(login?.retryAt || login?.retryAtISO || "") || 0;
  }
  function currentError(value, fallback) {
    const text = typeof value === "string" ? value.trim() : "";
    // Old saved holds may still contain instructions for the removed controls.
    return text &&
      !/일일\s*조회\s*인증|브라우저\s*[12]|직접\s*인증|서버\s*브라우저/.test(
        text,
      )
      ? text
      : fallback;
  }
  function bannerMessage(site) {
    const login = loginState(site),
      kind = ["captcha", "site_blocked"].includes(login?.failureKind)
        ? login.failureKind
        : site.kind,
      waiting = ["failed", "needs_attention"].includes(login?.state);
    if (kind === "captcha")
      return {
        heading: waiting ? "CAPTCHA 대기" : "CAPTCHA 확인 중",
        reason: currentError(
          login?.error,
          waiting
            ? "사이트에서 CAPTCHA 확인을 아직 반영하지 않았습니다."
            : "사이트의 응답을 확인하고 있습니다.",
        ),
        instructions:
          "CAPTCHA 풀기로 서버 수집 세션을 열어 확인하세요. 완료 후 적용하면 수집 가능 여부를 확인합니다.",
        captcha: true,
      };
    if (kind === "site_blocked")
      return {
        heading: "사이트 접근 확인 필요",
        reason: "사이트에서 수집 요청을 아직 허용하지 않고 있습니다.",
        instructions:
          "접근 상태를 자동으로 다시 확인합니다. 확인하는 동안 수집 요청은 대기합니다.",
      };
    if (!login?.configured || !login.enabled)
      return {
        heading: "사이트 계정 확인 필요",
        reason: "계정 설정에서 로그인 정보를 확인하세요.",
        instructions:
          "저장된 계정으로 자동 로그인을 진행합니다. 계정 정보를 저장하고 자동 로그인을 활성화하세요.",
        settings: true,
      };
    if (["idle", "waiting", "running"].includes(login.state))
      return {
        heading:
          login.state === "running"
            ? "자동 로그인 진행 중"
            : "자동 로그인 대기 중",
        reason: "저장된 계정으로 사이트 로그인 상태를 확인합니다.",
        instructions: "로그인 상태를 확인하는 동안 수집 요청은 대기합니다.",
      };
    if (login.state === "ready")
      return {
        heading: "로그인 상태 확인 중",
        reason: "사이트에서 수집 가능한지 자동으로 확인하고 있습니다.",
        instructions: "접근 상태를 확인하는 동안 수집 요청은 대기합니다.",
      };
    return {
      heading: "사이트 계정 확인 필요",
      reason: currentError(login.error, "자동 로그인을 완료하지 못했습니다."),
      instructions:
        "계정 설정을 확인하세요. 저장된 계정으로 자동 로그인을 다시 시도할 수 있습니다.",
      settings: true,
      retry: ["authentication", "unknown"].includes(kind),
    };
  }
  function addAction(fragment, site, action, label, callback) {
    const button = node("button", "secondary", label);
    button.type = "button";
    button.dataset.host = site.host;
    button.dataset.action = action;
    button.addEventListener("click", callback);
    fragment.append(button);
    return button;
  }
  async function retryLogin(host) {
    const site = attention(host),
      generation = UI.generation();
    if (
      !UI.authenticated() ||
      !site ||
      site.held === false ||
      loginRequests.get(host)?.pending
    )
      return;
    if (!bannerMessage(site).retry || retryTime(loginState(site)) > Date.now())
      return;
    const request = {
      generation,
      pending: true,
      result: { state: "running", error: null },
    };
    loginRequests.set(host, request);
    renderBanner();
    try {
      const result = await UI.api("/api/site-account/test", {
        method: "POST",
        body: JSON.stringify({ host: accountHost(site) }),
      });
      if (
        !UI.authenticated() ||
        generation !== UI.generation() ||
        loginRequests.get(host) !== request
      )
        return;
      loginRequests.set(host, { generation, pending: false, result });
      UI.refresh?.();
    } catch (exception) {
      if (
        !UI.authenticated() ||
        generation !== UI.generation() ||
        loginRequests.get(host) !== request
      )
        return;
      loginRequests.set(host, {
        generation,
        pending: false,
        result: { state: "failed", error: UI.textError(exception) },
      });
    } finally {
      if (UI.authenticated() && generation === UI.generation()) renderBanner();
    }
  }
  function renderBanner() {
    clearTimeout(retryTimer);
    retryTimer = null;
    const sites = UI.authenticated()
      ? (UI.status?.().siteAttention || []).filter(
          (site) => site.held !== false,
        )
      : [];
    $("site-attention-banner").hidden = !sites.length;
    const messages = sites.map(bannerMessage);
    $("site-attention-heading").textContent = [
      ...new Set(messages.map((message) => message.heading)),
    ].join(" / ");
    $("site-attention-reason").textContent = sites
      .map((site, index) => `${accountHost(site)} · ${messages[index].reason}`)
      .join(" / ");
    $("site-attention-instructions").textContent = [
      ...new Set(messages.map((message) => message.instructions)),
    ].join(" ");
    const fragment = document.createDocumentFragment();
    let nextRetry = Infinity;
    for (const [index, site] of sites.entries()) {
      const message = messages[index],
        prefix = sites.length > 1 ? accountHost(site) + " · " : "";
      if (message.settings)
        addAction(fragment, site, "settings", prefix + "계정 설정", () =>
          $("nav-settings")?.click(),
        );
      if (message.captcha) {
        const active = (UI.status?.().captchaAutomatic || []).some(item => item.active);
        const auto = addAction(fragment, site, "captcha-auto", prefix + (active ? "자동 CAPTCHA 진행 중" : "자동 CAPTCHA 재시도"), () =>
          openCaptcha(site.host, false, true));
        auto.disabled = active;
        if (!active)
        addAction(fragment, site, "captcha", prefix + "CAPTCHA 풀기", () =>
          openCaptcha(site.host),
        );
      }
      if (message.retry) {
        const remaining = retryTime(loginState(site)) - Date.now();
        const button = addAction(
          fragment,
          site,
          "retry",
          prefix + "자동 로그인 다시 시도",
          () => retryLogin(site.host),
        );
        button.disabled =
          remaining > 0 || Boolean(loginRequests.get(site.host)?.pending);
        if (remaining > 0) {
          button.title = "다시 시도할 수 있는 시간을 기다립니다.";
          nextRetry = Math.min(nextRetry, remaining + 10);
        }
      }
    }
    $("site-attention-actions").replaceChildren(fragment);
    if (UI.authenticated() && Number.isFinite(nextRetry))
      retryTimer = setTimeout(renderBanner, Math.min(nextRetry, 60000));
  }
  const dialog = $("captcha-session-dialog"),
    frame = $("captcha-session-frame");
  let session = null,
    sessionEpoch = 0,
    frameTimer = null,
    frameController = null,
    frameUrl = null,
    frameCompletion = null,
    frameAt = 0,
    lastFrameResponse = 0,
    frameRetryDelay = 1000,
    inputChain = Promise.resolve(),
    awaitingInputs = 0,
    inputVersion = 0,
    queuedPointerMove = null,
    lifecycleChain = Promise.resolve(),
    pointer = null,
    pendingMove = null,
    moveTimer = null,
    busy = false,
    automaticTimer = null;
  function isVisible() {
    return UI.authenticated() && dialog.open && !document.hidden;
  }
  function current(epoch) {
    return (
      sessionEpoch === epoch &&
      UI.authenticated() &&
      session?.generation === UI.generation() &&
      dialog.open
    );
  }
  function usable() {
    return (
      isVisible() &&
      session?.open &&
      !busy &&
      frameAt > 0 &&
      Date.now() - frameAt < 10000
    );
  }
  function controls() {
    const enabled = usable();
    $("captcha-session-apply").disabled = !enabled || Boolean(pointer);
    $("captcha-session-send").disabled = !enabled;
    for (const button of dialog.querySelectorAll(
      "[data-captcha-key], [data-captcha-scroll]",
    ))
      button.disabled = !enabled;
    $("captcha-session-viewer").disabled = busy;
    $("captcha-session-retry").disabled = busy || !session?.open || Boolean(pointer) || awaitingInputs > 0;
    dialog.querySelector(".captcha-session-screen").hidden = Boolean(session?.automatic?.active);
    $("captcha-session-text-form").hidden = Boolean(session?.automatic?.active);
    $("captcha-session-large")?.setAttribute(
      "aria-disabled",
      String(busy || Boolean(pointer) || awaitingInputs > 0),
    );
  }
  function error(exception) {
    $("captcha-session-error").textContent = UI.textError(exception);
  }
  function api(action, body) {
    return UI.api(
      "/api/captcha-session/" + action,
      body === undefined
        ? {}
        : {
            method: "POST",
            body: JSON.stringify(body),
          },
      60000,
    );
  }
  function stopFrames() {
    clearTimeout(frameTimer);
    frameTimer = null;
    frameController?.abort();
    frameController = null;
    frameAt = 0;
    frameCompletion?.();
    frameCompletion = null;
    frame.onload = frame.onerror = null;
    frame.removeAttribute("src");
    if (frameUrl) URL.revokeObjectURL(frameUrl);
    frameUrl = null;
    controls();
  }
  function scheduleFrame(epoch) {
    if (!current(epoch) || !isVisible() || !session?.open) return;
    clearTimeout(frameTimer);
    frameTimer = setTimeout(
      () => requestFrame(epoch),
      Math.max(0, frameRetryDelay - (Date.now() - lastFrameResponse)),
    );
  }
  function showFrame(blob, epoch) {
    if (!current(epoch) || !isVisible()) return Promise.resolve();
    frameCompletion?.();
    const url = URL.createObjectURL(blob),
      oldUrl = frameUrl;
    frameUrl = url;
    return new Promise((resolve) => {
      frameCompletion = resolve;
      frame.onload = () => {
        if (current(epoch) && isVisible() && frameUrl === url) {
          frameAt =
            frame.naturalWidth > 0 && frame.naturalHeight > 0 ? Date.now() : 0;
          controls();
        }
        resolve();
      };
      frame.onerror = () => {
        if (current(epoch) && frameUrl === url) {
          frameAt = 0;
          error(new Error("서버 화면을 표시하지 못했습니다. 다시 불러옵니다."));
          controls();
        }
        resolve();
      };
      frame.src = url;
      if (oldUrl) URL.revokeObjectURL(oldUrl);
    });
  }
  function startFrames(epoch) {
    $("captcha-session-transport").textContent = "기본 화면 · HTTP";
    scheduleFrame(epoch);
  }
  function frameRetryAfter(response) {
    const value = response.headers?.get?.("Retry-After")?.trim() || "",
      delay = /^\d+(?:\.\d+)?$/.test(value)
        ? Number(value) * 1000
        : Date.parse(value) - Date.now();
    return Number.isFinite(delay)
      ? Math.max(1000, Math.min(10000, delay))
      : 1000;
  }
  async function requestFrame(epoch) {
    if (!current(epoch) || !isVisible() || !session?.open || frameController)
      return;
    const controller = new AbortController();
    frameController = controller;
    frameRetryDelay = 1000;
    const timeout = setTimeout(() => controller.abort(), 15000);
    try {
      const response = await fetch("/api/captcha-session/frame", {
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (response.status === 429) {
        frameRetryDelay = frameRetryAfter(response);
        return;
      }
      if (!response.ok) {
        if (response.status === 401) closeCaptcha();
        throw new Error(`서버 화면을 불러올 수 없습니다 (${response.status}).`);
      }
      const blob = await response.blob();
      if (!current(epoch) || !isVisible()) return;
      if (!blob.size || !blob.type.startsWith("image/"))
        throw new Error("서버 화면이 올바른 이미지가 아닙니다.");
      showFrame(blob, epoch);
    } catch (exception) {
      if (current(epoch) && exception.name !== "AbortError") {
        frameAt = 0;
        error(exception);
        controls();
      }
    } finally {
      clearTimeout(timeout);
      if (frameController === controller) frameController = null;
      // Network and screenshot time count before the next capture budget starts.
      lastFrameResponse = Date.now();
      scheduleFrame(epoch);
    }
  }
  function cancelPointer() {
    clearTimeout(moveTimer);
    moveTimer = null;
    pendingMove = null;
    const held = pointer;
    pointer = null;
    if (held) {
      try {
        frame.releasePointerCapture(held.id);
      } catch {
        /* Already released. */
      }
    }
  }
  function closeCaptcha() {
    const owned = session;
    sessionEpoch++;
    clearTimeout(automaticTimer);
    busy = false;
    session = null;
    cancelPointer();
    stopFrames();
    $("captcha-session-text").value = "";
    if (dialog.open) dialog.close();
    // Closing follows an in-flight open, so a late response cannot leave an orphan.
    if (owned)
      lifecycleChain = lifecycleChain
        .catch(() => {})
        .then(() => api("close", {}))
        .catch(() => {});
  }
  async function openCaptcha(host, remaining = false, automatic = false) {
    if (!UI.authenticated() || !host || busy) return;
    if (!automatic && (UI.status?.().captchaAutomatic || []).some(item => item.active)) return;
    if (!session) {
      const origin = UI.status?.().source?.origin;
      if (viewerOrigins.has(origin)) $("captcha-session-viewer").value = origin;
    }
    const viewerOrigin = $("captcha-session-viewer").value;
    if (!viewerOrigins.has(viewerOrigin)) {
      error(new Error("지원하는 일반 뷰어를 선택하세요."));
      return;
    }
    const replacing = Boolean(session),
      epoch = ++sessionEpoch,
      generation = UI.generation();
    cancelPointer();
    stopFrames();
    session = { host, generation, open: false, automatic: automatic ? {active:true} : null };
    busy = true;
    $("captcha-session-text").value = "";
    $("captcha-session-error").textContent = "";
    $("captcha-session-status").textContent = remaining
      ? "남은 인증 확인 · 화면 여는 중…"
      : "서버 세션 여는 중…";
    if (!dialog.open) dialog.showModal();
    controls();
    lifecycleChain = lifecycleChain
      .catch(() => {})
      .then(async () => {
        if (!current(epoch)) return null;
        if (replacing) await api("close", {});
        if (!current(epoch)) return null;
        const existing = await api("status");
        if (!current(epoch)) return null;
        if (
          existing?.open &&
          existing.host === host &&
          existing.viewerOrigin === viewerOrigin
        )
          return existing;
        return api("open", { host, viewerOrigin });
      });
    try {
      const result = await lifecycleChain;
      if (!current(epoch)) return;
      if (!result?.open) throw new Error("서버 세션을 열지 못했습니다.");
      session = { ...result, host, generation };
      $("captcha-session-status").textContent = remaining
        ? "남은 인증 확인 · 아래 화면에서 완료하세요."
        : "서버 세션 · 아래 화면에서 완료하세요.";
      busy = false;
      if (automatic || result.automatic?.active) await retryCaptcha(epoch, result.automatic?.active);
      else startFrames(epoch);
    } catch (exception) {
      if (current(epoch)) {
        busy = false;
        error(exception);
      }
    } finally {
      if (current(epoch)) controls();
    }
  }

  async function retryCaptcha(epoch = sessionEpoch, alreadyRunning = false) {
    if (!current(epoch) || !session?.open || (busy && !alreadyRunning)) return;
    busy = true;
    cancelPointer();
    session.automatic = { active: true, attempt: 1, maxAttempts: 5 };
    stopFrames();
    controls();
    $("captcha-session-error").textContent = "";
    try {
      await inputChain;
      if (!current(epoch)) return;
      const result = alreadyRunning ? await api("status") : await api("retry", {});
      if (!current(epoch)) return;
      session = { ...result, generation: session.generation };
      pollAutomatic(epoch);
    } catch (exception) {
      if (current(epoch)) {
        session.automatic = null;
        busy = false;
        error(exception);
        controls();
        startFrames(epoch);
      }
    }
  }
  async function pollAutomatic(epoch) {
    if (!current(epoch) || !isVisible()) return;
    try {
      const result = await api("status");
      if (!current(epoch)) return;
      session = { ...result, generation: session.generation };
      const auto = result.automatic;
      if (auto?.active) {
        busy = true;
        $("captcha-session-status").textContent = `자동 CAPTCHA ${auto.attempt || 1}/${auto.maxAttempts || 5} · ${auto.stage || "확인 중"}`;
        controls();
        automaticTimer = setTimeout(() => pollAutomatic(epoch), 1000);
        return;
      }
      busy = false;
      controls();
      if (auto?.state === "succeeded") {
        if (result.open && result.pendingSlots?.length) {
          await retryCaptcha(epoch);
        } else { closeCaptcha(); UI.refresh?.(); }
      } else {
        $("captcha-session-status").textContent = "자동 확인 종료 · 수동 CAPTCHA 확인 가능";
        if (auto?.error) error(new Error(auto.error));
        startFrames(epoch);
      }
    } catch (exception) {
      if (current(epoch)) { busy = false; error(exception); controls(); startFrames(epoch); }
    }
  }
  $("captcha-session-retry").addEventListener("click", () => retryCaptcha());
  function sendInput(body, epoch = sessionEpoch) {
    const moving = body.type === "pointer" && body.phase === "move",
      version = inputVersion;
    if (moving && queuedPointerMove?.epoch === epoch) {
      queuedPointerMove.update(body);
      return queuedPointerMove.promise;
    }
    // Slow requests retain one waiting move. Gesture boundaries stay ordered.
    let latestBody = body,
      moveJob;
    if (!moving) queuedPointerMove = null;
    awaitingInputs++;
    inputChain = inputChain
      .catch(() => {})
      .then(async () => {
        if (queuedPointerMove === moveJob) queuedPointerMove = null;
        if (!current(epoch) || !isVisible() || !session?.open) return;
        if (
          version !== inputVersion &&
          !(latestBody.type === "pointer" && latestBody.phase === "up")
        )
          return;
        try {
          await api("input", latestBody);
        } catch (exception) {
          if (current(epoch)) {
            frameAt = 0;
            cancelPointer();
            error(exception);
            controls();
          }
        }
      })
      .finally(() => {
        awaitingInputs--;
        if (current(epoch)) controls();
      });
    if (moving) {
      moveJob = {
        epoch,
        update: (next) => {
          latestBody = next;
        },
        promise: inputChain,
      };
      queuedPointerMove = moveJob;
    }
    return inputChain;
  }
  function coordinates(event) {
    if (!usable()) return null;
    const rect = frame.getBoundingClientRect();
    const width = Number(session.width),
      height = Number(session.height);
    if (!(rect.width > 0 && rect.height > 0 && width > 0 && height > 0))
      return null;
    return {
      x: Math.round(
        Math.max(
          0,
          Math.min(
            width - 1,
            ((event.clientX - rect.left) / rect.width) * width,
          ),
        ),
      ),
      y: Math.round(
        Math.max(
          0,
          Math.min(
            height - 1,
            ((event.clientY - rect.top) / rect.height) * height,
          ),
        ),
      ),
    };
  }
  function flushMove() {
    clearTimeout(moveTimer);
    moveTimer = null;
    if (pendingMove) {
      const move = pendingMove;
      pendingMove = null;
      sendInput({ type: "pointer", phase: "move", ...move });
    }
  }
  frame.addEventListener("pointerdown", (event) => {
    if (pointer || event.button !== 0) return;
    const point = coordinates(event);
    if (!point) return;
    event.preventDefault();
    pointer = { id: event.pointerId, ...point };
    try {
      frame.setPointerCapture(event.pointerId);
    } catch {
      /* Older browsers. */
    }
    sendInput({ type: "pointer", phase: "down", ...point });
    controls();
  });
  frame.addEventListener("pointermove", (event) => {
    if (!pointer || pointer.id !== event.pointerId) return;
    const point = coordinates(event);
    if (!point) return;
    event.preventDefault();
    pointer = { ...pointer, ...point };
    pendingMove = point;
    if (!moveTimer) moveTimer = setTimeout(flushMove, 50);
  });
  function finishPointer(event) {
    if (!pointer || pointer.id !== event.pointerId) return;
    event.preventDefault();
    const point = coordinates(event) || { x: pointer.x, y: pointer.y };
    flushMove();
    sendInput({ type: "pointer", phase: "up", ...point });
    cancelPointer();
    controls();
  }
  frame.addEventListener("pointerup", finishPointer);
  frame.addEventListener("pointercancel", finishPointer);
  frame.addEventListener("lostpointercapture", finishPointer);
  frame.addEventListener("dragstart", (event) => event.preventDefault());
  frame.addEventListener(
    "wheel",
    (event) => {
      if (!usable()) return;
      event.preventDefault();
      sendInput({
        type: "scroll",
        deltaX: Math.max(-2000, Math.min(2000, Math.round(event.deltaX))),
        deltaY: Math.max(-2000, Math.min(2000, Math.round(event.deltaY))),
      });
    },
    { passive: false },
  );
  $("captcha-session-text-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const text = $("captcha-session-text").value;
    $("captcha-session-text").value = "";
    if (usable() && text) sendInput({ type: "text", text });
  });
  for (const button of dialog.querySelectorAll(
    "[data-captcha-key], [data-captcha-scroll]",
  ))
    button.addEventListener("click", () => {
      if (!usable()) return;
      sendInput(
        button.dataset.captchaKey
          ? { type: "key", key: button.dataset.captchaKey }
          : {
              type: "scroll",
              deltaX: 0,
              deltaY: Number(button.dataset.captchaScroll),
            },
      );
    });
  $("captcha-session-apply").addEventListener("click", async () => {
    if (!usable() || pointer) return;
    const epoch = sessionEpoch,
      host = session.host;
    busy = true;
    controls();
    $("captcha-session-error").textContent = "";
    $("captcha-session-status").textContent =
      "사이트의 수집 가능 여부 확인 중…";
    try {
      await inputChain;
      if (!current(epoch) || !isVisible() || !frameAt) return;
      const result = await api("apply", {});
      if (!current(epoch)) return;
      busy = false;
      if (result.verified && result.pendingSlots?.length) {
        if (!result.status?.open)
          throw new Error(
            "남은 인증 화면을 열지 못했습니다. 다시 열어 확인하세요.",
          );
        sessionEpoch++;
        cancelPointer();
        stopFrames();
        session = { ...result.status, host, generation: UI.generation() };
        $("captcha-session-text").value = "";
        $("captcha-session-status").textContent =
          "남은 인증 확인 · 아래 화면에서 완료하세요.";
        startFrames(sessionEpoch);
      } else if (result.verified && result.siteReleased) {
        closeCaptcha();
        UI.refresh?.();
      } else {
        error(
          new Error(
            result.error ||
              "CAPTCHA 완료를 아직 확인하지 못했습니다. 화면에서 확인 후 다시 적용하세요.",
          ),
        );
        $("captcha-session-status").textContent = "서버 세션 · 인증 확인 필요";
      }
    } catch (exception) {
      if (current(epoch)) error(exception);
    } finally {
      if (current(epoch)) {
        busy = false;
        controls();
        if (isVisible() && session?.open) startFrames(epoch);
      }
    }
  });
  $("captcha-session-close").addEventListener("click", closeCaptcha);
  $("captcha-session-large")?.addEventListener("click", (event) => {
    if (busy || pointer || awaitingInputs) {
      event.preventDefault();
      return;
    }
    // Transfer the display, preserving the same owned server page for resume.
    sessionEpoch++;
    session = null;
    cancelPointer();
    stopFrames();
    $("captcha-session-text").value = "";
    if (dialog.open) dialog.close();
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
    closeCaptcha();
  });
  dialog.addEventListener("close", () => {
    if (session) closeCaptcha();
  });
  $("captcha-session-viewer").addEventListener("change", () => {
    if (session && !busy) openCaptcha(session.host);
  });
  document.addEventListener("visibilitychange", () => {
    if (!session) return;
    if (document.hidden) {
      if (!session.open) {
        closeCaptcha();
        return;
      }
      // Invalidate queued input and frames; release a held pointer on resume.
      const held = pointer ? { x: pointer.x, y: pointer.y } : null;
      sessionEpoch++;
      session = { ...session, heldPointer: held };
      busy = false;
      cancelPointer();
      stopFrames();
    } else if (isVisible()) {
      if (session.heldPointer)
        sendInput({ type: "pointer", phase: "up", ...session.heldPointer });
      session = { ...session, heldPointer: null };
      const epoch = sessionEpoch;
      api("status")
        .then((result) => {
          if (!current(epoch) || !isVisible()) return;
          if (!result?.open) {
            closeCaptcha();
            return;
          }
          session = { ...result, generation: session.generation };
          if (result.automatic?.active) { busy = true; pollAutomatic(epoch); }
          else { busy = false; controls(); startFrames(epoch); }
        })
        .catch((exception) => {
          if (current(epoch)) error(exception);
        });
    }
  });
  document.addEventListener("collector:status", () => {
    if (session && !attention(session.host) && !session.automatic?.active) closeCaptcha();
    for (const [host, request] of loginRequests)
      if (!request.pending) loginRequests.delete(host);
    renderBanner();
    openStandalone();
  });
  document.addEventListener("collector:auth", () => {
    if (!UI.authenticated() || session?.generation !== UI.generation())
      closeCaptcha();
    if (!UI.authenticated()) {
      loginRequests.clear();
    }
    renderBanner();
    openStandalone();
  });
  function openStandalone() {
    window.CaptchaWindow?.standalone?.({
      authenticated: UI.authenticated(),
      sites: UI.status?.().siteAttention || [],
      open: openCaptcha,
    });
  }
  renderBanner();
  openStandalone();
})();
