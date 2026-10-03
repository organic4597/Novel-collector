const fail = () =>
  new Error(
    "테스트 프록시는 인증 정보 없는 서버 내부 주소만 사용할 수 있습니다.",
  );
export function browserProxyOptions(env = process.env) {
  const raw = env.COLLECTOR_TEST_PROXY_URL;
  if (!raw) return {};
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw fail();
  }
  const port = Number(url.port);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    !Number.isInteger(port) ||
    port < 1024 ||
    port > 65535
  )
    throw fail();
  return { proxy: { server: url.origin } };
}
export function testProxyStatus(env = process.env) {
  return browserProxyOptions(env).proxy
    ? { active: true, name: "SpoofDPI", ipChanging: false }
    : { active: false };
}
