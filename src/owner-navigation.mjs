export function ownerNavigation(runtimeMode, ownerHubUrl) {
  if (runtimeMode !== "development" || !ownerHubUrl) return {};
  try {
    const url = new URL(ownerHubUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash) return {};
    return { href: url.href };
  } catch {
    return {};
  }
}

export function backgroundWorkEnabled(runtimeMode, setting) {
  // A migrated development copy must not resume the production collection queue.
  return runtimeMode !== "development" || setting !== "0";
}
