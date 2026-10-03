"use strict";
(() => {
  const UI = window.CollectorUI,
    $ = (id) => document.getElementById(id),
    accountHosts = new Set(["sbxh9.com", "toki32.com"]);
  let account = null,
    epoch = 0,
    revision = 0,
    loading = false,
    saving = false,
    testing = false,
    polling = false,
    timer = null,
    result = null,
    selectedManually = false;
  function visible() {
    return UI.authenticated() && !document.hidden && !$("settings-view").hidden;
  }
  function host() {
    const value = $("site-account-host").value.trim().toLowerCase();
    if (!accountHosts.has(value))
      throw new Error("지원하는 수집 사이트를 선택하세요.");
    return value;
  }
  function alive(generation, version) {
    return (
      UI.authenticated() && generation === UI.generation() && version === epoch
    );
  }
  function clearSecrets() {
    $("site-account-password").value = "";
    $("site-account-pin").value = "";
  }
  function resetAccount() {
    epoch++;
    revision++;
    stopPoll();
    account = null;
    result = null;
    loading = saving = testing = polling = false;
    clearSecrets();
    $("site-account-username").value = "";
    $("site-account-enabled").checked = false;
    $("site-account-delete-confirmation").hidden = true;
    $("site-account-result").textContent = "";
    $("site-account-config-state").textContent =
      "선택한 사이트의 계정 상태를 확인하세요.";
    controls();
  }
  function syncSource() {
    if (selectedManually || !UI.authenticated()) return;
    const candidate = UI.status?.().source?.host,
      selected = accountHosts.has(candidate) ? candidate : "sbxh9.com";
    if ($("site-account-host").value === selected) return;
    $("site-account-host").value = selected;
    resetAccount();
  }
  function error(exception) {
    $("site-account-error").textContent = UI.textError(exception);
  }
  function stopPoll() {
    clearTimeout(timer);
    timer = null;
  }
  function controls() {
    $("site-account-save").disabled = saving || loading;
    $("site-account-load").disabled = loading || saving;
    $("site-account-test").disabled = !account?.configured || saving || testing;
    $("site-account-delete").disabled = !account?.configured || saving;
    $("site-account-delete-confirm").disabled = saving;
  }
  function renderPublic() {
    $("site-account-config-state").textContent = account?.configured
      ? `저장됨 · 자동 로그인 ${account.enabled ? "사용" : "중지"}`
      : "계정 정보가 저장되지 않았습니다.";
    controls();
  }
  function normalizeResult(data) {
    const raw = data?.state || data?.status || "idle",
      map = {
        queued: "running",
        completed: "success",
        ready: "success",
        failed: "error",
        needs_attention: "error",
        cancelled: "error",
      };
    const state =
      (data?.success === false || data?.needsAttention === true) &&
      ["completed", "success", "ready"].includes(raw)
        ? "error"
        : map[raw] || raw;
    return { ...data, state };
  }
  function renderResult(data) {
    const state = data?.state || "idle",
      phase = typeof data?.phase === "string" ? data.phase : "";
    const messages = {
      running: "정상 로그인 확인 중…",
      success: "로그인 확인 완료 · 수집 상태를 확인하세요.",
      error: "로그인 확인에 실패했습니다. 계정 정보와 인증번호를 확인하세요.",
      deferred: "잠시 후 다시 확인하세요. 짧은 대기 중입니다.",
      idle: "아직 로그인 확인을 실행하지 않았습니다.",
    };
    const pending = Array.isArray(data?.pendingSlots)
      ? data.pendingSlots.length
      : 0;
    const retry = Date.parse(data?.retryAt);
    const extra = [
      pending ? `확인할 브라우저 ${pending}개` : null,
      Number.isFinite(retry)
        ? `다음 확인 가능 시각 ${new Date(retry).toLocaleTimeString("ko-KR", { timeZone: "Asia/Seoul", hour12: false })}`
        : null,
    ].filter(Boolean);
    $("site-account-result").textContent = [
      phase || messages[state] || "로그인 상태를 확인하세요.",
      ...extra,
    ].join(" · ");
    $("site-account-result").classList.toggle(
      "failed",
      ["error", "failed", "deferred"].includes(state),
    );
    if (data?.error) $("site-account-error").textContent = String(data.error);
    if (state === "success") UI.refresh?.();
  }
  async function load(force = false) {
    syncSource();
    if (!visible() || loading || (!force && account)) return;
    let selectedHost;
    try {
      selectedHost = host();
    } catch (exception) {
      error(exception);
      return;
    }
    const generation = UI.generation(),
      version = epoch,
      startRevision = revision;
    loading = true;
    controls();
    $("site-account-error").textContent = "";
    try {
      const data = await UI.api(
        `/api/site-account?host=${encodeURIComponent(selectedHost)}`,
      );
      if (!alive(generation, version)) return;
      account = {
        host: selectedHost,
        configured: Boolean(data.configured),
        enabled: Boolean(data.enabled),
        username: String(data.username || ""),
      };
      renderPublic();
      if (revision === startRevision) {
        $("site-account-username").value = account.username;
        $("site-account-enabled").checked = account.enabled;
      }
      if (data.loginStatus) {
        result = normalizeResult(data.loginStatus);
        renderResult(result);
        if (result.state === "running") {
          testing = true;
          schedulePoll();
        }
      } else if (account.configured) {
        const last = await UI.api(
          `/api/site-account/test?host=${encodeURIComponent(selectedHost)}`,
        );
        if (!alive(generation, version)) return;
        result = normalizeResult(last);
        renderResult(result);
        testing = result.state === "running";
        schedulePoll();
      }
    } catch (exception) {
      if (alive(generation, version)) error(exception);
    } finally {
      if (version === epoch) {
        loading = false;
        controls();
      }
    }
  }
  function schedulePoll() {
    stopPoll();
    if (visible() && testing) timer = setTimeout(poll, 1000);
  }
  async function poll() {
    stopPoll();
    if (!visible() || !testing || polling) return;
    const generation = UI.generation(),
      version = epoch;
    polling = true;
    try {
      const data = await UI.api(
        `/api/site-account/test?host=${encodeURIComponent(account.host)}`,
      );
      if (!alive(generation, version)) return;
      result = normalizeResult(data);
      testing = result.state === "running";
      renderResult(result);
      controls();
    } catch (exception) {
      if (alive(generation, version)) {
        testing = false;
        error(exception);
        controls();
      }
    } finally {
      if (version === epoch) {
        polling = false;
        schedulePoll();
      }
    }
  }
  $("site-account-form").addEventListener("input", () => revision++);
  $("site-account-form").addEventListener("change", () => revision++);
  $("site-account-host").addEventListener("change", () => {
    selectedManually = true;
    resetAccount();
    load(true);
  });
  $("site-account-load").addEventListener("click", () => load(true));
  $("site-account-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving || loading) return;
    $("site-account-error").textContent = "";
    const generation = UI.generation(),
      version = epoch,
      startRevision = revision;
    try {
      const selectedHost = host(),
        username = $("site-account-username").value.trim(),
        password = $("site-account-password").value,
        pin = $("site-account-pin").value,
        enabled = $("site-account-enabled").checked;
      if (!username) throw new Error("사이트 아이디를 입력하세요.");
      if (username.length > 128 || /[\x00-\x1f\x7f]/.test(username))
        throw new Error("사이트 아이디는 1~128자로 입력하세요.");
      if (password.length > 128)
        throw new Error("사이트 비밀번호는 128자 이하로 입력하세요.");
      if (!account?.configured && (!password || !pin))
        throw new Error(
          "처음 저장할 때는 비밀번호와 고정 4자리 인증번호를 함께 입력하세요.",
        );
      if (pin && !/^\d{4}$/.test(pin))
        throw new Error("고정 인증번호는 숫자 4자리로 입력하세요.");
      const body = {
        host: selectedHost,
        username,
        ...(password ? { password } : {}),
        ...(pin ? { pin } : {}),
        enabled,
      };
      saving = true;
      controls();
      let pending;
      try {
        pending = UI.api("/api/site-account", {
          method: "PUT",
          body: JSON.stringify(body),
        });
      } finally {
        clearSecrets();
      }
      const data = await pending;
      if (!alive(generation, version)) return;
      account = {
        host: selectedHost,
        configured: Boolean(data.configured),
        enabled: Boolean(data.enabled),
        username: String(data.username || username),
      };
      renderPublic();
      if (revision === startRevision) {
        $("site-account-username").value = account.username;
        $("site-account-enabled").checked = account.enabled;
      }
      $("site-account-result").textContent = "자동 로그인 설정을 저장했습니다.";
      UI.toast("사이트 계정 설정을 저장했습니다.");
    } catch (exception) {
      if (alive(generation, version)) error(exception);
    } finally {
      if (version === epoch) {
        saving = false;
        controls();
      }
    }
  });
  $("site-account-test").addEventListener("click", async () => {
    if (!account?.configured || testing || saving) return;
    const generation = UI.generation(),
      version = epoch;
    testing = true;
    controls();
    $("site-account-error").textContent = "";
    try {
      const data = await UI.api("/api/site-account/test", {
        method: "POST",
        body: JSON.stringify({ host: account.host }),
      });
      if (!alive(generation, version)) return;
      result = normalizeResult(data);
      testing = result.state === "running";
      renderResult(result);
      controls();
      schedulePoll();
    } catch (exception) {
      if (alive(generation, version)) {
        testing = false;
        error(exception);
        controls();
      }
    }
  });
  $("site-account-delete").addEventListener("click", () => {
    if (!account?.configured) return;
    $("site-account-delete-host").textContent = account.host;
    $("site-account-delete-confirmation").hidden = false;
  });
  $("site-account-delete-cancel").addEventListener("click", () => {
    $("site-account-delete-confirmation").hidden = true;
  });
  $("site-account-delete-confirm").addEventListener("click", async () => {
    if (!account?.configured || saving) return;
    const generation = UI.generation(),
      version = epoch,
      selectedHost = account.host;
    saving = true;
    controls();
    $("site-account-error").textContent = "";
    try {
      await UI.api(
        `/api/site-account?host=${encodeURIComponent(selectedHost)}`,
        { method: "DELETE" },
      );
      if (!alive(generation, version)) return;
      stopPoll();
      testing = false;
      result = null;
      account = {
        host: selectedHost,
        configured: false,
        enabled: false,
        username: "",
      };
      clearSecrets();
      $("site-account-username").value = "";
      $("site-account-enabled").checked = false;
      $("site-account-delete-confirmation").hidden = true;
      $("site-account-result").textContent =
        "저장된 자동 로그인 정보를 제거했습니다.";
      renderPublic();
    } catch (exception) {
      if (alive(generation, version)) error(exception);
    } finally {
      if (version === epoch) {
        saving = false;
        controls();
      }
    }
  });
  document.addEventListener("collector:view", (event) => {
    if (event.detail === "settings") {
      load();
      schedulePoll();
    } else stopPoll();
  });
  document.addEventListener("collector:status", () => {
    syncSource();
    load();
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) stopPoll();
    else schedulePoll();
  });
  document.addEventListener("collector:auth", (event) => {
    if (event.detail) {
      if (visible()) load();
      return;
    }
    epoch++;
    stopPoll();
    account = null;
    selectedManually = false;
    result = null;
    loading = false;
    saving = false;
    testing = false;
    polling = false;
    clearSecrets();
    $("site-account-username").value = "";
    $("site-account-enabled").checked = false;
    $("site-account-delete-confirmation").hidden = true;
    $("site-account-config-state").textContent =
      "로그인 후 사이트 계정 상태를 확인하세요.";
    $("site-account-result").textContent = "";
    $("site-account-error").textContent = "";
    controls();
  });
  controls();
  if (visible()) load();
})();
