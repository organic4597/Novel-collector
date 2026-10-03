import { SiteAutoAuth } from "./site-auto-auth.mjs";
import { SiteBrowser } from "./site-browser.mjs";
import { AutoRecovery } from "./auto-recovery.mjs";
import { CaptchaSession } from "./captcha-session.mjs";
import { DEFAULT_SOURCE_ORIGIN, sourceGateHost } from "./source-site.mjs";

export function activeSourceStatus(origins) {
  const origin = origins?.originFor("newtoki1.org") || DEFAULT_SOURCE_ORIGIN;
  return { origin, host: new URL(origin).hostname, legacyDisabled: true };
}
export function createSourceAuthentication(options) {
  return new SiteAutoAuth({
    ...options,
    gateHostFor: sourceGateHost,
    accountHostFor: (host) =>
      new URL(
        options.viewerOrigins.resolve(
          `https://${sourceGateHost(host)}/novel/1`,
        ),
      ).hostname,
    loginFromCatalog: true,
  });
}
export function sourceAccountChanged({ scheduler, recovery, autoAuth }) {
  return (saved) => {
    if (!saved.enabled || !saved.configured) return;
    const host = autoAuth?.gateHost?.(saved.host) || sourceGateHost(saved.host);
    if (autoAuth?.accountHost && autoAuth.accountHost(host) !== saved.host)
      return;
    const site = scheduler.attention?.get(host);
    if (site) recovery?.request(site, { force: true });
  };
}
export function createSourceSessions(options) {
  const siteBrowser = new SiteBrowser(options);
  const autoAuth = createSourceAuthentication({ ...options, siteBrowser });
  const recovery = new AutoRecovery({
    ...options,
    autoAuth,
    onState: (state) => console.info("[SourceCheck] " + JSON.stringify(state)),
  });
  const captchaSession = new CaptchaSession({
    ...options,
    siteBrowser,
    autoAuth,
    recovery,
  });
  return { siteBrowser, autoAuth, recovery, captchaSession };
}
