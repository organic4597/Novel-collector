// Starting selectors from the current rendered DOM adapters. These templates
// contain configuration only and never activate a collection source.
import { defaultWebtoonPreset } from "./webtoon-presets.mjs";
const definitions = Object.freeze([
  {
    id: "sbxh9-novel-v1",
    name: "sbxh9 소설 기본",
    origin: "https://sbxh9.com",
  },
  {
    id: "toki32-novel-v1",
    name: "toki32 소설 기본",
    origin: "https://toki32.com",
  },
  {id:"sbxh9-webtoon-v3",name:"sbxh9 웹툰 기본",origin:"https://sbxh9.com",contentType:"webtoon"},
  {id:"toki32-webtoon-v3",name:"toki32 웹툰 기본",origin:"https://toki32.com",contentType:"webtoon"},
  {id:"sbxh9-manhwa-v3",name:"sbxh9 만화 기본",origin:"https://sbxh9.com",contentType:"manhwa"},
  {id:"toki32-manhwa-v3",name:"toki32 만화 기본",origin:"https://toki32.com",contentType:"manhwa"},
]);
const locator = (
  selector,
  { attribute = "text", multiple = false, relativeTo } = {},
) => ({
  selector,
  shadowPath: [],
  attribute,
  multiple,
  ...(relativeTo ? { relativeTo } : {}),
});
const card = (selector, options = {}) =>
  locator(selector, { ...options, relativeTo: "items" });
const row = (selector, options = {}) =>
  locator(selector, { ...options, relativeTo: "rows" });

function configFor(definition) {
  if(["webtoon","manhwa"].includes(definition.contentType))return{...defaultWebtoonPreset(definition.origin,definition.contentType),name:definition.name};
  return {
    version: 2,
    name: definition.name,
    origin: definition.origin,
    pages: {
      listing: {
        pagePattern: "/novel",
        fields: {
          items: locator(
            "ul.novel-list a.novel-card[href], .search-results-grid a.card[href]",
            { multiple: true },
          ),
          title: card(".nv-title, .subject"),
          author: card(".nv-author"),
          genres: card(".genre", { multiple: true }),
          thumbnail: card(".nv-thumb img, .thumb img", { attribute: "src" }),
          url: card(":scope", { attribute: "href" }),
          publication: card(".nv-badge--done, .thumb > .badge"),
          updatedLabel: card(".nv-date"),
        },
      },
      detail: {
        pagePattern: "/novel/{workId}",
        fields: {
          title: locator("section.novel-detail .nd-info h1"),
          author: locator(
            'section.novel-detail .nd-meta a[href*="field=author"]',
          ),
          tags: locator("section.novel-detail .hero-v2-tags a", {
            multiple: true,
          }),
          platform: locator("section.novel-detail .nd-platform"),
          publication: locator("section.novel-detail .nv-badge--done"),
          synopsis: locator("section.novel-detail .nd-desc"),
          thumbnail: locator("section.novel-detail .nd-thumb img", {
            attribute: "src",
          }),
          rows: locator("ul.novel-eps li.novel-ep-row", { multiple: true }),
          chapterNumber: row(".ne-num"),
          chapterTitle: row(".ne-title"),
          chapterUrl: row("a.novel-ep-link[href]", { attribute: "href" }),
          expectedChapters: locator("section.novel-detail .nd-info .nd-meta"),
          moreButton: locator("ul.novel-eps + button"),
        },
      },
      reader: {
        pagePattern: "/novel/{workId}/{episodeId}",
        fields: {
          root: locator("#novel_content, [data-theme-novel-content]"),
          text: locator("#novel_content, [data-theme-novel-content]"),
          notice: locator(
            "#novel_content .wr-none, [data-theme-novel-content] .wr-none",
          ),
        },
      },
    },
  };
}

export function listDefaultPresets() {
  return definitions.map((definition) => {
    const config = configFor(definition);
    const pages = Object.entries(config.pages).map(([kind, page]) => ({
      kind,
      pagePattern: page.pagePattern||page.pagePatterns[0],
      fieldCount: Object.keys(page.fields).length,
    }));
    return {
      ...definition,
      description:
        "목록·작품 정보·회차 본문의 기본 선택자입니다. 없는 항목이나 사이트 변경은 원본 선택 도구에서 조정하세요.",
      pages,
      fieldCount: pages.reduce((count, page) => count + page.fieldCount, 0),
    };
  });
}

export function defaultPresetConfig(id) {
  const definition = definitions.find((preset) => preset.id === id);
  if (!definition)
    throw Object.assign(new Error("기본 프리셋을 찾을 수 없습니다."), {
      status: 404,
    });
  return configFor(definition);
}
