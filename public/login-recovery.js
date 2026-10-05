"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const details = $("login-recovery");
  if (!details) return;
  const confirmation = "관리자 비밀번호 초기화";
  const directLocal =
    ["localhost", "127.0.0.1", "[::1]", "::1"].includes(location.hostname) &&
    ["http:", "https:"].includes(location.protocol);
  let nonce = null,
    expiresAt = 0,
    loading = false,
    resetting = false,
    sequence = 0,
    controller = null,
    password = null,
    completed = false,
    fileUrl = null,
    revokeTimer = null;
  const generation = () => window.CollectorUI?.generation?.() ?? 0;
  const authenticated = () => Boolean(window.CollectorUI?.authenticated?.());
  const status = (message) => {
    $("recovery-status").textContent = message;
  };
  const current = (id, authGeneration) =>
    id === sequence && generation() === authGeneration && !authenticated();
  function releaseFile() {
    clearTimeout(revokeTimer);
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = null;
  }
  function ready() {
    return (
      directLocal &&
      nonce &&
      expiresAt > Date.now() &&
      !resetting &&
      !loading &&
      !completed &&
      !authenticated() &&
      $("recovery-ack").checked &&
      $("recovery-phrase").value === confirmation
    );
  }
  function updateButton() {
    $("recovery-reset").disabled = !ready();
  }
  function clear() {
    sequence++;
    controller?.abort();
    controller = null;
    nonce = null;
    expiresAt = 0;
    password = null;
    completed = false;
    loading = false;
    resetting = false;
    releaseFile();
    $("recovery-local-panel").hidden = true;
    $("recovery-result").hidden = true;
    $("recovery-next").hidden = true;
    $("recovery-ack").checked = false;
    $("recovery-phrase").value = "";
    $("recovery-saved").checked = false;
    $("recovery-saved").disabled = true;
    $("recovery-save").disabled = false;
    $("recovery-remote-guide").hidden = false;
    status("");
    updateButton();
  }
  async function request(options, activeController) {
    const timeout = setTimeout(() => activeController.abort(), 10000);
    try {
      const response = await fetch("/api/admin-recovery", {
        credentials: "same-origin",
        cache: "no-store",
        ...options,
        signal: activeController.signal,
        headers: options.body ? { "Content-Type": "application/json" } : {},
      });
      if (!response.ok) throw new Error("복구 요청을 확인하지 못했습니다.");
      return await response.json();
    } finally {
      clearTimeout(timeout);
    }
  }
  async function loadAvailability() {
    if (
      !directLocal ||
      authenticated() ||
      loading ||
      resetting ||
      completed ||
      !details.open
    )
      return;
    if (nonce && expiresAt > Date.now()) return;
    const id = ++sequence,
      authGeneration = generation(),
      activeController = new AbortController();
    controller = activeController;
    loading = true;
    nonce = null;
    $("recovery-local-panel").hidden = true;
    updateButton();
    status("이 컴퓨터의 복구 가능 여부를 확인합니다.");
    try {
      const result = await request({}, activeController);
      if (!current(id, authGeneration) || !details.open) return;
      if (
        result?.localAvailable !== true ||
        typeof result.nonce !== "string" ||
        !/^[a-f0-9]{64}$/.test(result.nonce) ||
        !Number.isFinite(result.expiresAt) ||
        result.expiresAt <= Date.now()
      ) {
        status(
          "이 연결에서는 웹 재설정을 사용할 수 없습니다. 서버의 초기 접속 파일을 확인하거나 서버 관리자에게 복구를 요청하세요.",
        );
        return;
      }
      nonce = result.nonce;
      expiresAt = result.expiresAt;
      $("recovery-local-panel").hidden = false;
      $("recovery-remote-guide").hidden = true;
      status(
        "경고를 확인하고 확인 문구를 입력하세요. 복구 확인은 2분 동안 유효합니다.",
      );
    } catch {
      if (current(id, authGeneration) && details.open)
        status(
          "복구 가능 여부를 확인하지 못했습니다. 안내를 닫았다 다시 열어 주세요.",
        );
    } finally {
      if (current(id, authGeneration)) {
        loading = false;
        controller = null;
        updateButton();
      }
    }
  }
  async function reset() {
    if (!ready()) {
      updateButton();
      return;
    }
    const id = ++sequence,
      authGeneration = generation(),
      activeController = new AbortController(),
      challenge = nonce;
    controller = activeController;
    resetting = true;
    updateButton();
    status("관리자 비밀번호를 재설정합니다.");
    try {
      const result = await request(
        {
          method: "POST",
          body: JSON.stringify({ confirmation, nonce: challenge }),
        },
        activeController,
      );
      if (!current(id, authGeneration)) return;
      if (
        result?.reset !== true ||
        result.authenticated !== false ||
        typeof result.newPassword !== "string" ||
        result.newPassword.length < 16 ||
        result.newPassword.length > 128
      )
        throw new Error("복구 응답이 올바르지 않습니다.");
      password = result.newPassword;
      completed = true;
      $("recovery-local-panel").hidden = true;
      $("recovery-result").hidden = false;
      $("recovery-saved").disabled = true;
      status(
        "재설정했습니다. 새 접속 정보 파일을 저장하고 저장 여부를 직접 확인하세요. 자동 로그인하지 않습니다.",
      );
    } catch {
      if (current(id, authGeneration))
        status(
          "재설정 결과를 확인하지 못했습니다. 서버의 secrets/admin-login.txt를 먼저 확인하세요. 다시 시도하려면 안내를 닫았다 여세요.",
        );
    } finally {
      if (current(id, authGeneration)) {
        nonce = null;
        expiresAt = 0;
        resetting = false;
        controller = null;
        $("recovery-ack").checked = false;
        $("recovery-phrase").value = "";
        updateButton();
      }
    }
  }
  function save() {
    if (!password || authenticated()) return;
    releaseFile();
    try {
      fileUrl = URL.createObjectURL(
        new Blob([`${password}\n`], { type: "text/plain;charset=utf-8" }),
      );
      const link = document.createElement("a");
      link.href = fileUrl;
      link.download = "admin-login.txt";
      link.hidden = true;
      document.body.append(link);
      link.click();
      link.remove();
      $("recovery-saved").disabled = false;
      status(
        "저장 창이나 브라우저 다운로드 목록에서 admin-login.txt 저장을 확인하세요. 파일의 한 줄이 새 비밀번호입니다.",
      );
      revokeTimer = setTimeout(releaseFile, 1000);
    } catch {
      releaseFile();
      status(
        "파일 저장을 시작하지 못했습니다. 서버 설치 폴더의 secrets/admin-login.txt를 직접 안전하게 보관하세요.",
      );
    }
  }
  $("recovery-phrase-guide").textContent = `확인 문구: ${confirmation}`;
  $("recovery-phrase").setAttribute("autocomplete", "off");
  $("recovery-remote-guide").hidden = false;
  details.addEventListener("toggle", () => {
    if (details.open) loadAvailability();
    else {
      // A submitted reset may already have committed. Keep it in flight so reopening
      // cannot dispatch another reset or discard the resulting credential file.
      if (resetting) return;
      sequence++;
      controller?.abort();
      controller = null;
      loading = false;
      resetting = false;
      nonce = null;
      expiresAt = 0;
      updateButton();
    }
  });
  $("recovery-ack").addEventListener("change", updateButton);
  $("recovery-phrase").addEventListener("input", updateButton);
  $("recovery-reset").addEventListener("click", reset);
  $("recovery-save").addEventListener("click", save);
  $("recovery-saved").addEventListener("change", () => {
    if ($("recovery-saved").disabled || !$("recovery-saved").checked) return;
    password = null;
    releaseFile();
    $("recovery-save").disabled = true;
    $("recovery-next").hidden = false;
    status("저장한 접속 정보 파일을 다른 사람과 공유하지 마세요.");
  });
  document.addEventListener("collector:auth", clear);
  window.addEventListener("pagehide", clear);
  updateButton();
})();
