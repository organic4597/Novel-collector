import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { watchNormalDiscoveryResponses } from "../src/normal-discovery-network.mjs";

function fixture(t) {
  const page = new EventEmitter();
  const watcher = watchNormalDiscoveryResponses({ transportUrl: () => "https://sbxh9.com/novel",
    sourceGate: { assertResponse: async () => {} } }, page, "https://newtoki1.org/novel");
  t.after(() => watcher.close());
  const request = query => ({ url: () => `https://sbxh9.com/api/novel-list?${query}`, resourceType: () => "fetch" });
  const complete = async value => {
    page.emit("response", { request: () => value, finished: async () => null });
    await watcher.check();
  };
  return { page, watcher, request, complete };
}

test("DOM page two is recognized even when the source document URL stays on page one", async t => {
  const f = fixture(t), request = f.request("page=2&sort=updated");
  f.page.emit("request", request); await f.complete(request);
  assert.equal(f.watcher.completedFor("https://sbxh9.com/novel", 0, { page: 2, startedAfter: 0 }), true);
  assert.equal(f.watcher.completedFor("https://sbxh9.com/novel", 0, { page: 3, startedAfter: 0 }), false);
});

test("a request started before the control click cannot prove that control completed", async t => {
  const f = fixture(t), request = f.request("page=2");
  f.page.emit("request", request);
  const startedAfter = f.watcher.started;
  await f.complete(request);
  assert.equal(f.watcher.completedFor("https://sbxh9.com/novel", 0, { page: 2, startedAfter }), false);
});

test("explicit public URL filters still reject a mismatched response", async t => {
  const f = fixture(t), request = f.request("page=2&g=other");
  f.page.emit("request", request); await f.complete(request);
  assert.equal(f.watcher.completedFor("https://sbxh9.com/novel?g=selected", 0, { page: 2, startedAfter: 0 }), false);
});
