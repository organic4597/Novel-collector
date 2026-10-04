"use strict";
(() => {
  const $ = (id) => document.getElementById(id);
  const phases = {
    queued: "차례를 기다리는 중",
    starting: "수집 준비 중",
    catalog: "목차 확인 중",
    collecting: "본문 수집 중",
    extracting: "본문 추출 중",
    downloading: "본문 수집 중",
    exporting: "파일 생성 중",
    completed: "수집 완료",
    waiting_browser: "PC 브라우저 연결 대기",
    paused: "일시 중지",
    cancelled: "취소됨",
    failed: "수집 실패",
    needs_attention: "사용자 확인 필요",
  };
  const actionRules = {
    queued: [
      ["pause", "일시 중지"],
      ["cancel", "취소"],
    ],
    running: [
      ["pause", "일시 중지"],
      ["cancel", "취소"],
    ],
    paused: [
      ["resume", "계속 수집"],
      ["cancel", "취소"],
    ],
    needs_attention: [
      ["resume", "계속 수집"],
      ["retry", "재시도"],
      ["cancel", "취소"],
    ],
    failed: [["retry", "재시도"]],
    cancelled: [["retry", "다시 수집"]],
    completed: [["retry", "다시 수집"]],
    completed_with_errors: [["retry", "재시도"]],
  };
  function renderBackoff(status, { node, count, date, safeString, number }) {
    const backoff = status.backoff;
    const panel = $("queue-backoff");
    panel.hidden = !backoff?.active;
    if (!backoff?.active) {
      panel.replaceChildren();
      return;
    }
    const until = Date.parse(backoff.until),
      seconds = Number.isFinite(until)
        ? Math.max(0, Math.ceil((until - Date.now()) / 1000))
        : number(backoff.remainingSeconds);
    const remaining = `${Math.floor(seconds / 60)}분 ${Math.floor(seconds % 60)}초`;
    const title = node(
      "strong",
      "",
      `서버 요청 제한으로 대기 중 · 남은 ${remaining}`,
    );
    const deadline = node(
      "p",
      "",
      `${status.queuePaused ? "요청 대기 종료" : "자동 재시도"} 시각 ${date(backoff.until)}`,
    );
    const hint = node(
      "p",
      "",
      `${status.queuePaused ? "대기가 끝나도 전체 일시정지는 유지됩니다. " : ""}일반 본문 실패는 기록 후 다음 회차로 넘어갑니다. 이 대기는 HTTP 429·Retry-After 등 서버가 명시한 요청 제한이며 CAPTCHA 수동 대기와는 별도입니다. 전체 시작을 눌러도 대기 시간 끝난 뒤 시작합니다. 저장 파일 내려받기는 계속 사용할 수 있습니다.`,
    );
    panel.replaceChildren(title, deadline, hint);
    if (backoff.reason)
      panel.append(
        node(
          "p",
          "queue-backoff-reason",
          window.CollectorPerformance.sourceNotice(backoff.reason),
        ),
      );
  }
  window.CollectorQueueUI = { renderBackoff, phases, actionRules };
})();
