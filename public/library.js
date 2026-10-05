"use strict";
(() => {
  const UI = window.CollectorUI,
    $ = (id) => document.getElementById(id);
  const { api, node, count, date, empty, textError } = UI;
  const state = { selectedBook: null, chapterId: null, page: 1 };
  let books = [],
    signature = "",
    loading = null,
    bundle = null,
    bundleTimer = null,
    bundleRequest = false,
    failureContext = null;
  const selected = new Set();
  const metadataRequests = new Set();
  const cardEntries = new Map();
  let emptyCard = null,
    fetchedAt = 0,
    loaded = false,
    mutationEpoch = 0;
  let renderSignature = "";
  const pagination = node("div", "library-pagination");
  const previous = node("button", "quiet", "이전"),
    next = node("button", "quiet", "다음"),
    pageLabel = node("span", "muted");
  previous.id = "library-prev";
  next.id = "library-next";
  pageLabel.id = "library-page";
  pagination.append(previous, pageLabel, next);
  $("books-list").after(pagination);
  const sortLabel = node("label", "", "정렬"),
    sort = node("select");
  sort.id = "library-sort";
  for (const [value, label] of [
    ["updated", "최근 저장"],
    ["title", "제목순"],
    ["chapters", "저장 회차순"],
  ]) {
    const option = node("option", "", label);
    option.value = value;
    sort.append(option);
  }
  sortLabel.append(sort);
  document.querySelector(".library-filters").append(sortLabel);
  const pageSize = () => UI.preferences().libraryPageSize;
  function pagedBooks() {
    const filtered = visibleBooks();
    state.page = Math.min(state.page, Math.max(1, Math.ceil(filtered.length / pageSize())));
    return filtered.slice((state.page - 1) * pageSize(), state.page * pageSize());
  }
  previous.addEventListener("click", () => {
    state.page = Math.max(1, state.page - 1);
    render();
  });
  next.addEventListener("click", () => {
    state.page++;
    render();
  });
  sort.addEventListener("change", () => {
    state.page = 1;
    render();
  });
  async function openBook(book) {
    if (storedChapters(book) === 0) return;
    const id = book.id || book.bookId;
    state.selectedBook = id;
    state.chapterId = null;
    $("reader-book-title").textContent = book.title || "작품";
    $("chapter-count").textContent = "회차 목록을 불러오는 중…";
    $("chapter-list").replaceChildren();
    $("reader-chapter-title").textContent = "회차를 선택하세요";
    $("reader-meta").textContent = "";
    $("reader-text").textContent = "";
    $("reader-dialog").showModal();
    try {
      const data = await api(`/api/books/${encodeURIComponent(id)}`);
      if (state.selectedBook !== id || !$("reader-dialog").open) return;
      const chapters = Array.isArray(data?.chapters) ? data.chapters : [];
      $("reader-book-title").textContent = data.book?.title || book.title || "작품";
      $("chapter-count").textContent = `${count(chapters.length)}회차 저장됨`;
      const fragment = document.createDocumentFragment();
      for (const chapter of chapters) {
        const button = node(
          "button",
          "chapter-button",
          `${chapter.number === undefined ? "" : `${chapter.number}화 · `}${chapter.title || "제목 없음"}`,
        );
        button.dataset.chapter = chapter.id || chapter.chapterId;
        button.setAttribute("aria-pressed", "false");
        button.addEventListener("click", () => openChapter(id, chapter));
        fragment.append(button);
      }
      $("chapter-list").replaceChildren(fragment);
      if (chapters.length) await openChapter(id, chapters[0]);
      else $("reader-text").textContent = "아직 저장된 본문이 없습니다.";
    } catch (error) {
      $("reader-text").textContent = textError(error);
    }
  }
  async function openChapter(bookId, chapter) {
    const id = chapter.id || chapter.chapterId;
    state.chapterId = id;
    $("reader-chapter-title").textContent = chapter.title || `${chapter.number ?? ""}화`;
    $("reader-meta").textContent = "본문을 불러오는 중…";
    $("reader-text").textContent = "";
    for (const button of $("chapter-list").children) {
      const selected = button.dataset.chapter === String(id);
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-pressed", String(selected));
    }
    try {
      const data = await api(
        `/api/books/${encodeURIComponent(bookId)}/chapters/${encodeURIComponent(id)}`,
      );
      if (state.chapterId !== id || state.selectedBook !== bookId || !$("reader-dialog").open)
        return;
      $("reader-chapter-title").textContent =
        data.title || chapter.title || `${data.number ?? ""}화`;
      $("reader-meta").textContent =
        `${data.number === undefined ? "" : `${data.number}화 · `}${count((data.text || "").length)}자`;
      $("reader-text").textContent = data.text || "저장된 본문이 비어 있습니다.";
      document.querySelector(".reader-body").scrollTop = 0;
    } catch (error) {
      if (state.chapterId === id && state.selectedBook === bookId) {
        $("reader-meta").textContent = "본문 조회 실패";
        $("reader-text").textContent = textError(error);
      }
    }
  }

  function visibleBooks() {
    const query = $("library-query").value.trim().toLocaleLowerCase(),
      genre = $("library-genre").value;
    return books
      .filter(
        (book) =>
          (!query ||
            `${book.title || ""} ${book.author || ""}`.toLocaleLowerCase().includes(query)) &&
          (!genre || (Array.isArray(book.genres) ? book.genres : []).includes(genre)),
      )
      .sort((a, b) =>
        sort.value === "title"
          ? String(a.title || "").localeCompare(String(b.title || ""), "ko")
          : sort.value === "chapters"
            ? (b.storedChapterCount || 0) - (a.storedChapterCount || 0)
            : String(b.updatedAt || "").localeCompare(String(a.updatedAt || "")),
      );
  }
  function error(message = "") {
    $("library-error").textContent = message;
  }
  function selectable(book) {
    return storedChapters(book) !== 0;
  }
  function storedChapters(book) {
    return book.storedChapterCount ?? book.chapterCount ?? book.totalChapters;
  }
  function metadataState(book) {
    return book.metadataStatus ?? book.metadata?.state ?? book.metadata?.status;
  }
  function selectState() {
    $("library-selected").textContent = `${count(selected.size)}개 선택`;
    $("library-download-selected").disabled =
      !selected.size || bundleRequest || bundle?.status === "preparing";
    $("library-download-all").disabled =
      !books.some(selectable) || bundleRequest || bundle?.status === "preparing";
    const visible = pagedBooks().filter(selectable),
      picked = visible.filter((book) => selected.has(String(book.id || book.bookId))).length;
    $("library-select-page").checked = visible.length > 0 && picked === visible.length;
    $("library-select-page").indeterminate = picked > 0 && picked < visible.length;
  }
  function reconcile(parent, children) {
    const wanted = new Set(children);
    for (const child of [...parent.children]) if (!wanted.has(child)) child.remove();
    children.forEach((child, index) => {
      if (parent.children[index] !== child)
        parent.insertBefore(child, parent.children[index] || null);
    });
  }
  function text(element, value) {
    const next = String(value ?? "");
    if (element.textContent !== next) element.textContent = next;
  }
  function render() {
    if (!UI.authenticated() || UI.view() !== "library" || document.hidden) return;
    const visible = pagedBooks(),
      total = visibleBooks().length,
      max = Math.max(1, Math.ceil(total / pageSize()));
    text(pageLabel, state.page + " / " + max + " · " + count(total) + "개 작품");
    previous.disabled = state.page <= 1;
    next.disabled = state.page >= max;
    const current = JSON.stringify([
      visible,
      state.page,
      pageSize(),
      [...selected],
      bundleRequest,
      bundle?.status,
      [...metadataRequests],
    ]);
    if (current === renderSignature) {
      selectState();
      return;
    }
    renderSignature = current;
    const cards = visible.map(bookCard);
    if (!cards.length) {
      if (!emptyCard)
        emptyCard = empty(
          "등록된 작품이 없습니다",
          "작품을 등록하면 정보와 수집 상태를 이곳에서 확인할 수 있습니다.",
        );
      cards.push(emptyCard);
    }
    reconcile($("books-list"), cards);
    const cacheLimit = Math.max(120, pageSize() * 3);
    while (cardEntries.size > cacheLimit) cardEntries.delete(cardEntries.keys().next().value);
    selectState();
  }
  function createBookCard(book, id) {
    const card = node("article", "book-card library-card");
    card.dataset.id = id;
    const cover = node("div", "library-cover"),
      fallback = node("span", "cover-fallback", "▤"),
      label = node("label", "discover-select"),
      check = node("input");
    check.type = "checkbox";
    label.append(check);
    cover.append(fallback, label);
    const entry = {
      book,
      card,
      cover,
      fallback,
      label,
      check,
      image: node("img"),
      failedImage: null,
      body: node("div", "library-content"),
      title: node("h2"),
      author: node("p", "book-author"),
      tags: node("div", "discover-tags"),
      tagSignature: "",
      profile: node("p", "book-meta book-profile-status"),
      synopsis: node("p", "book-synopsis"),
      completeness: node("strong", "book-completeness"),
      meta: node("p", "book-meta"),
      actions: node("div", "book-actions"),
      read: node("button", "secondary", "회차 열기 →"),
      download: node("a", "export-link", "TXT 받기"),
      noDownload: node("span", "export-link", "저장된 본문 없음"),
      retry: node("button", "quiet"),
      metadataRetry: node("button", "quiet metadata-retry", "작품 정보 다시 불러오기"),
    };
    entry.image.alt = "";
    entry.image.loading = "lazy";
    entry.image.decoding = "async";
    entry.image.width = 160;
    entry.image.height = 224;
    entry.image.addEventListener("error", () => {
      entry.failedImage = entry.image.getAttribute("src");
      entry.image.remove();
    });
    entry.profile.setAttribute("role", "status");
    entry.download.href = "/api/books/" + encodeURIComponent(id) + "/export/txt";
    entry.download.setAttribute("download", "");
    entry.noDownload.setAttribute("aria-disabled", "true");
    entry.read.addEventListener("click", () => openBook(entry.book));
    entry.retry.addEventListener("click", () => retryBook(entry.book));
    entry.metadataRetry.addEventListener("click", () => retryMetadata(entry.book));
    check.addEventListener("change", () => {
      if (!selectable(entry.book)) {
        check.checked = false;
        return;
      }
      if (check.checked) {
        if (selected.size >= 200) {
          check.checked = false;
          error("한 번에 최대 200개 작품을 선택하세요.");
          return;
        }
        selected.add(id);
      } else selected.delete(id);
      selectState();
    });
    card.append(cover, entry.body);
    return entry;
  }
  function bookCard(book) {
    const id = String(book.id || book.bookId);
    let entry = cardEntries.get(id);
    if (!entry) {
      entry = createBookCard(book, id);
    } else cardEntries.delete(id);
    cardEntries.set(id, entry);
    entry.book = book;
    const profileState = metadataState(book),
      stored = storedChapters(book),
      expected = book.expectedChapterCount;
    const eligible = selectable(book),
      missing =
        book.missingChapterCount ??
        (stored != null && expected != null ? Math.max(0, expected - stored) : null),
      failed = book.failedChapterCount ?? book.failureCount ?? 0;
    entry.check.disabled = !eligible;
    entry.check.checked = selected.has(id);
    entry.check.setAttribute("aria-label", (book.title || "작품") + " 선택");
    text(entry.title, book.title || "제목 없는 작품");
    text(entry.author, book.author || "작가 정보 없음");
    const thumbnail = book.thumbnail || "/api/books/" + encodeURIComponent(id) + "/thumbnail";
    const imageSource =
      (!profileState || profileState === "completed" || book.metadataFetchedAt) &&
      /^\/api\/books\/[A-Za-z0-9_-]{1,100}\/thumbnail$/.test(thumbnail)
        ? thumbnail +
          (book.metadataFetchedAt ? "?v=" + encodeURIComponent(book.metadataFetchedAt) : "")
        : null;
    if (imageSource && imageSource !== entry.image.getAttribute("src")) {
      entry.failedImage = null;
      entry.image.setAttribute("src", imageSource);
    }
    reconcile(entry.cover, [
      entry.fallback,
      ...(imageSource && imageSource !== entry.failedImage ? [entry.image] : []),
      entry.label,
    ]);
    const tags = [
      ...(Array.isArray(book.genres) ? book.genres : []),
      ...(Array.isArray(book.tags) ? book.tags : []),
      book.platform,
    ].filter(Boolean);
    const tagSignature = JSON.stringify(tags);
    if (tagSignature !== entry.tagSignature) {
      entry.tagSignature = tagSignature;
      entry.tags.replaceChildren(...tags.map((value) => node("span", "", value)));
    }
    const messages = {
      pending: "작품 정보를 불러오는 중… 완료되면 자동으로 표시됩니다.",
      failed: "작품 정보를 불러오지 못했습니다. 다시 불러올 수 있습니다.",
      deferred: "작품 정보 조회 대기 중입니다. 잠시 뒤 다시 불러오세요.",
    };
    const reason = book.metadataError ?? book.metadata?.error;
    text(
      entry.profile,
      (messages[profileState] || "") +
        (["failed", "deferred"].includes(profileState) &&
        typeof reason === "string" &&
        reason.trim()
          ? " " + reason
          : ""),
    );
    text(entry.synopsis, book.synopsis || "");
    text(
      entry.completeness,
      (stored == null ? "저장 회차 확인 전" : count(stored) + "화 저장") +
        (expected == null ? " · 전체 회차 미확인" : " / 총 " + count(expected) + "화"),
    );
    text(
      entry.meta,
      [
        { ongoing: "연재 중", completed: "완결" }[book.publication],
        stored === 0 ? "본문 수집 대기 · 저장된 회차가 생기면 읽을 수 있습니다." : null,
        missing !== null && missing > 0 ? "미수집 " + count(missing) + "화" : null,
        failed > 0 ? "실패 " + count(failed) + "화" : null,
      ]
        .filter(Boolean)
        .join(" · ") || "저장한 본문을 확인하세요.",
    );
    entry.read.disabled = stored === 0;
    text(entry.retry, missing > 0 && failed === 0 ? "누락 회차만 재수집" : "실패 회차만 재수집");
    entry.metadataRetry.disabled = metadataRequests.has(id);
    reconcile(entry.actions, [
      entry.read,
      eligible ? entry.download : entry.noDownload,
      ...(failed > 0 || (stored > 0 && missing > 0) ? [entry.retry] : []),
      ...(["failed", "deferred"].includes(profileState) ? [entry.metadataRetry] : []),
    ]);
    reconcile(entry.body, [
      entry.title,
      entry.author,
      entry.tags,
      ...(messages[profileState] ? [entry.profile] : []),
      ...(book.synopsis ? [entry.synopsis] : []),
      entry.completeness,
      entry.meta,
      entry.actions,
    ]);
    return entry.card;
  }
  function refresh({ force = true } = {}) {
    if (!UI.authenticated()) return Promise.resolve();
    if (!force && loaded && Date.now() - fetchedAt >= 0 && Date.now() - fetchedAt < 8000) {
      render();
      return Promise.resolve();
    }
    if (loading) return loading;
    const generation = UI.generation();
    const request = loadBooks(generation, mutationEpoch);
    const pending = request.finally(() => {
      if (loading === pending) loading = null;
    });
    loading = pending;
    return pending;
  }
  async function loadBooks(generation, epoch) {
    const data = await api("/api/books");
    if (!UI.authenticated() || generation !== UI.generation() || epoch !== mutationEpoch) return;
    fetchedAt = Date.now();
    loaded = true;
    const next = JSON.stringify(data);
    books = Array.isArray(data) ? data : [];
    const currentIds = new Set(books.map((book) => String(book.id || book.bookId)));
    for (const id of cardEntries.keys()) if (!currentIds.has(id)) cardEntries.delete(id);
    $("book-badge").textContent = count(books.length);
    if (next === signature) {
      render();
      return;
    }
    for (const id of selected)
      if (!books.some((book) => selectable(book) && String(book.id || book.bookId) === id))
        selected.delete(id);
    const genre = $("library-genre").value;
    const genres = [
      ...new Set(books.flatMap((book) => (Array.isArray(book.genres) ? book.genres : []))),
    ].sort();
    $("library-genre").replaceChildren(
      node("option", "", "전체 장르"),
      ...genres.map((value) => {
        const option = node("option", "", value);
        option.value = value;
        return option;
      }),
    );
    $("library-genre").firstChild.value = "";
    $("library-genre").value = genres.includes(genre) ? genre : "";
    if (next !== signature) {
      signature = next;
      render();
    }
  }
  async function retryMetadata(book) {
    const id = String(book.id || book.bookId),
      generation = UI.generation();
    if (metadataRequests.has(id) || !UI.authenticated()) return;
    metadataRequests.add(id);
    error();
    render();
    try {
      await api(`/api/books/${encodeURIComponent(id)}/metadata`, {
        method: "POST",
        body: JSON.stringify({}),
      });
      if (generation !== UI.generation()) return;
      await refresh();
    } catch (exception) {
      if (generation === UI.generation()) error(textError(exception));
    } finally {
      if (generation === UI.generation()) {
        metadataRequests.delete(id);
        render();
      }
    }
  }
  function updateBundle() {
    $("bundle-progress").textContent =
      bundle?.status === "ready"
        ? `${count(bundle.total)}개 작품 파일 준비 완료`
        : `파일 준비 중 · ${count(bundle?.processed)} / ${count(bundle?.total)}`;
    const ready = bundle?.status === "ready";
    $("bundle-download-link").hidden = !ready;
    if (ready)
      $("bundle-download-link").href = `/api/downloads/${encodeURIComponent(bundle.id)}/file`;
    $("bundle-error").textContent =
      bundle?.status === "failed" ? bundle.error || "파일을 준비하지 못했습니다." : "";
    $("library-bundle-status").hidden = !bundle;
    $("library-bundle-status").textContent = ready ? "준비된 ZIP 받기" : "ZIP 준비 상태";
    selectState();
  }
  async function pollBundle() {
    clearTimeout(bundleTimer);
    if (!bundle || bundle.status !== "preparing" || !UI.authenticated() || document.hidden) return;
    const id = bundle.id,
      generation = UI.generation();
    try {
      const result = await api(`/api/downloads/${encodeURIComponent(id)}`);
      if (generation !== UI.generation() || id !== bundle?.id) return;
      bundle = { ...bundle, ...result };
      updateBundle();
      if (bundle.status === "ready")
        UI.toast("ZIP 파일이 준비됐습니다. 내려받기 버튼을 눌러 저장하세요.");
    } catch (exception) {
      $("bundle-error").textContent = textError(exception);
    }
    if (bundle?.status === "preparing" && UI.authenticated())
      bundleTimer = setTimeout(pollBundle, 2000);
  }
  async function prepareBundle(ids = [], all = false) {
    if (bundleRequest) return;
    if (!all && (!ids.length || ids.length > 200)) {
      error("작품을 1개 이상, 최대 200개 선택하세요.");
      return;
    }
    if (bundle?.status === "preparing") {
      $("bundle-dialog").showModal();
      return;
    }
    const generation = UI.generation();
    bundleRequest = true;
    selectState();
    error();
    $("bundle-error").textContent = "";
    $("bundle-download-link").hidden = true;
    $("bundle-progress").textContent = "파일 준비 요청 중…";
    $("bundle-dialog").showModal();
    try {
      const result = await api("/api/downloads", {
        method: "POST",
        body: JSON.stringify(all ? { all: true } : { bookIds: ids }),
      });
      if (generation !== UI.generation()) return;
      bundle = result;
      updateBundle();
      if (bundle.status === "preparing") bundleTimer = setTimeout(pollBundle, 2000);
    } catch (exception) {
      $("bundle-error").textContent = textError(exception);
    } finally {
      bundleRequest = false;
      selectState();
    }
  }
  function failuresDialog(context, failures) {
    failureContext = context;
    $("failures-title").textContent =
      `${context.title || "작품"} · ${context.missingOnly ? "누락 회차 재수집" : "실패 회차 재수집"}`;
    $("failures-error").textContent = "";
    const list = Array.isArray(failures) ? failures : [];
    $("failures-note").textContent = context.missingOnly
      ? "목차에서 누락된 회차만 확인하여 수집합니다. 저장된 정상 회차는 유지됩니다."
      : list.length
        ? "재수집할 실패 회차를 선택하세요. 저장된 정상 회차는 유지됩니다."
        : "실패 회차 목록이 확인되지 않아 실패 작품을 다시 수집합니다.";
    $("failures-submit").textContent = context.missingOnly
      ? "누락 회차 재수집"
      : list.length
        ? "선택 회차 재수집"
        : "실패 작품 다시 수집";
    $("failures-list").replaceChildren(
      ...list.map((chapter) => {
        const label = node("label", "failure-row"),
          check = node("input");
        check.type = "checkbox";
        check.checked = true;
        check.value = String(chapter.id || chapter.chapterId);
        label.append(
          check,
          node(
            "span",
            "",
            `${chapter.number == null ? "" : chapter.number + "화 · "}${chapter.title || "제목 없음"}${chapter.error ? " · " + chapter.error : ""}`,
          ),
        );
        return label;
      }),
    );
    $("failures-dialog").showModal();
  }
  function retryJob(job) {
    failuresDialog({ type: "job", id: job.id, title: job.title }, job.failedChapters);
  }
  async function retryBook(book) {
    const id = book.id || book.bookId;
    try {
      const failures = await api(`/api/books/${encodeURIComponent(id)}/failures`);
      if (!Array.isArray(failures) || !failures.length) {
        const stored = book.storedChapterCount ?? book.chapterCount ?? book.totalChapters;
        const missing =
          book.missingChapterCount ??
          (stored != null && book.expectedChapterCount != null
            ? Math.max(0, book.expectedChapterCount - stored)
            : 0);
        if (missing > 0) {
          failuresDialog({ type: "book", id, title: book.title, missingOnly: true }, []);
          return;
        }
        error("이 작품에 확인된 실패·누락 회차가 없습니다.");
        return;
      }
      failuresDialog({ type: "book", id, title: book.title }, failures);
    } catch (exception) {
      error(textError(exception));
    }
  }
  $("failures-submit").addEventListener("click", async () => {
    if (!failureContext) return;
    $("failures-submit").disabled = true;
    $("failures-error").textContent = "";
    try {
      const chapterIds = [...$("failures-list").querySelectorAll("input:checked")].map(
        (input) => input.value,
      );
      if ($("failures-list").children.length && !chapterIds.length)
        throw new Error("재수집할 회차를 선택하세요.");
      const context = failureContext,
        body = chapterIds.length ? { chapterIds } : {};
      const job = await api(
        context.type === "job"
          ? `/api/jobs/${encodeURIComponent(context.id)}/action`
          : `/api/books/${encodeURIComponent(context.id)}/retry-failed`,
        {
          method: "POST",
          body: JSON.stringify(context.type === "job" ? { action: "retry_failed", ...body } : body),
        },
      );
      UI.addJob(job);
      $("failures-dialog").close();
      UI.toast("실패 회차 재수집을 대기열에 추가했습니다.");
    } catch (exception) {
      $("failures-error").textContent = textError(exception);
    } finally {
      $("failures-submit").disabled = false;
    }
  });
  $("library-select-all").addEventListener("click", () => {
    selected.clear();
    const eligible = books.filter(selectable);
    for (const book of eligible.slice(0, 200)) selected.add(String(book.id || book.bookId));
    if (eligible.length > 200)
      error("처음 200개 작품을 선택했습니다. 한 번에 최대 200개씩 내려받으세요.");
    render();
  });
  $("library-select-page").addEventListener("change", () => {
    for (const book of pagedBooks().filter(selectable)) {
      const id = String(book.id || book.bookId);
      if ($("library-select-page").checked) {
        if (selected.size < 200) selected.add(id);
      } else selected.delete(id);
    }
    render();
  });
  $("library-clear").addEventListener("click", () => {
    selected.clear();
    render();
  });
  $("library-download-selected").addEventListener("click", () => prepareBundle([...selected]));
  $("library-download-all").addEventListener("click", () => prepareBundle([], true));
  const search = window.CollectorPerformance.debounce(() => {
    state.page = 1;
    render();
  });
  $("library-query").addEventListener("input", search);
  $("library-genre").addEventListener("change", () => {
    state.page = 1;
    render();
  });
  document.addEventListener("collector:preferences", () => {
    state.page = 1;
    render();
  });
  document.addEventListener("collector:mutated", () => {
    mutationEpoch++;
    fetchedAt = 0;
    loaded = false;
    loading = null;
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(bundleTimer);
    else {
      render();
      pollBundle();
    }
  });
  document.addEventListener("collector:view", (event) => {
    if (event.detail === "library") render();
  });
  $("library-bundle-status").addEventListener("click", () => {
    $("bundle-dialog").showModal();
    updateBundle();
  });
  $("refresh-library").addEventListener("click", async () => {
    $("refresh-library").disabled = true;
    try {
      await refresh();
      UI.toast("보관함을 새로고침했습니다.");
    } catch (exception) {
      error(textError(exception));
    } finally {
      $("refresh-library").disabled = false;
    }
  });
  $("reader-dialog").addEventListener("close", () => {
    state.selectedBook = null;
    state.chapterId = null;
  });
  $("failures-dialog").addEventListener("close", () => {
    failureContext = null;
  });
  document.addEventListener("collector:auth", (event) => {
    if (!event.detail) {
      clearTimeout(bundleTimer);
      bundle = null;
      selected.clear();
      metadataRequests.clear();
      loading = null;
      books = [];
      signature = "";
      renderSignature = "";
      mutationEpoch++;
      fetchedAt = 0;
      loaded = false;
      cardEntries.clear();
      emptyCard = null;
      state.page = 1;
      search.cancel();
      $("books-list").replaceChildren();
      failureContext = null;
    }
  });
  window.CollectorLibrary = { refresh, retryJob };
})();
