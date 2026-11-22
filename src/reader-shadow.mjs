const installed = new WeakSet();

export function captureReaderRoots() {
  if (!["sbxh9.com", "toki32.com"].includes(location.hostname) ||
      !/^\/novel\/\d+\/\d+\/?$/.test(location.pathname)) return;
  const descriptor = Object.getOwnPropertyDescriptor(Element.prototype, "attachShadow");
  if (!descriptor?.value || descriptor.value.__ncReaderCapture) return;
  const native = descriptor.value;
  function attachShadow(options) {
    const root = Reflect.apply(native, this, [options]);
    if (root.mode === "closed")
      Object.defineProperty(this, "__novelShadow", { value: root, configurable: true });
    return root;
  }
  Object.defineProperty(attachShadow, "__ncReaderCapture", { value: true });
  Object.defineProperty(Element.prototype, "attachShadow", { ...descriptor, value: attachShadow });
}

export async function installReaderSupport(context) {
  if (!context?.addInitScript || installed.has(context)) return context;
  await context.addInitScript(captureReaderRoots);
  installed.add(context);
  return context;
}
