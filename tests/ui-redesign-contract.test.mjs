import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";

// Captured from release 1.0.0.11 before redesign: existing controls remain reachable.
const originalIds =
  `login-view login-form login-password login-error login-recovery recovery-remote-guide recovery-local-panel recovery-warning
recovery-ack recovery-phrase recovery-phrase-guide recovery-reset recovery-status recovery-result recovery-save recovery-saved
recovery-next app-view nav-queue queue-badge nav-discover nav-history history-badge nav-library
book-badge nav-settings nav-activity nav-presets nav-releases logout-button connection-dot connection-label
last-refresh update-notice update-notice-text update-banner-history update-banner-apply global-error queue-view queue-start-all
queue-pause-all add-batch-button add-job-button queue-backoff site-attention-banner site-attention-heading site-attention-reason site-attention-instructions
site-attention-actions active-summary runner-summary waiting-summary saved-summary agent-summary agent-note jobs-count
jobs-list history-view history-count history-list presets-view preset-refresh preset-content-type preset-name
preset-v3-options preset-source-ongoing preset-source-completed preset-source-search preset-catalog-order preset-page-tree preset-kind preset-guide-description
preset-guide-focus preset-target-field preset-field-help preset-target-attribute preset-target-multiple preset-field-gallery preset-bookmarklet preset-copy-bookmarklet
preset-bookmarklet-code preset-connect-form preset-source-url preset-connect preset-connection-status preset-connection-error preset-source-open-link preset-file
preset-json preset-copy-json preset-save preset-cancel-edit preset-status preset-error preset-activation preset-binding-status
preset-check-listing-url preset-check-listing preset-check-listing-status preset-check-detail-url preset-check-detail preset-check-detail-status preset-check-reader-url preset-check-reader
preset-check-reader-status preset-apply preset-unbind preset-default preset-add-default preset-default-help preset-count preset-list
activity-view activity-level activity-scope activity-search activity-pause activity-refresh activity-error activity-count
activity-list activity-older discover-view discover-form discover-content-type discover-search-type discover-query discover-genre
discover-platform discover-publication discover-sort discover-search discover-min discover-max discover-unknown discover-select-page
discover-selected discover-clear discover-check-selected discover-format discover-add-selected discover-message discover-error discover-list
discover-prev discover-page discover-next work-dialog work-close work-cover work-cover-fallback work-title
work-status work-error work-author work-platform work-publication work-episodes work-genres work-tags
work-synopsis work-format work-add work-select work-refresh work-source work-back library-view
refresh-library library-query library-genre library-select-page library-select-all library-selected library-clear library-download-selected
library-download-all library-bundle-status library-error books-list releases-view release-history-refresh release-history-version release-history-status
release-history-error release-history-list settings-view update-current update-latest update-repository update-checked update-check
update-apply update-history-open update-release-link update-progress update-error update-task-state update-task-step update-log-panel
update-log-status update-log settings-save-state settings-preset-light settings-preset-balanced settings-reset settings-form settings-collection
settings-concurrency settings-delay settings-format settings-display settings-refresh settings-page-size settings-thumbnail settings-density
settings-error settings-save-message settings-save password-form settings-security password-current password-current-toggle password-new
password-new-toggle password-confirm password-confirm-toggle password-error password-result password-save settings-system system-info-refresh
system-operation system-book-count system-chapter-count system-body-bytes system-disk-free system-uptime system-backoff system-info-updated
system-info-error site-account-card site-account-config-state site-account-form site-account-host site-account-load site-account-username site-account-password
site-account-pin site-account-enabled site-account-error site-account-save site-account-test site-account-delete site-account-result site-account-delete-confirmation
site-account-delete-host site-account-delete-confirm site-account-delete-cancel settings-export settings-import-file settings-import-text settings-import-preview settings-import-apply
settings-import-summary settings-transfer-error events-panel events-title close-events events-list logs-toggle job-dialog
job-form job-url job-title job-from job-to job-schedule job-format job-executor
executor-help job-overwrite job-error job-submit batch-dialog batch-form batch-urls batch-from
batch-to batch-format batch-schedule batch-overwrite batch-result batch-error batch-submit bundle-dialog
bundle-progress bundle-error bundle-download-link failures-dialog failures-title failures-note failures-list failures-error
failures-submit reader-dialog reader-book-title chapter-count chapter-list reader-chapter-title reader-meta reader-text
captcha-session-dialog captcha-session-title captcha-session-close captcha-session-viewer captcha-session-status captcha-session-transport captcha-session-large captcha-session-error
captcha-session-frame captcha-session-text-form captcha-session-text captcha-session-send captcha-session-retry captcha-session-apply toast`.split(
    /\s+/,
  );
const originalControls = [
  ["login-form", "form", "", null, null, null, null, null],
  ["login-password", "input", "password", true, null, null, null, null],
  ["recovery-ack", "input", "checkbox", false, null, null, null, null],
  ["recovery-phrase", "input", "", false, null, null, null, null],
  ["recovery-saved", "input", "checkbox", false, null, null, null, null],
  [
    "preset-content-type",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["novel", "webtoon"],
  ],
  ["preset-name", "input", "", false, null, null, "80", null],
  ["preset-source-ongoing", "input", "", false, null, null, "300", null],
  ["preset-source-completed", "input", "", false, null, null, "300", null],
  ["preset-source-search", "input", "", false, null, null, "300", null],
  [
    "preset-catalog-order",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["newest-first", "oldest-first"],
  ],
  [
    "preset-kind",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["listing", "detail", "reader"],
  ],
  ["preset-target-field", "select", "", false, null, null, null, []],
  [
    "preset-target-attribute",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["text", "href", "src", "data-src", "imageUrl"],
  ],
  [
    "preset-target-multiple",
    "input",
    "checkbox",
    false,
    null,
    null,
    null,
    null,
  ],
  ["preset-bookmarklet-code", "textarea", "", false, null, null, null, null],
  ["preset-connect-form", "form", "", null, null, null, null, null],
  ["preset-source-url", "input", "url", true, null, null, "2000", null],
  ["preset-file", "input", "file", false, null, null, null, null],
  ["preset-json", "textarea", "", false, null, null, "32768", null],
  ["preset-check-listing-url", "input", "url", false, null, null, "2000", null],
  ["preset-check-detail-url", "input", "url", false, null, null, "2000", null],
  ["preset-check-reader-url", "input", "url", false, null, null, "2000", null],
  ["preset-default", "select", "", false, null, null, null, [""]],
  [
    "activity-level",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["all", "error", "warn", "info", "debug"],
  ],
  [
    "activity-scope",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["all", "api", "dashboard", "update", "instance", "service"],
  ],
  ["activity-search", "input", "search", false, null, null, null, null],
  ["discover-form", "form", "", null, null, null, null, null],
  [
    "discover-content-type",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["novel", "webtoon"],
  ],
  [
    "discover-search-type",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["title", "author"],
  ],
  ["discover-query", "input", "", false, null, null, null, null],
  ["discover-genre", "select", "", false, null, null, null, [""]],
  ["discover-platform", "select", "", false, null, null, null, [""]],
  [
    "discover-publication",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["all", "ongoing", "completed"],
  ],
  [
    "discover-sort",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["updated", "new", "episodes", "views", "rating", "bookmarks"],
  ],
  ["discover-min", "input", "number", false, "0", null, null, null],
  ["discover-max", "input", "number", false, "0", null, null, null],
  ["discover-unknown", "input", "checkbox", false, null, null, null, null],
  ["discover-select-page", "input", "checkbox", false, null, null, null, null],
  ["discover-format", "select", "", false, null, null, null, ["txt", "epub"]],
  ["work-dialog", "dialog", "", null, null, null, null, null],
  ["work-format", "select", "", false, null, null, null, ["txt", "epub"]],
  ["library-query", "input", "", false, null, null, null, null],
  ["library-genre", "select", "", false, null, null, null, [""]],
  ["library-select-page", "input", "checkbox", false, null, null, null, null],
  ["release-history-version", "select", "", false, null, null, null, [""]],
  ["settings-form", "form", "", null, null, null, null, null],
  ["settings-concurrency", "select", "", false, null, null, null, ["1", "2"]],
  ["settings-delay", "input", "number", true, "500", "10000", null, null],
  ["settings-format", "select", "", false, null, null, null, ["txt", "epub"]],
  [
    "settings-refresh",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["2000", "5000", "10000", "30000"],
  ],
  [
    "settings-page-size",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["12", "24", "48", "96"],
  ],
  [
    "settings-thumbnail",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["contain", "cover"],
  ],
  [
    "settings-density",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["comfortable", "compact"],
  ],
  ["password-form", "form", "", null, null, null, null, null],
  ["password-current", "input", "password", true, null, null, "128", null],
  ["password-new", "input", "password", true, null, null, "128", null],
  ["password-confirm", "input", "password", true, null, null, "128", null],
  ["site-account-form", "form", "", null, null, null, null, null],
  [
    "site-account-host",
    "select",
    "",
    true,
    null,
    null,
    null,
    ["sbxh9.com", "toki32.com"],
  ],
  ["site-account-username", "input", "", true, null, null, "128", null],
  [
    "site-account-password",
    "input",
    "password",
    false,
    null,
    null,
    "128",
    null,
  ],
  ["site-account-pin", "input", "password", false, null, null, "4", null],
  ["site-account-enabled", "input", "checkbox", false, null, null, null, null],
  ["settings-import-file", "input", "file", false, null, null, null, null],
  ["settings-import-text", "textarea", "", false, null, null, null, null],
  ["job-dialog", "dialog", "", null, null, null, null, null],
  ["job-form", "form", "", null, null, null, null, null],
  ["job-url", "input", "url", true, null, null, null, null],
  ["job-title", "input", "", false, null, null, "300", null],
  ["job-from", "input", "number", false, "0", null, null, null],
  ["job-to", "input", "number", false, "0", null, null, null],
  ["job-schedule", "input", "datetime-local", false, null, null, null, null],
  ["job-format", "select", "", false, null, null, null, ["txt", "epub"]],
  ["job-executor", "select", "", false, null, null, null, ["server"]],
  ["job-overwrite", "input", "checkbox", false, null, null, null, null],
  ["batch-dialog", "dialog", "", null, null, null, null, null],
  ["batch-form", "form", "", null, null, null, null, null],
  ["batch-urls", "textarea", "", true, null, null, null, null],
  ["batch-from", "input", "number", false, "0", null, null, null],
  ["batch-to", "input", "number", false, "0", null, null, null],
  ["batch-format", "select", "", false, null, null, null, ["txt", "epub"]],
  ["batch-schedule", "input", "datetime-local", false, null, null, null, null],
  ["batch-overwrite", "input", "checkbox", false, null, null, null, null],
  ["bundle-dialog", "dialog", "", null, null, null, null, null],
  ["failures-dialog", "dialog", "", null, null, null, null, null],
  ["reader-dialog", "dialog", "", null, null, null, null, null],
  ["captcha-session-dialog", "dialog", "", null, null, null, null, null],
  [
    "captcha-session-viewer",
    "select",
    "",
    false,
    null,
    null,
    null,
    ["https://sbxh9.com", "https://toki32.com"],
  ],
  ["captcha-session-text-form", "form", "", null, null, null, null, null],
  [
    "captcha-session-text",
    "input",
    "password",
    false,
    null,
    null,
    "1024",
    null,
  ],
];

test("redesign preserves all original views, dialogs, fields and validation constraints", async () => {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const d = dom.window.document;
  try {
    const actualIds = Array.from(d.querySelectorAll("[id]"), (el) => el.id);
    assert.equal(
      new Set(actualIds).size,
      actualIds.length,
      "duplicate IDs break action handlers",
    );
    for (const id of originalIds)
      assert.ok(d.getElementById(id), "missing existing feature: " + id);
    for (const [
      id,
      tag,
      type,
      required,
      min,
      max,
      maxlength,
      options,
    ] of originalControls) {
      const el = d.getElementById(id);
      assert.equal(el.tagName.toLowerCase(), tag, id);
      assert.equal(el.getAttribute("type") || "", type, id);
      if (required) assert.ok(el.required, id);
      for (const [name, value] of [
        ["min", min],
        ["max", max],
        ["maxlength", maxlength],
      ])
        if (value !== null)
          assert.equal(el.getAttribute(name), value, id + " " + name);
      if (options)
        assert.deepEqual(
          Array.from(el.options, (o) => o.value),
          options,
          id + " options",
        );
    }
    assert.deepEqual(
      Array.from(
        d.querySelectorAll("[data-view]"),
        (el) => el.dataset.view,
      ).sort(),
      [
        "activity",
        "discover",
        "history",
        "library",
        "presets",
        "queue",
        "releases",
        "settings",
      ],
    );
  } finally {
    dom.window.close();
  }
});

test("redesign provides a keyboard skip link and named navigation icons without external UI assets", async () => {
  const dom = new JSDOM(
    await readFile(new URL("../public/index.html", import.meta.url), "utf8"),
  );
  const d = dom.window.document;
  try {
    const link = d.querySelector(".skip-link");
    assert.ok(link, "keyboard users need direct access to content");
    assert.ok(d.querySelector(link.getAttribute("href")));
    for (const button of d.querySelectorAll(".nav-item")) {
      assert.ok(button.textContent.trim(), button.id);
      assert.equal(
        button.querySelector("svg")?.getAttribute("aria-hidden"),
        "true",
        button.id,
      );
    }
    assert.ok(
      Array.from(d.querySelectorAll("link[rel=stylesheet],script[src]")).every(
        (el) => (el.href || el.src).startsWith("/"),
      ),
    );
  } finally {
    dom.window.close();
  }
});
