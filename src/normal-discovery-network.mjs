// Observes only public requests that the website's ordinary controls generate.
// It never fetches an API directly or reads its JSON/session/cookie contents.
async function finishPublicResponse(response) {
  let timer;
  try {
    return await Promise.race([
      response.finished?.(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () =>
            reject(
              Object.assign(
                new Error("작품 목록 응답을 기다리는 시간이 초과됐습니다."),
                { code: "PUBLIC_RESPONSE_TIMEOUT" },
              ),
            ),
          15000,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
export function watchNormalDiscoveryResponses(owner, page, source) {
  const origin = new URL(owner.transportUrl(source)).origin;
  const inFlight = new Set();
  const pending = new Set();
  const requestStarts = new WeakMap();
  let started = 0,
    completed = 0,
    problem;
  let completedURLs = [];
  const listRequest = (request) => {
    const url = new URL(request.url());
    return (
      url.origin === origin &&
      url.pathname === "/api/novel-list" &&
      ["xhr", "fetch"].includes(request.resourceType?.())
    );
  };
  const onRequest = (request) => {
    if (!listRequest(request)) return;
    started++;
    requestStarts.set(request, started);
    inFlight.add(request);
  };
  const onResponse = (response) => {
    const request = response.request?.();
    if (!request || !listRequest(request)) return;
    const task = (async () => {
      await owner.sourceGate.assertResponse(response, "newtoki1.org");
      const failure = await finishPublicResponse(response);
      if (failure) throw new Error("작품 목록의 응답을 완료하지 못했습니다.");
      completed++;
      completedURLs = [
        ...completedURLs,
        { revision: completed, start: requestStarts.get(request), url: request.url() },
      ].slice(-50);
    })()
      .catch((error) => {
        problem ||= error;
      })
      .finally(() => {
        inFlight.delete(request);
      });
    pending.add(task);
    task.finally(() => pending.delete(task));
  };
  const onFailed = (request) => {
    if (!inFlight.delete(request)) return;
    // The frontend may cancel its superseded list request while a new one runs.
    if (request.failure?.()?.errorText !== "net::ERR_ABORTED")
      problem ||= new Error("작품 목록 요청에 실패했습니다.");
  };
  page.on?.("request", onRequest);
  page.on?.("response", onResponse);
  page.on?.("requestfailed", onFailed);
  return {
    enabled: typeof page.on === "function",
    get started() {
      return started;
    },
    get completed() {
      return completed;
    },
    get inFlight() {
      return inFlight.size;
    },
    completedFor(current, since, { page, startedAfter = -1 } = {}) {
      const expected = new URL(current);
      return completedURLs.some((item) => {
        if (item.revision <= since || !(item.start > startedAfter)) return false;
        const actual = new URL(item.url);
        if (page !== undefined && Number(actual.searchParams.get("page") || 1) !== page) return false;
        return ["q", "g", "p", "t", "sort", "page"].every((key) => {
          // Client-side pager controls can update the DOM without rewriting
          // the document URL. Use its observed page, and only compare filters
          // the public document URL actually specifies.
          if (page !== undefined && (key === "page" || !expected.searchParams.has(key))) return true;
          const value = (url) =>
            url.searchParams.get(key) || (key === "page" ? "1" : "");
          return value(actual) === value(expected);
        });
      });
    },
    async check() {
      await Promise.all([...pending]);
      if (problem) throw problem;
    },
    close() {
      page.off?.("request", onRequest);
      page.off?.("response", onResponse);
      page.off?.("requestfailed", onFailed);
    },
  };
}
