"use strict";
(() => {
  const UI = window.CollectorUI,
    $ = (id) => document.getElementById(id);
  const DEFAULTS = {
    maxConcurrency: 2,
    chapterDelayMs: 1000,
    defaultFormat: "txt",
    refreshIntervalMs: 5000,
    libraryPageSize: 24,
    thumbnailFit: "contain",
    displayDensity: "comfortable",
  };
  const FIELDS = {
    maxConcurrency: "settings-concurrency",
    chapterDelayMs: "settings-delay",
    defaultFormat: "settings-format",
    refreshIntervalMs: "settings-refresh",
    libraryPageSize: "settings-page-size",
    thumbnailFit: "settings-thumbnail",
    displayDensity: "settings-density",
  };
  let baseline = null,
    revision = 0,
    loadedGeneration = null,
    loadSequence = 0,
    currentLoad = null,
    saving = false,
    saveSequence = 0,
    passwordSequence = 0;
  let preview = null,
    infoSequence = 0,
    infoPromise = null,
    infoFetchedAt = 0,
    importSequence = 0;
  const touchedFormats = new Set();
  function alive(generation) {
    return UI.authenticated() && generation === UI.generation();
  }
  function normalize(value, strict = false) {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error("설정 JSON 객체가 필요합니다.");
    if (
      strict &&
      Object.keys(value).some((key) => !Object.hasOwn(DEFAULTS, key))
    )
      throw new Error(
        "알 수 없는 설정 항목은 허용되지 않습니다. 비밀번호 등 다른 정보는 제외하세요.",
      );
    const settings = {};
    for (const key of Object.keys(DEFAULTS))
      settings[key] = Object.hasOwn(value, key) ? value[key] : DEFAULTS[key];
    if (![1, 2].includes(settings.maxConcurrency))
      throw new Error("동시 수집 작품 수는 1개 또는 2개를 선택하세요.");
    if (
      !Number.isSafeInteger(settings.chapterDelayMs) ||
      settings.chapterDelayMs < 500 ||
      settings.chapterDelayMs > 10000
    )
      throw new Error("회차 대기 시간은 500~10,000밀리초로 입력하세요.");
    if (!["txt", "epub"].includes(settings.defaultFormat))
      throw new Error("저장 형식은 TXT 또는 EPUB를 선택하세요.");
    if (
      !Number.isSafeInteger(settings.refreshIntervalMs) ||
      settings.refreshIntervalMs < 2000 ||
      settings.refreshIntervalMs > 30000
    )
      throw new Error("갱신 간격은 2,000~30,000밀리초로 입력하세요.");
    if (![12, 24, 48, 96].includes(settings.libraryPageSize))
      throw new Error("한 페이지의 작품 수는 12·24·48·96개 중 선택하세요.");
    if (
      !["contain", "cover"].includes(settings.thumbnailFit) ||
      !["comfortable", "compact"].includes(settings.displayDensity)
    )
      throw new Error("표지 표시와 화면 간격을 확인하세요.");
    return settings;
  }
  function readForm() {
    const values = {};
    for (const [key, id] of Object.entries(FIELDS))
      values[key] = [
        "maxConcurrency",
        "chapterDelayMs",
        "refreshIntervalMs",
        "libraryPageSize",
      ].includes(key)
        ? Number($(id).value)
        : $(id).value;
    return normalize(values);
  }
  function fill(settings) {
    for (const [key, id] of Object.entries(FIELDS)) {
      const element = $(id),
        value = String(settings[key]);
      if (
        element.tagName === "SELECT" &&
        ![...element.options].some((option) => option.value === value)
      ) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent =
          key === "refreshIntervalMs" ? `${settings[key] / 1000}초` : value;
        element.append(option);
      }
      element.value = value;
    }
    markDirty();
  }
  function markDirty() {
    let dirty = true;
    try {
      dirty =
        !baseline || JSON.stringify(readForm()) !== JSON.stringify(baseline);
    } catch {
      /* Invalid input remains an unsaved change. */
    }
    const label = $("settings-save-state");
    label.textContent = dirty ? "변경됨 · 아직 저장하지 않음" : "저장됨";
    label.classList.toggle("dirty", dirty);
  }
  function applySaved(settings) {
    UI.defaults.defaultFormat = settings.defaultFormat;
    for (const [id, dialog] of [
      ["job-format", "job-dialog"],
      ["batch-format", "batch-dialog"],
      ["discover-format", null],
    ]) {
      const element = $(id);
      if (element && !touchedFormats.has(id) && (!dialog || !$(dialog)?.open))
        element.value = settings.defaultFormat;
    }
    UI.applyPreferences?.(settings);
    document.dispatchEvent(
      new CustomEvent("collector:settings", { detail: { ...settings } }),
    );
  }
  async function load() {
    if (!UI.authenticated()) return;
    const generation = UI.generation();
    if (loadedGeneration === generation) return;
    if (currentLoad?.generation === generation) return currentLoad.promise;
    const sequence = ++loadSequence,
      startRevision = revision;
    const promise = (async () => {
      try {
        const settings = normalize(await UI.api("/api/settings"));
        if (!alive(generation) || sequence !== loadSequence) return;
        baseline = settings;
        loadedGeneration = generation;
        applySaved(settings);
        if (revision === startRevision) fill(settings);
        else markDirty();
        $("settings-error").textContent = "";
      } catch (error) {
        if (alive(generation) && sequence === loadSequence)
          $("settings-error").textContent = UI.textError(error);
      } finally {
        if (currentLoad?.sequence === sequence) currentLoad = null;
      }
    })();
    currentLoad = { generation, sequence, promise };
    return promise;
  }
  $("settings-form").addEventListener("input", () => {
    revision++;
    markDirty();
  });
  $("settings-form").addEventListener("change", () => {
    revision++;
    markDirty();
  });
  for (const id of ["job-format", "batch-format", "discover-format"])
    for (const event of ["input", "change"])
      $(id)?.addEventListener(event, () => touchedFormats.add(id));
  $("settings-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if (saving) return;
    saving = true;
    $("settings-save").disabled = true;
    $("settings-error").textContent = "";
    $("settings-save-message").textContent = "";
    const generation = UI.generation(),
      startRevision = revision,
      sequence = ++saveSequence;
    loadSequence++;
    currentLoad = null;
    try {
      const result = normalize(
        await UI.api("/api/settings", {
          method: "PUT",
          body: JSON.stringify(readForm()),
        }),
      );
      if (!alive(generation)) return;
      baseline = result;
      loadedGeneration = generation;
      applySaved(result);
      if (revision === startRevision) fill(result);
      else markDirty();
      $("settings-save-message").textContent =
        "화면 설정을 적용했습니다. 수집 설정은 새 작업에, 기본 형식은 새 예약에 반영됩니다.";
      UI.toast("설정을 저장했습니다.");
    } catch (error) {
      if (alive(generation))
        $("settings-error").textContent = UI.textError(error);
    } finally {
      if (sequence === saveSequence) {
        saving = false;
        $("settings-save").disabled = false;
      }
    }
  });
  function localPreset(settings) {
    revision++;
    fill(settings);
    $("settings-save-message").textContent =
      "입력란에 적용했습니다. 설정 저장을 눌러 반영하세요.";
  }
  $("settings-preset-light").addEventListener("click", () =>
    localPreset({
      ...DEFAULTS,
      maxConcurrency: 1,
      chapterDelayMs: 2500,
      refreshIntervalMs: 10000,
      libraryPageSize: 12,
    }),
  );
  $("settings-preset-balanced").addEventListener("click", () =>
    localPreset({ ...DEFAULTS, chapterDelayMs: 1200 }),
  );
  $("settings-reset").addEventListener("click", () =>
    localPreset({ ...DEFAULTS }),
  );
  function clearPreview() {
    importSequence++;
    preview = null;
    $("settings-import-apply").disabled = true;
    $("settings-import-summary").hidden = true;
  }
  $("settings-import-text").addEventListener("input", clearPreview);
  $("settings-import-preview").addEventListener("click", () => {
    clearPreview();
    $("settings-transfer-error").textContent = "";
    try {
      const text = $("settings-import-text").value;
      if (text.length > 65536)
        throw new Error("설정 파일은 64KB 이하로 가져오세요.");
      preview = normalize(JSON.parse(text), true);
      $("settings-import-summary").textContent = JSON.stringify(
        preview,
        null,
        2,
      );
      $("settings-import-summary").hidden = false;
      $("settings-import-apply").disabled = false;
    } catch (error) {
      $("settings-transfer-error").textContent =
        error instanceof SyntaxError
          ? "JSON 형식을 확인하세요."
          : UI.textError(error);
    }
  });
  $("settings-import-apply").addEventListener("click", () => {
    if (preview) localPreset(preview);
  });
  $("settings-import-file").addEventListener("change", async (event) => {
    clearPreview();
    $("settings-transfer-error").textContent = "";
    const file = event.target.files?.[0];
    if (!file) return;
    const generation = UI.generation(),
      sequence = importSequence;
    try {
      if (file.size > 65536)
        throw new Error("설정 파일은 64KB 이하로 가져오세요.");
      const text = await file.text();
      if (!alive(generation) || sequence !== importSequence) return;
      $("settings-import-text").value = text;
      $("settings-import-preview").click();
    } catch (error) {
      if (alive(generation))
        $("settings-transfer-error").textContent = UI.textError(error);
    }
  });
  $("settings-export").addEventListener("click", () => {
    $("settings-transfer-error").textContent = "";
    try {
      const blob = new Blob([JSON.stringify(readForm(), null, 2) + "\n"], {
          type: "application/json",
        }),
        url = URL.createObjectURL(blob),
        link = document.createElement("a");
      link.href = url;
      link.download = "novel-collector-settings.json";
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (error) {
      $("settings-transfer-error").textContent = UI.textError(error);
    }
  });
  function resetPasswordVisibility() {
    for (const button of document.querySelectorAll("[data-password-target]")) {
      $(button.dataset.passwordTarget).type = "password";
      button.setAttribute("aria-pressed", "false");
      button.textContent = "보기";
      button.setAttribute(
        "aria-label",
        `${document.querySelector(`label[for="${button.dataset.passwordTarget}"]`).textContent} 보기`,
      );
    }
  }
  for (const button of document.querySelectorAll("[data-password-target]"))
    button.addEventListener("click", () => {
      const input = $(button.dataset.passwordTarget),
        visible = input.type === "password";
      input.type = visible ? "text" : "password";
      button.setAttribute("aria-pressed", String(visible));
      button.textContent = visible ? "숨기기" : "보기";
      button.setAttribute(
        "aria-label",
        `${document.querySelector(`label[for="${input.id}"]`).textContent} ${visible ? "숨기기" : "보기"}`,
      );
    });
  $("password-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    if ($("password-save").disabled) return;
    $("password-error").textContent = "";
    $("password-result").textContent = "";
    $("password-save").disabled = true;
    const generation = UI.generation(),
      sequence = ++passwordSequence;
    try {
      const currentPassword = $("password-current").value,
        newPassword = $("password-new").value,
        confirmPassword = $("password-confirm").value;
      if (newPassword.length < 8 || newPassword.length > 128)
        throw new Error("새 비밀번호는 8~128자로 입력하세요.");
      if (newPassword !== confirmPassword)
        throw new Error("새 비밀번호와 확인 값이 다릅니다.");
      await UI.api("/api/settings/password", {
        method: "POST",
        body: JSON.stringify({ currentPassword, newPassword, confirmPassword }),
      });
      if (!alive(generation)) return;
      $("password-result").textContent =
        "비밀번호를 변경했습니다. 이 기기는 로그인 상태를 유지합니다.";
      event.target.reset();
      resetPasswordVisibility();
    } catch (error) {
      if (alive(generation))
        $("password-error").textContent = UI.textError(error);
    } finally {
      if (sequence === passwordSequence) $("password-save").disabled = false;
    }
  });
  function bytes(value) {
    if (value == null) return "확인할 수 없음";
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0) return "—";
    const units = ["B", "KB", "MB", "GB", "TB"];
    let amount = number,
      index = 0;
    while (amount >= 1024 && index < units.length - 1) {
      amount /= 1024;
      index++;
    }
    return `${amount.toLocaleString("ko-KR", { maximumFractionDigits: index ? 1 : 0 })} ${units[index]}`;
  }
  function count(value) {
    return Number.isFinite(Number(value))
      ? Number(value).toLocaleString("ko-KR")
      : "—";
  }
  function operation() {
    const status = UI.status?.();
    if (!status) return;
    const active = Array.isArray(status.activeJobIds)
      ? status.activeJobIds.length
      : status.currentJobId
        ? 1
        : 0;
    $("system-operation").textContent = status.queuePaused
      ? "전체 일시정지 · 직접 시작할 때까지 유지"
      : status.backoff?.active
        ? "연속 실패로 요청 대기 중"
        : active
          ? `${active}개 작품 수집 중`
          : "다음 예약을 기다리고 있습니다.";
  }
  async function loadInfo(force = false) {
    operation();
    if (!UI.authenticated()) return;
    if (infoPromise) return infoPromise;
    if (!force && Date.now() - infoFetchedAt < 30000) return;
    const generation = UI.generation(),
      sequence = ++infoSequence;
    $("system-info-refresh").disabled = true;
    $("system-info-error").textContent = "";
    const promise = (async () => {
      try {
        const info = await UI.api("/api/system/info");
        if (!alive(generation) || sequence !== infoSequence) return;
        $("system-book-count").textContent = `${count(info.bookCount)}개`;
        $("system-chapter-count").textContent = `${count(info.chapterCount)}화`;
        $("system-body-bytes").textContent = bytes(info.bodyBytes);
        $("system-disk-free").textContent = bytes(info.diskFreeBytes);
        const seconds = Math.max(
          0,
          Math.floor(Number(info.uptimeSeconds) || 0),
        );
        $("system-uptime").textContent =
          `${Math.floor(seconds / 3600)}시간 ${Math.floor((seconds % 3600) / 60)}분`;
        $("system-backoff").textContent =
          `${count(info.backoff?.threshold ?? 5)}회 실패 후 ${Math.floor((info.backoff?.cooldownMs ?? 600000) / 60000)}분`;
        $("system-info-updated").textContent = info.computedAt
          ? `확인 시각 ${new Date(info.computedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}${info.cached ? " · 저장된 통계" : ""}`
          : "서버에서 확인한 정보입니다.";
        infoFetchedAt = Date.now();
        operation();
      } catch (error) {
        if (alive(generation) && sequence === infoSequence)
          $("system-info-error").textContent = UI.textError(error);
      } finally {
        if (sequence === infoSequence) {
          infoPromise = null;
          $("system-info-refresh").disabled = false;
        }
      }
    })();
    infoPromise = promise;
    return promise;
  }
  $("system-info-refresh").addEventListener("click", () => loadInfo(true));
  document.addEventListener("collector:status", operation);
  document.addEventListener("collector:view", (event) => {
    if (event.detail === "settings") {
      load();
      loadInfo();
    }
  });
  document.addEventListener("collector:auth", (event) => {
    if (event.detail) load();
    else {
      loadSequence++;
      saveSequence++;
      passwordSequence++;
      infoSequence++;
      importSequence++;
      saving = false;
      currentLoad = null;
      infoPromise = null;
      loadedGeneration = null;
      infoFetchedAt = 0;
      baseline = null;
      preview = null;
      revision++;
      touchedFormats.clear();
      $("settings-form").reset();
      $("password-form").reset();
      $("settings-save").disabled = false;
      $("password-save").disabled = false;
      $("system-info-refresh").disabled = false;
      $("settings-import-text").value = "";
      $("settings-import-file").value = "";
      $("settings-save-state").textContent = "로그인 후 설정을 확인합니다.";
      $("settings-import-apply").disabled = true;
      $("settings-import-summary").hidden = true;
      $("password-error").textContent = "";
      $("password-result").textContent = "";
      resetPasswordVisibility();
    }
  });
  if (UI.authenticated()) load();
})();
