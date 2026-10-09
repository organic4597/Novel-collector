import { ChapterTiming } from "./timing.mjs";
import { cleanMessage } from "./store.mjs";

function abortIfNeeded(signal) {
  if (signal?.aborted)
    throw Object.assign(new Error("작업 중단"), {
      name: "AbortError",
      code: "ABORTED",
    });
}

const delay = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(Object.assign(new Error("작업 중단"), { name: "AbortError" }));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("작업 중단"), { name: "AbortError" }));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export async function runCollection(job, hooks, signal, bookId) {
  const webtoon=job.contentType==="webtoon";
  if (this.collectionRun)
    throw new Error("이 브라우저에서 수집 작업이 이미 진행 중입니다.");
  const operation = { pooled: !!this.contextPool };
  this.collectionRun = operation;
  let context,webtoonPage;
  const onAbort = () => {
    if(webtoon)void webtoonPage?.close().catch(()=>{});
    void this.close();
  };
  try {
    await this.closeWork;
    abortIfNeeded(signal);
    signal?.addEventListener("abort", onAbort, { once: true });
    let page,
      mainHost = null,
      connect = null;
    if (operation.pooled) {
      const target = new URL(webtoon?job.url:this.viewerOrigins?.resolve(job.url) || job.url);
      if (
        ![1, 2].includes(this.slotId) ||
        target.protocol !== "https:" ||
        target.username ||
        target.password ||
        target.port
      )
        throw new Error("수집 브라우저 슬롯과 HTTPS 사이트 주소를 확인하세요.");
      mainHost = target.hostname;
      connect = async () => {
        const lease = await this.contextPool.acquire({
          slot: this.slotId,
          origin: target.origin,
          open: async () => {
            const created = await this.openContext();
            try {
              return { context: created, page: await created.newPage() };
            } catch (error) {
              await created.close().catch(() => {});
              throw error;
            }
          },
        });
        this.contextLease = lease;
        context = lease.context;
        page = lease.page;
        this.authenticationChecked = false;
        this.navigationAuthentication = new WeakMap();
      };
      await connect();
    } else context = await this.openContext();
    this.context = context;
    this.availability = { available: true, lastError: null };
    abortIfNeeded(signal);
    await this.installNetworkGuard(context, { allowedMainHost: mainHost,allowImages:webtoon });
    if (!page) page = await context.newPage();
    if(webtoon)webtoonPage=page;
    abortIfNeeded(signal);
    const catalog = await this.collectionPlan(page, job, hooks, signal, bookId);
    abortIfNeeded(signal);
    const displayTitle = job.title || catalog.title;
    const activeJob = { ...job, title: displayTitle, bookId };
    const { chapters, allChapters, ...metadata } = catalog;
    const sourceUrl = new URL(job.url);
    sourceUrl.pathname = webtoon?sourceUrl.pathname.split("/").slice(0,3).join("/"):`/novel/${sourceUrl.pathname.match(/^\/novel\/(\d+)/)[1]}`;
    sourceUrl.search = "";
    sourceUrl.hash = "";
    const fullCatalog = {
      ...metadata,
      url: sourceUrl.href,
      chapters: allChapters,
      catalogVerifiedAt: catalog.catalogVerifiedAt || new Date().toISOString(),
    };
    await this.store.upsertBook(bookId, { ...metadata, url: sourceUrl.href });
    await this.store.writeCatalog(bookId, fullCatalog);
    if (this.onMetadata) {
      try {
        await this.onMetadata(bookId, { ...metadata, url: sourceUrl.href });
      } catch (error) {
        await hooks.event(
          "warn",
          `작품 메타데이터 연결 실패: ${cleanMessage(error.message)}`,
        );
      }
    }
    let completed = 0,
      skipped = 0,
      failed = 0;
    const total = chapters.length,
      failedChapters = [],
      timing = new ChapterTiming({ clock: this.clock });
    const resumeIndex = job.backoffResumeChapterId
      ? chapters.findIndex(
          (chapter) => chapter.id === job.backoffResumeChapterId,
        )
      : -1;
    const previousFailures = new Map(
      (resumeIndex > 0 ? await this.store.listFailures(bookId) : []).map(
        (chapter) => [chapter.id, chapter],
      ),
    );
    const cache = new Set();
    for (const [index, chapter] of chapters.entries()) {
      const reusable=(!job.overwrite && !job.retryOnlyFailed)||(index<resumeIndex&&!previousFailures.has(chapter.id));
      const saved=reusable?(webtoon?await this.storedChapter(bookId,chapter,true,job.presetHash):!!(await this.store.readChapter(bookId,chapter.id))?.text):false;
      if(saved)cache.add(chapter.id);
    }
    let remainingAttempts = total - cache.size,
      blockedReason = null;
    await hooks.report({
      title: displayTitle,
      bookId,
      total,
      completed,
      skipped,
      failed,
      phase: "회차 수집 준비",
      failedChapters,
      ...timing.estimate(remainingAttempts),
    });
    for (let index = 0; index < chapters.length; index++) {
      const chapter = chapters[index];
      abortIfNeeded(signal);
      if(await hooks.shouldYield?.()){
        abortIfNeeded(signal);
        await hooks.event("info","현재 회차 저장 완료 · 변경된 수집 순서로 대기");
        return{title:displayTitle,bookId,total,completed,skipped,failed,failedChapters,captcha:null,
          status:"queued",phase:"수집 순서 변경 대기",resumeCatalog:true,backoffResumeChapterId:chapter.id,
          ...timing.estimate(remainingAttempts)};
      }
      await hooks.report({
        currentChapter: `${chapter.number} · ${chapter.title}`,
        currentChapterId: chapter.id,
        phase: "본문 읽는 중",
        lastActivity: new Date().toISOString(),
      });
      if (index < resumeIndex && previousFailures.has(chapter.id)) {
        const old = previousFailures.get(chapter.id);
        failed++;
        if (!cache.has(chapter.id)) remainingAttempts--;
        failedChapters.push({ ...chapter, error: old.message, code: old.code });
        await hooks.event(
          "info",
          `${chapter.number}화 · 기록된 실패 회차 건너뜀 (선택 재수집 가능)`,
        );
        await hooks.report({
          completed,
          skipped,
          failed,
          failedChapters: [...failedChapters],
        });
        continue;
      }
      if (cache.has(chapter.id)) {
        skipped++;
        await this.store.clearFailure(bookId, chapter.id);
        await hooks.event("info", `${chapter.number}화 · 저장된 본문 사용`);
      } else if (chapter.notReady && !job.retryOnlyFailed) {
        failed++;
        remainingAttempts--;
        const error = Object.assign(
          new Error("사이트에서 아직 준비중인 회차입니다."),
          {
            code: "CONTENT_NOT_READY",
          },
        );
        failedChapters.push(
          await this.saveFailure(bookId, chapter, error, job.id),
        );
        await hooks.event(
          "warn",
          `${chapter.number}화 · 준비중 회차 건너뜀 (나중에 실패분 재수집 가능)`,
        );
      } else {
        if (this.contextLease?.refreshDue) {
          // Renew only between chapters, after the previous read/write has
          // finished. The normal navigation handles any expired site login.
          await this.contextLease.release({ discard: true });
          this.contextLease = null;
          this.context = null;
          abortIfNeeded(signal);
          await connect();
          this.context = context;
          abortIfNeeded(signal);
           await this.installNetworkGuard(context, { allowedMainHost: mainHost,allowImages:webtoon });
          await hooks.event("info", "12시간 브라우저 연결 갱신 완료");
        }
        const attemptStart = this.clock();
        let sourceFailed = true;
        try {
          const imageChapter=webtoon?await this.chapterImages(page,activeJob,chapter,signal,progress=>hooks.report({phase:"웹툰 이미지 저장 중",...progress})):null;
          const text = webtoon?null:await this.chapterText(page, chapter, signal, {
            onProgress: async (progress) => {
              abortIfNeeded(signal);
              const elapsed = Math.max(0, this.clock() - attemptStart);
              await hooks.report({
                captcha: progress,
                phase: progress.active ? `CAPTCHA 자동 ${progress.attempt}/${progress.maxAttempts} · ${progress.stage}` : "본문 읽는 중",
                ...timing.estimate(remainingAttempts, { extraMs: elapsed + (progress.active ? 20000 : 0) }),
              });
              await hooks.event(progress.stage === "FAILED" ? "warn" : "info",
                `CAPTCHA ${progress.attempt}/${progress.maxAttempts} · ${progress.stage} · ${Math.round(progress.elapsedMs || 0)}ms${progress.code ? ` · ${progress.code}` : ""}`);
            },
          });
          abortIfNeeded(signal);
          if (!webtoon&&Buffer.byteLength(text, "utf8") > 2 * 1024 * 1024)
            throw new Error("회차 본문 크기가 제한을 초과했습니다.");
          sourceFailed = false;
          await hooks.requestSuccess?.();
          if(webtoon)await this.store.writeWebtoonChapter(bookId,chapter.id,{...chapter,...imageChapter});
          else await this.store.writeChapter(bookId, chapter.id, {
            ...chapter,
            text,
          });
          completed++;
          await this.store.clearFailure(bookId, chapter.id);
          await hooks.event(
            "info",
            webtoon?`${chapter.number}화 저장 완료 · ${imageChapter.savedImages}장`:`${chapter.number}화 저장 완료 · ${text.length.toLocaleString("ko-KR")}자`,
          );
        } catch (error) {
          abortIfNeeded(signal);
          failed++;
          failedChapters.push(
            await this.saveFailure(bookId, chapter, error, job.id),
          );
          await hooks.event(
            "error",
            `${chapter.number}화 수집 실패: ${error.message}`,
          );
          if (error.code === "NEEDS_ATTENTION") {
            blockedReason = cleanMessage(error.message);
            for (const deferred of chapters.slice(index + 1)) {
              if (cache.has(deferred.id)) {
                skipped++;
                continue;
              }
              failed++;
              failedChapters.push(
                await this.saveFailure(
                  bookId,
                  deferred,
                  Object.assign(
                    new Error(
                      "사이트 확인이 필요하여 해당 작품의 추가 요청을 보류했습니다.",
                    ),
                    { code: "DEFERRED_SITE_BLOCK" },
                  ),
                  job.id,
                ),
              );
            }
          }
          if (sourceFailed) await hooks.requestFailure?.(error);
          abortIfNeeded(signal);
        }
        if (!blockedReason) await delay(this.delayMs, signal);
        timing.record(this.clock() - attemptStart);
        remainingAttempts--;
      }
      await hooks.report({
        completed,
        skipped,
        failed,
        captcha: null,
        phase: "회차 파일 저장 완료",
        lastActivity: new Date().toISOString(),
        failedChapters: [...failedChapters],
        ...timing.estimate(blockedReason ? 0 : remainingAttempts),
      });
      if (blockedReason) break;
    }
    await hooks.report({ phase: "합본 파일 생성 중" });
    const exportChapters = allChapters.filter(
      (chapter) =>
        (job.startEpisode == null || chapter.number >= job.startEpisode) &&
        (job.endEpisode == null || chapter.number <= job.endEpisode),
    );
    const output = await this.exportBook(activeJob, exportChapters);
    return {
      ...output,
      title: displayTitle,
      bookId,
      total,
      completed,
      skipped,
      failed,
      failedChapters,
      blockedReason,
      backoffResumeChapterId: null,
      resumeCatalog: false,
      ...timing.estimate(0),
      phase: "수집 완료",
      status: blockedReason
        ? "needs_attention"
        : failed
          ? completed + skipped
            ? "completed_with_errors"
            : "failed"
          : "completed",
      error:
        blockedReason ||
        (failed
          ? `${failed}개 회차를 수집하지 못했습니다. 로그에서 원인을 확인하세요.`
          : null),
    };
  } catch (error) {
    if (!context)
      this.availability = {
        available: false,
        lastError: "서버 브라우저 실행 실패. 서버 로그를 확인하세요.",
      };
    throw error;
  } finally {
    signal?.removeEventListener("abort", onAbort);
    if (this.collectionRun === operation) this.collectionRun = null;
    if(webtoon&&signal?.aborted&&this.contextLease){await this.contextLease.release({discard:true});this.contextLease=null;this.context=null;}
    await this.close();
  }
}
