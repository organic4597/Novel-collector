import https from "node:https";
import { lookup as dnsLookup } from "node:dns/promises";
import { isPublicAddress } from "./collector.mjs";

export const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
export function isListingThumbnail(value) {
  try {
    return validateThumbnailUrl(value).hostname === "image-comic.pstatic.net";
  } catch {
    return false;
  }
}

export async function watchListingThumbnails(
  page,
  { lookup = dnsLookup, assertAvailable = () => {} } = {},
) {
  const responses = new Map();
  const addresses = new Map();
  let closed = false;
  const routeImage = async (route) => {
    const request = route.request();
    if (
      request.resourceType() !== "image" ||
      !isListingThumbnail(request.url())
    )
      return route.fallback();
    try {
      assertAvailable();
      const host = new URL(request.url()).hostname;
      if (!addresses.has(host)) {
        let timeout;
        addresses.set(
          host,
          Promise.race([
            lookup(host, { all: true }),
            new Promise((_, reject) => {
              timeout = setTimeout(
                () => reject(new Error("표지 주소 확인 시간 초과")),
                1500,
              );
            }),
          ]).finally(() => clearTimeout(timeout)),
        );
      }
      const resolved = await addresses.get(host);
      assertAvailable();
      if (
        closed ||
        !resolved.length ||
        resolved.some((item) => !isPublicAddress(item.address))
      )
        return route.abort();
      await route.continue();
    } catch {
      await route.abort().catch(() => {});
    }
  };
  const onResponse = (response) => {
    if (
      closed ||
      response.status() !== 200 ||
      response.request().resourceType() !== "image" ||
      !isListingThumbnail(response.url())
    )
      return;
    const size = Number(response.headers()["content-length"]);
    if (!Number.isSafeInteger(size) || size <= 0 || size > MAX_IMAGE_BYTES)
      return;
    responses.delete(response.url());
    // Filter/page changes must retain the final listing's most recent covers.
    if (responses.size >= 96) responses.delete(responses.keys().next().value);
    responses.set(response.url(), response);
  };
  await page.route("**/*", routeImage);
  page.on("response", onResponse);
  const close = async () => {
    closed = true;
    page.off("response", onResponse);
    await page.unroute("**/*", routeImage);
    responses.clear();
  };
  return {
    async save(items, store) {
      const deadline = Date.now() + 2000;
      let totalBytes = 0;
      for (const item of items) {
        const response = responses.get(item.thumbnailUrl);
        if (!response || Date.now() >= deadline) continue;
        let timer;
        try {
          const bytes = await Promise.race([
            response.body(),
            new Promise((_, reject) => {
              timer = setTimeout(
                () => reject(new Error("표지 응답 대기 시간 초과")),
                deadline - Date.now(),
              );
            }),
          ]);
          const mimeType = validateImage(
            bytes,
            response.headers()["content-type"],
          );
          totalBytes += bytes.length;
          if (totalBytes > 16 * MAX_IMAGE_BYTES) break;
          await store(item.id, { bytes, mimeType });
          responses.delete(item.thumbnailUrl);
        } catch {
          // A missing public cover must not prevent the listing from loading.
        } finally {
          clearTimeout(timer);
        }
      }
    },
    close,
  };
}
export function validateThumbnailUrl(value) {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    !(
      /^(newtoki\d*\.(org|com|net|me))$/i.test(url.hostname) ||
      ["sbxh9.com", "toki32.com"].includes(url.hostname) ||
      url.hostname === "apitk.peertrk.com" ||
      (url.hostname === "image-comic.pstatic.net" &&
        /^\/webtoon\/(?:[\w-]+\/)+[\w.-]+\.(?:jpe?g|png|webp|gif)$/i.test(
          url.pathname,
        )) ||
      (/^user\d+\.quicksharefiles\.top$/i.test(url.hostname) &&
        /^\/comics\/covers\/[\w-]+\.(?:jpe?g|png|webp|gif)$/i.test(
          url.pathname,
        ))
    )
  )
    throw new Error("지원하지 않는 썸네일 주소입니다.");
  return url;
}
export function validateImage(bytes, mime) {
  const type = String(mime || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
  if (
    !Buffer.isBuffer(bytes) ||
    !bytes.length ||
    bytes.length > MAX_IMAGE_BYTES
  )
    throw new Error("썸네일 크기가 허용 범위를 벗어났습니다.");
  const magic = bytes.subarray(0, 16);
  const actual =
    magic[0] === 0xff && magic[1] === 0xd8 && magic[2] === 0xff
      ? "image/jpeg"
      : magic
            .subarray(0, 8)
            .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
        ? "image/png"
        : magic.subarray(0, 6).toString() === "GIF87a" ||
            magic.subarray(0, 6).toString() === "GIF89a"
          ? "image/gif"
          : magic.subarray(0, 4).toString() === "RIFF" &&
              magic.subarray(8, 12).toString() === "WEBP"
            ? "image/webp"
            : null;
  if (!actual || actual !== type)
    throw new Error("허용된 이미지 형식이 아닙니다.");
  return actual;
}
export function requestImage(url, address) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          "User-Agent": "NovelCollector/1.0",
          Accept: "image/jpeg,image/png,image/webp,image/gif",
        },
        lookup: (_hostname, options, callback) =>
          callback(
            null,
            options?.all ? [address] : address.address,
            address.family,
          ),
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400) {
          res.resume();
          resolve({ status: res.statusCode, location: res.headers.location });
          return;
        }
        if (res.statusCode !== 200) {
          res.resume();
          reject(new Error(`썸네일 요청 실패 (${res.statusCode})`));
          return;
        }
        if (Number(res.headers["content-length"] || 0) > MAX_IMAGE_BYTES) {
          res.destroy();
          reject(new Error("썸네일이 너무 큽니다."));
          return;
        }
        let size = 0;
        const chunks = [];
        res.on("data", (chunk) => {
          size += chunk.length;
          if (size > MAX_IMAGE_BYTES) {
            res.destroy(new Error("썸네일이 너무 큽니다."));
            return;
          }
          chunks.push(chunk);
        });
        res.on("error", reject);
        res.on("end", () =>
          resolve({
            status: 200,
            bytes: Buffer.concat(chunks),
            mimeType: res.headers["content-type"],
          }),
        );
      },
    );
    const timer = setTimeout(
      () => req.destroy(new Error("썸네일 요청 시간이 초과됐습니다.")),
      15000,
    );
    timer.unref();
    req.on("close", () => clearTimeout(timer));
    req.on("error", reject);
  });
}
export async function fetchThumbnail(
  value,
  { lookup = dnsLookup, request = requestImage } = {},
) {
  let url = validateThumbnailUrl(value);
  for (let redirects = 0; redirects <= 3; redirects++) {
    // Historical cover URLs remain valid persisted metadata; their old host
    // must never be contacted, including after an otherwise valid CDN redirect.
    if (/^newtoki\d*\.(org|com|net|me)$/i.test(url.hostname))
      throw new Error("이전 사이트의 썸네일 요청은 비활성화됐습니다.");
    const addresses = await lookup(url.hostname, { all: true });
    if (
      !addresses.length ||
      addresses.some((item) => !isPublicAddress(item.address))
    )
      throw new Error("공인 주소만 썸네일에 사용할 수 있습니다.");
    const result = await request(url, addresses[0]);
    if (result.status >= 300 && result.status < 400) {
      if (redirects === 3 || !result.location)
        throw new Error("썸네일 이동 횟수를 초과했습니다.");
      url = validateThumbnailUrl(new URL(result.location, url).href);
      continue;
    }
    return {
      ...result,
      mimeType: validateImage(result.bytes, result.mimeType),
    };
  }
  throw new Error("썸네일을 가져오지 못했습니다.");
}
