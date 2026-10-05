import { randomUUID } from "node:crypto";
import { stat } from "node:fs/promises";
import { isIP } from "node:net";
import { isPublicAddress } from "./collector.mjs";
import { listDefaultPresets, defaultPresetConfig } from "./default-presets.mjs";

export const PRESET_FIELDS = Object.freeze({
  listing: ["items", "title", "author", "genres", "tags", "platform", "episodeCount", "publication", "thumbnail", "url", "updatedLabel", "nextPageButton"],
  detail: ["title", "author", "genres", "tags", "platform", "episodeCount", "publication", "synopsis", "thumbnail"],
  catalog: ["rows", "number", "title", "url", "notReady", "expectedChapters", "moreButton"],
  reader: ["root", "text", "notice"],
});
export const PRESET_PAGE_FIELDS = Object.freeze({
  listing: PRESET_FIELDS.listing,
  detail: [...PRESET_FIELDS.detail,"rows","chapterNumber","chapterTitle","chapterUrl","notReady","expectedChapters","moreButton"],
  reader: PRESET_FIELDS.reader,
});
const patterns={listing:"/novel",detail:"/novel/{workId}",reader:"/novel/{workId}/{episodeId}"};
const bad = message => Object.assign(new Error(message), { status: 400 });
function exact(value, keys, label) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !keys.includes(key)))
    throw bad(`${label} 형식을 확인하세요. 미리보기 원문·인증값·코드는 가져오지 않습니다.`);
}
function selector(value) {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\x00-\x1f]/.test(value) ||
      /javascript:|\b(?:cookie|token|nonce|proof|password|authorization)\s*[:=]/i.test(value) ||
      /\[\s*(?:value|password|token|nonce|proof|cookie|authorization)(?:\s|[~|^$*]?=|\])/i.test(value))
    throw bad("요소 선택자가 비어 있거나 허용 범위를 벗어났습니다.");
  return value.trim();
}
export function validatePreset(input) {
  if(input?.version===2)return validateGroup(input);
  exact(input, ["version", "name", "origin", "pagePattern", "kind", "fields"], "프리셋");
  let bytes;
  try { bytes = Buffer.byteLength(JSON.stringify(input)); } catch { throw bad("JSON 프리셋을 확인하세요."); }
  if (bytes > 32768 || input.version !== 1) throw bad("프리셋은 버전 1, 최대 32KiB를 지원합니다.");
  if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 80 || /[\x00-\x1f]/.test(input.name))
    throw bad("프리셋 이름을 1~80자로 입력하세요.");
  let origin;
  try { origin = new URL(input.origin); } catch { throw bad("원본 사이트의 HTTPS 주소를 확인하세요."); }
  const host = origin.hostname.replace(/^\[|\]$/g, "");
  if (typeof input.origin !== "string" || origin.protocol !== "https:" || origin.username || origin.password || origin.port ||
      origin.pathname !== "/" || origin.search || origin.hash ||
      host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
      (!isIP(host) && !host.includes(".")) || (isIP(host) && !isPublicAddress(host)))
    throw bad("공개 원본 사이트의 HTTPS origin만 저장할 수 있습니다.");
  if (typeof input.pagePattern !== "string" || !input.pagePattern.startsWith("/") || input.pagePattern.startsWith("//") ||
      input.pagePattern.length > 300 || /[?#\\\x00-\x1f<>]/.test(input.pagePattern))
    throw bad("페이지 패턴은 쿼리·인증값 없는 /경로 형식이어야 합니다.");
  if (!Object.hasOwn(PRESET_FIELDS, input.kind)) throw bad("목록·소개·목차·본문 유형을 선택하세요.");
  exact(input.fields, PRESET_FIELDS[input.kind], "추출 항목");
  if (!Object.keys(input.fields).length) throw bad("추출 항목을 한 개 이상 선택하세요.");
  const fields = {};
  for (const [key, locator] of Object.entries(input.fields)) {
    exact(locator, ["selector", "shadowPath", "attribute", "multiple", "relativeTo"], "추출 항목");
    if (!["text", "href", "src", "data-src"].includes(locator.attribute) || typeof locator.multiple !== "boolean")
      throw bad("텍스트·링크·이미지 속성과 반복 여부를 확인하세요.");
    const shadowPath = locator.shadowPath ?? [];
    if (!Array.isArray(shadowPath) || shadowPath.length > 8) throw bad("Shadow DOM 경로를 확인하세요.");
    const item = { selector: selector(locator.selector), shadowPath: shadowPath.map(selector), attribute: locator.attribute, multiple: locator.multiple };
    if (locator.relativeTo != null) {
      const parent = input.kind === "listing" ? "items" : input.kind === "catalog" ? "rows" : null;
      if (!parent || key === parent || locator.relativeTo !== parent || !input.fields[parent])
        throw bad("상대 선택자는 먼저 지정한 반복 영역에 연결해야 합니다.");
      item.relativeTo = parent;
    }
    if (["items", "rows"].includes(key) && !locator.multiple) throw bad("반복 영역은 여러 요소로 지정하세요.");
    fields[key] = item;
  }
  return { version: 1, name: input.name.trim(), origin: origin.origin, pagePattern: input.pagePattern, kind: input.kind, fields };
}

function validateGroup(input){
  exact(input,["version","name","origin","pages"],"프리셋");
  if(Buffer.byteLength(JSON.stringify(input))>32768)throw bad("프리셋은 최대 32KiB를 지원합니다.");
  const common=validatePreset({version:1,name:input.name,origin:input.origin,pagePattern:"/",kind:"detail",fields:{title:{selector:"h1",attribute:"text",multiple:false}}});
  exact(input.pages,Object.keys(PRESET_PAGE_FIELDS),"페이지 유형");
  const pages={};let count=0;
  for(const [kind,allowed] of Object.entries(PRESET_PAGE_FIELDS)){
    const page=input.pages[kind];exact(page,["pagePattern","fields"],"페이지");exact(page.fields,allowed,"추출 항목");
    validatePreset({version:1,name:input.name,origin:input.origin,pagePattern:page.pagePattern,kind:"detail",fields:{title:{selector:"h1",attribute:"text",multiple:false}}});
    const fields={};
    for(const [key,l] of Object.entries(page.fields)){
      exact(l,["selector","shadowPath","attribute","multiple","relativeTo"],"추출 항목");
      if(!["text","href","src","data-src"].includes(l.attribute)||typeof l.multiple!=="boolean")throw bad("텍스트·링크·이미지 속성과 반복 여부를 확인하세요.");
      const shadowPath=l.shadowPath??[];if(!Array.isArray(shadowPath)||shadowPath.length>8)throw bad("Shadow DOM 경로를 확인하세요.");
      const item={selector:selector(l.selector),shadowPath:shadowPath.map(selector),attribute:l.attribute,multiple:l.multiple};
      if(l.relativeTo!=null){
        const parent=kind==="listing"&&key!=="nextPageButton"?"items":kind==="detail"&&["chapterNumber","chapterTitle","chapterUrl","notReady"].includes(key)?"rows":null;
        if(!parent||key===parent||l.relativeTo!==parent||!page.fields[parent])throw bad("상대 선택자는 같은 페이지의 저장된 반복 영역에 연결해야 합니다.");
        item.relativeTo=parent;
      }
      if(["items","rows"].includes(key)&&!l.multiple)throw bad("반복 영역은 여러 요소로 지정하세요.");
      fields[key]=item;count++;
    }
    pages[kind]={pagePattern:page.pagePattern,fields};
  }
  if(!count)throw bad("저장할 추출 항목을 한 개 이상 지정하세요.");
  return{version:2,name:common.name,origin:common.origin,pages};
}
export function groupPreset(input){
  if(input.version===2)return validatePreset(input);
  const old=validatePreset(input),pages=Object.fromEntries(Object.entries(patterns).map(([kind,pagePattern])=>[kind,{pagePattern,fields:{}}]));
  const kind=old.kind==="catalog"?"detail":old.kind;
  const rename={number:"chapterNumber",title:"chapterTitle",url:"chapterUrl"};
  pages[kind]={pagePattern:old.pagePattern,fields:Object.fromEntries(Object.entries(old.fields).map(([key,l])=>[old.kind==="catalog"?(rename[key]||key):key,l]))};
  return validatePreset({version:2,name:old.name,origin:old.origin,pages});
}

// Stores only selector configuration. No sample text, cookies, tokens or JS.
export class ExtractionPresets {
  constructor({ store, maxPresets = 100 }) {
    this.store = store; this.path = store.path("extraction-presets.json");
    if (!Number.isSafeInteger(maxPresets) || maxPresets < 1) throw bad("프리셋 저장 개수 설정을 확인하세요.");
    this.maxPresets = Math.min(100, maxPresets); this.records = new Map(); this.control = Promise.resolve();
  }
  async load() {
    try { if ((await stat(this.path)).size > 2 * 1024 * 1024) throw Error(); } catch (e) { if (e.code !== "ENOENT") throw Object.assign(new Error("프리셋 저장소를 읽지 못했습니다."), { status: 503 }); }
    const data = await this.store.json(this.path);
    if (!data) return this;
    try {
      if (data.version !== 1 || !Array.isArray(data.presets) || data.presets.length > this.maxPresets) throw Error();
      for (const record of data.presets) {
        if (!/^[a-f0-9-]{36}$/.test(record.id) || this.records.has(record.id) || !Number.isFinite(Date.parse(record.createdAt)) || !Number.isFinite(Date.parse(record.updatedAt))) throw Error();
        this.records.set(record.id, { id: record.id, config: validatePreset(record.config), createdAt: record.createdAt, updatedAt: record.updatedAt });
      }
    } catch { throw Object.assign(new Error("저장된 프리셋 형식이 올바르지 않습니다."), { status: 503 }); }
    return this;
  }
  list() {
    return [...this.records.values()].map(r => r.config.version===2?({id:r.id,name:r.config.name,origin:r.config.origin,
      pages:Object.entries(r.config.pages).map(([kind,p])=>({kind,pagePattern:p.pagePattern,fieldCount:Object.keys(p.fields).length})),
      fieldCount:Object.values(r.config.pages).reduce((n,p)=>n+Object.keys(p.fields).length,0),updatedAt:r.updatedAt}):({ id: r.id, name: r.config.name, origin: r.config.origin,
      kind: r.config.kind, pagePattern: r.config.pagePattern, fieldCount: Object.keys(r.config.fields).length, updatedAt: r.updatedAt }));
  }
  get(id) {
    const record = this.records.get(id);
    if (!record) throw Object.assign(new Error("프리셋을 찾을 수 없습니다."), { status: 404 });
    return structuredClone(record);
  }
  defaults() { return listDefaultPresets(); }
  async addDefault(defaultId) {
    const config = validatePreset(defaultPresetConfig(defaultId));
    return this.serialized(() => {
      const names = new Set([...this.records.values()].map(record => record.config.name));
      let name = config.name, copy = 2;
      while (names.has(name)) name = `${config.name} (복사본 ${copy++})`;
      return this.#saveRecord({ ...config, name });
    });
  }
  serialized(operation) {
    const work = this.control.catch(() => {}).then(operation); this.control = work; return work;
  }
  async persist(next) {
    const data = { version: 1, presets: [...next.values()] };
    if (Buffer.byteLength(JSON.stringify(data)) > 2 * 1024 * 1024)
      throw Object.assign(new Error("프리셋 저장 용량을 초과했습니다."), { status: 409 });
    await this.store.atomic(this.path, data); this.records = next;
  }
  save(input, id = null) {
    const config = validatePreset(input);
    return this.serialized(() => this.#saveRecord(config, id));
  }
  async #saveRecord(config, id = null) {
      if (id && !this.records.has(id)) this.get(id);
      if (!id && this.records.size >= this.maxPresets) throw Object.assign(new Error("프리셋은 최대 100개 저장할 수 있습니다."), { status: 409 });
      const now = new Date().toISOString();
      const record = { id: id || randomUUID(), config, createdAt: id ? this.records.get(id).createdAt : now, updatedAt: now };
      const next = new Map(this.records); next.set(record.id, record); await this.persist(next);
      return structuredClone(record);
  }
  remove(id) {
    return this.serialized(async () => { this.get(id); const next = new Map(this.records); next.delete(id); await this.persist(next); return { deleted: true }; });
  }
}
