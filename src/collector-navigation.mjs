export async function navigate(
  page,
  url,
  signal,
  { preserveAuthentication = false } = {},
  helpers,
) {
  const { makeBookId, abortIfNeeded, readReaderDocument, attention } = helpers;
  makeBookId(url);
  const transport = this.viewerOrigins?.resolve(url) || url;
  if (!preserveAuthentication || !this.navigationAuthentication.has(page))
    this.navigationAuthentication.set(page, { attempted: false });
  for (let reload = 0; reload < 2; reload++) {
    abortIfNeeded(signal);
    await this.backoff?.wait(signal);
    abortIfNeeded(signal);
    const response = await page.goto(transport, {
      waitUntil: "domcontentloaded",
      timeout: 45000,
    });
    abortIfNeeded(signal);
    const problem = await this.responseProblem(response);
    if (
      problem &&
      (![401, 403].includes(problem.httpStatus) || !this.authenticatePage)
    )
      throw problem;
    try {
      if (this.viewerOrigins)
        this.viewerOrigins.assertNavigation(url, page.url());
      else makeBookId(page.url());
    } catch {
      throw attention(
        "사이트가 다른 페이지로 이동했습니다. 사이트 접근 상태를 확인하세요.",
        "site_blocked",
      );
    }
    let reader = await page.evaluate(readReaderDocument);
    if (await this.captchaReaders?.get(page)?.settle()) {
      abortIfNeeded(signal);
      reader = await page.evaluate(readReaderDocument);
      if (reader.novelCaptcha) return;
    }
    if (reader.challenge || reader.verificationKind === "captcha")
      throw attention(
        reader.challenge
          ? "사이트 보안 확인이 표시됐습니다. CAPTCHA 확인이 필요합니다."
          : "CAPTCHA 확인이 필요합니다.",
        "captcha",
      );
    const authentication = await this.authenticateNavigation(
      page,
      signal,
      !!problem || reader.verificationRequired,
    );
    if (authentication?.authenticated && !authentication.reused) continue;
    if (problem) throw problem;
    if (reader.verificationRequired)
      throw attention(
        reader.verificationReason || reader.notice,
        "authentication",
      );
    return;
  }
  throw attention(
    "사이트 본문 접근 상태를 확인할 수 없습니다.",
    "authentication",
  );
}
