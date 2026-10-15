"use strict";
(() => {
  const profile = "v1-w1280-h2048-q90", hash = /^[a-f0-9]{64}$/;
  const dimension = value => Number.isSafeInteger(value) && value > 0;

  function imageSources(prefix, chapter, image, offset) {
    const index = offset + 1, base = `${prefix}/images/${index}`;
    const original = { url: base + (hash.test(image.sha256) ? `?v=${image.sha256}` : ""), width: image.width, height: image.height };
    const viewer = chapter.viewer;
    const entry = Array.isArray(viewer?.images) ? viewer.images.find(value => value?.index === index) : null;
    const version = typeof entry?.originalUrl === "string" && entry.originalUrl.startsWith(base + "?v=")
      ? entry.originalUrl.slice((base + "?v=").length) : "";
    if (hash.test(version) && (!hash.test(image.sha256) || version === image.sha256)) original.url = entry.originalUrl;
    const valid = viewer?.profile === profile && (!chapter.hash || viewer.revision === chapter.hash)
      && hash.test(version) && original.url === entry?.originalUrl && Array.isArray(entry.parts) && entry.parts.length > 0
      && entry.parts.every((part, partIndex) => part && dimension(part.width) && dimension(part.height) && (
        (entry.parts.length === 1 && part.url === original.url && part.width === image.width && part.height === image.height)
        || (part.url === `${prefix}/viewer/${version}/${profile}/${partIndex + 1}.webp`
          && part.width <= Math.min(1280, image.width) && part.height <= 2048)
      ));
    const originalParts = [original];
    return {
      index, originalParts,
      fastParts: valid ? (entry.parts[0].url === original.url ? originalParts : entry.parts) : null,
      unavailable: viewer != null && !valid,
    };
  }

  function mount({ container, scrollContainer, prefix, chapter, isCurrent }) {
    if (!/^\/api\/books\/[A-Za-z0-9_-]{1,100}\/chapters\/[A-Za-z0-9_-]{1,100}$/.test(prefix))
      throw new Error("이미지 주소를 확인할 수 없습니다.");
    const { node } = window.CollectorUI;
    let disposed = false, mode = "fast";
    const current = () => !disposed && isCurrent();
    const toolbar = node("div", "reader-image-toolbar"), label = node("label", "", "보기 화질"), select = node("select");
    select.id = "reader-image-quality";
    label.htmlFor = select.id;
    for (const [value, text] of [["fast", "빠른 보기"], ["original", "원본 화질"]]) {
      const option = node("option", "", text); option.value = value; select.append(option);
    }
    const download = node("a", "export-link", "회차 CBZ 받기");
    download.href = prefix + "/cbz"; download.setAttribute("download", "");
    toolbar.append(download, label, select);
    const list = node("div", "reader-image-list");
    const groups = (Array.isArray(chapter.images) ? chapter.images : []).map((image, index) => {
      const entry = {
        ...imageSources(prefix, chapter, image, index), element: node("section", "reader-image-group"),
        parts: node("div", "reader-image-parts"), status: node("p", "reader-image-status"), retry: node("button", "quiet", "다시 불러오기"),
        fallback: false, failed: false, renderId: 0, renderedParts: null,
      };
      entry.element.dataset.image = String(index + 1);
      entry.status.setAttribute("role", "status"); entry.status.setAttribute("aria-live", "polite");
      entry.retry.type = "button";
      entry.retry.setAttribute("aria-label", `${index + 1}번째 이미지 다시 불러오기`);
      entry.retry.addEventListener("click", () => {
        if (!current()) return;
        preservePosition(() => {
          if (mode === "fast") entry.fallback = false;
          renderGroup(entry, true);
        });
      });
      entry.element.append(entry.parts, entry.status, entry.retry); list.append(entry.element);
      return entry;
    });
    function status(entry) {
      entry.status.textContent = entry.failed ? `${entry.index}번째 이미지를 불러오지 못했습니다.`
        : mode === "fast" && entry.fallback ? `${entry.index}번째 빠른 보기를 불러오지 못해 원본 화질로 표시합니다.`
        : mode === "fast" && entry.unavailable ? `${entry.index}번째 빠른 보기 정보를 사용할 수 없어 원본 화질로 표시합니다.` : "";
      entry.status.hidden = !entry.status.textContent;
      entry.retry.hidden = !entry.failed && !(mode === "fast" && (entry.fallback || entry.unavailable));
    }
    function releaseImages(entry) {
      for (const image of entry.parts.querySelectorAll("img")) {
        image.onload = null; image.onerror = null; image.removeAttribute("src");
      }
    }
    function renderGroup(entry, retry = false) {
      const parts = mode === "fast" && !entry.fallback && entry.fastParts ? entry.fastParts : entry.originalParts;
      if (!retry && entry.renderedParts === parts) { status(entry); return; }
      releaseImages(entry);
      entry.renderedParts = parts; entry.failed = false;
      const renderId = ++entry.renderId;
      entry.parts.replaceChildren(...parts.map((part, partIndex) => {
        const image = node("img", "webtoon-reader-image"), first = entry.index === 1 && partIndex === 0;
        image.alt = `${entry.index}번째 본문 이미지${parts.length > 1 ? ` (${partIndex + 1}/${parts.length})` : ""}`;
        image.setAttribute("loading", first ? "eager" : "lazy");
        image.setAttribute("fetchpriority", first ? "high" : "auto");
        image.setAttribute("decoding", "async");
        if (dimension(part.width) && dimension(part.height)) { image.width = part.width; image.height = part.height; }
        image.onerror = () => {
          if (!current() || renderId !== entry.renderId) return;
          if (parts !== entry.originalParts && !entry.fallback) {
            entry.fallback = true;
            preservePosition(() => renderGroup(entry));
          } else { entry.failed = true; status(entry); }
        };
        image.src = part.url;
        return image;
      }));
      status(entry);
    }
    function preservePosition(update) {
      const top = scrollContainer.getBoundingClientRect().top, previous = scrollContainer.scrollTop;
      let anchor;
      for (const entry of groups) {
        const rect = entry.element.getBoundingClientRect();
        if (rect.height > 0 && rect.bottom > top) {
          anchor = { entry, fraction: rect.top < top ? (top - rect.top) / rect.height : 0, offset: Math.max(0, rect.top - top) };
          break;
        }
      }
      update();
      if (anchor) {
        const rect = anchor.entry.element.getBoundingClientRect();
        scrollContainer.scrollTop = previous + rect.top - top + anchor.fraction * rect.height - anchor.offset;
      } else scrollContainer.scrollTop = previous;
    }
    select.addEventListener("change", () => {
      if (!current()) return;
      preservePosition(() => { mode = select.value === "original" ? "original" : "fast"; groups.forEach(entry => renderGroup(entry)); });
    });
    container.classList.add("reader-image-mode");
    container.replaceChildren(toolbar, list);
    groups.forEach(entry => renderGroup(entry));
    return {
      dispose() {
        disposed = true;
        groups.forEach(releaseImages);
        container.classList.remove("reader-image-mode");
      },
    };
  }
  window.CollectorReaderImages = { mount };
})();
