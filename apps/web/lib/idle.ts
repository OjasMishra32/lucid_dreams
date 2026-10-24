// Start the heavy things (a 1080x1920 video decoding) once the page has loaded and gone quiet, so the first paint and
// the first tap never wait on them. Never later than a couple of seconds, though: a slow image must not keep a person
// standing still. Client only.

type IdleWindow = Window & {
  requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
  cancelIdleCallback?: (h: number) => void;
};

/** Calls fn once, after the window's load event and the next idle moment, or after `maxMs` at the latest; returns a cancel. */
export function afterLoad(fn: () => void, maxMs = 2500): () => void {
  const w = window as IdleWindow;
  let done = false;
  let idle = 0;
  const run = () => {
    if (done) return;
    done = true;
    fn();
  };
  const go = () => {
    if (w.requestIdleCallback) idle = w.requestIdleCallback(run, { timeout: 1200 });
    else window.setTimeout(run, 200);
  };
  const cap = window.setTimeout(run, maxMs);
  if (document.readyState === "complete") go();
  else window.addEventListener("load", go, { once: true });
  return () => {
    done = true;
    window.removeEventListener("load", go);
    clearTimeout(cap);
    if (idle) w.cancelIdleCallback?.(idle);
  };
}
