import test from "node:test";
import assert from "node:assert/strict";
import { CaptchaSession } from "../src/captcha-session.mjs";
import { createCaptchaSessionRouter } from "../src/captcha-session-api.mjs";

const host = "newtoki1.org";
function fixture() {
  const calls = [],
    site = { host, held: true, requiredSlots: [1, 2], verifiedSlots: [] };
  let session = null;
  const browser = {
    async open(input) {
      if (session) throw Object.assign(Error("busy"), { status: 409 });
      session = { ...input };
      calls.push(["open", input.slot, input.viewerOrigin]);
      return this.status(input);
    },
    async status({ owner } = {}) {
      if (owner && session && owner !== session.owner)
        throw Object.assign(Error("other session"), { status: 409 });
      return {
        open: !!session,
        host: session?.host ?? host,
        slot: session?.slot ?? null,
        pendingSlots: site.requiredSlots.filter(
          (slot) => !site.verifiedSlots.includes(slot),
        ),
        viewerHost: session ? "sbxh9.com" : null,
      };
    },
    async check(options) {
      assert.equal(options.owner, session.owner);
      assert.equal(options.reload, false);
      const slot = session.slot;
      site.verifiedSlots.push(slot);
      session = null;
      if (site.verifiedSlots.length === 2) site.held = false;
      return {
        verified: true,
        host,
        slot,
        siteReleased: !site.held,
        pendingSlots: site.requiredSlots.filter(
          (s) => !site.verifiedSlots.includes(s),
        ),
      };
    },
    async close({ owner } = {}) {
      assert.equal(owner, session.owner);
      calls.push(["close"]);
      session = null;
    },
    async input(input, { owner }) {
      assert.equal(owner, session.owner);
      calls.push(["input", input]);
      return this.status({ owner });
    },
    async frame({ owner }) {
      assert.equal(owner, session.owner);
      return { bytes: Buffer.from("JPEG"), mimeType: "image/jpeg" };
    },
  };
  const service = new CaptchaSession({
    siteBrowser: browser,
    attention: { get: () => structuredClone(site) },
    scheduler: {},
    autoAuth: { wait: async () => calls.push(["wait"]) },
    recovery: {
      suspend: async (h) => calls.push(["suspend", h]),
      resume: async (h) => calls.push(["resume", h]),
    },
  });
  return {
    service,
    browser,
    calls,
    site,
    foreign: () => (session = { host, slot: 1, owner: "foreign" }),
  };
}
test("one human session pauses recovery, awaits auto login and walks required slots sequentially", async () => {
  const f = fixture();
  const opened = await f.service.open({ host });
  assert.equal(opened.open, true);
  assert.deepEqual(f.calls, [
    ["suspend", host],
    ["wait"],
    ["open", 1, "https://sbxh9.com"],
  ]);
  const one = await f.service.apply();
  assert.equal(one.verified, true);
  assert.equal(one.status.slot, 2);
  assert.deepEqual(one.pendingSlots, [2]);
  assert.equal(
    f.calls.some((c) => c[0] === "resume"),
    false,
  );
  const two = await f.service.apply();
  assert.equal(two.siteReleased, true);
  assert.equal(two.status.open, false);
  assert.equal(two.status.state, "completed");
  assert.deepEqual(f.calls.at(-1), ["resume", host]);
});
test("invalid input never opens or pauses, and inactive wrapper cannot close another session", async () => {
  const f = fixture();
  for (const input of [
    { host: "127.0.0.1" },
    { host, viewerOrigin: "https://evil.example" },
    { host, url: "https://sbxh9.com/novel/1/2" },
  ])
    await assert.rejects(f.service.open(input), { status: 400 });
  assert.deepEqual(f.calls, []);
  f.foreign();
  await f.service.close();
  assert.deepEqual(f.calls, []);
  await assert.rejects(f.service.frame(), { status: 409 });
  await assert.rejects(f.service.open({ host }), { status: 409 });
  assert.equal((await f.browser.status()).open, true);
  assert.deepEqual(f.calls.at(-1), ["resume", host]);
});
test("CAPTCHA failure leaves the human browser owned and site held; close resumes recovery", async () => {
  const f = fixture();
  await f.service.open({ host });
  f.browser.check = async () => {
    throw Object.assign(Error("still captcha"), {
      status: 409,
      kind: "captcha",
    });
  };
  await assert.rejects(f.service.apply(), { kind: "captcha" });
  assert.equal((await f.service.status()).open, true);
  assert.equal(f.site.held, true);
  await f.service.input({ type: "pointer", phase: "down", x: 1, y: 2 });
  await f.service.close();
  assert.equal(f.site.held, true);
  assert.deepEqual(f.calls.at(-1), ["resume", host]);
});
test("router returns uncached frames and validates empty apply bodies", async () => {
  const f = fixture(),
    router = createCaptchaSessionRouter({ captchaSession: f.service });
  let headers, bytes, result;
  const call = (name, method, input = {}) =>
    router({
      request: { method },
      response: {
        writeHead: (_s, h) => (headers = h),
        end: (b) => (bytes = b),
      },
      url: new URL(`/api/captcha-session/${name}`, "http://localhost"),
      readBody: async () => input,
      send: (_r, _s, state) => (result = state),
    });
  await call("open", "POST", { host });
  await call("frame", "GET");
  assert.equal(headers["Cache-Control"], "no-store");
  assert.ok(Buffer.isBuffer(bytes));
  await assert.rejects(call("apply", "POST", { url: "https://evil.example" }), {
    status: 400,
  });
  assert.equal(await call("unknown", "GET"), false);
  await call("close", "POST");
  assert.equal(result.open, false);
});

test("browser expiry resumes recovery even after the dialog stops polling", async () => {
  const f = fixture();
  let expired;
  const originalOpen = f.browser.open;
  f.browser.open = async (input) => {
    expired = input.onExpired;
    return originalOpen.call(f.browser, input);
  };
  await f.service.open({ host });
  assert.equal(typeof expired, "function");
  await expired();
  assert.deepEqual(f.calls.at(-1), ["resume", host]);
  assert.equal((await f.service.status()).state, "closed");
});

test("automatic retry is single-flight, reports five-attempt status and blocks human input until failure", async () => {
  const f=fixture(); await f.service.open({host});
  let fail;
  f.browser.retryAutomatic=async ({onProgress,signal})=>{
    onProgress({attempt:4,stage:"VERIFYING"});
    return new Promise((_,reject)=>{fail=()=>reject(new Error("private-cookie"));signal.addEventListener("abort",fail,{once:true});});
  };
  assert.equal((await f.service.retry()).automatic.active,true);
  await Promise.resolve();
  const state=await f.service.status();
  assert.equal(state.automatic.maxAttempts,5);
  assert.equal(state.automatic.attempt,4);
  await assert.rejects(f.service.input({type:"click",x:1,y:2}),{status:409});
  assert.equal((await f.service.retry()).automatic.active,true);
  fail();await f.service.automatic.work;
  assert.equal((await f.service.status()).automatic.state,"failed");
  assert.ok(!JSON.stringify(await f.service.status()).includes("private-cookie"));
  await f.service.input({type:"click",x:1,y:2});await f.service.close();
});

test("closing an automatic retry aborts it and releases only the owned browser", async () => {
  const f=fixture();await f.service.open({host});
  f.browser.retryAutomatic=({signal})=>new Promise((_,reject)=>{
    if(signal.aborted)reject(new Error("abort"));else signal.addEventListener("abort",()=>reject(new Error("abort")),{once:true});
  });
  await f.service.retry(); await f.service.close();
  assert.equal((await f.service.status()).open,false);
  assert.equal(f.site.held,true);
});
