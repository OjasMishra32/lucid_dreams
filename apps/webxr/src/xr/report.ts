// Errors from the headset, where there is no console to look at: each distinct error is printed and sent to the Mac
// (the dev and preview servers append it to ~/Library/Logs/lucid-xr-errors.log), the 1st, 10th, 100th and every
// 1000th time it happens.
const seen = new Map<string, number>();

export function report(err: unknown, where: string): void {
  const msg = err instanceof Error ? `${err.message}\n${err.stack ?? ""}` : String(err);
  const key = `${where}|${msg.slice(0, 300)}`;
  const n = (seen.get(key) ?? 0) + 1;
  seen.set(key, n);
  if (n !== 1 && n !== 10 && n !== 100 && n % 1000 !== 0) return;
  console.error(`[${where}] x${n}`, err);
  try {
    navigator.sendBeacon(`${import.meta.env.BASE_URL}__log`, JSON.stringify({ t: new Date().toISOString(), where, n, msg, url: location.href, ua: navigator.userAgent }));
  } catch {
    // reporting must never be what breaks
  }
}

addEventListener("error", (e) => report(e.error ?? e.message, "window"));
addEventListener("unhandledrejection", (e) => report(e.reason, "promise"));
