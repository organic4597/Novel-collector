// These are user-selected frontends of the same catalog. Registration only
// normalizes identity; a link never proves authentication or changes transport.
export function canonicalWorkInput(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("올바른 작품 URL을 입력하세요."), {
      status: 400,
    });
  }
  if (["sbxh9.com", "toki32.com"].includes(url.hostname) && /^\/novel\//.test(url.pathname))
    url.hostname = "newtoki1.org";
  return url.href;
}
