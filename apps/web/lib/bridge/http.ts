import "server-only";
import { networkInterfaces } from "node:os";

// The Quest app and the WebXR viewer call the bridge from other origins on the same Wi-Fi.
export const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges",
};

export function json(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { ...CORS, "Cache-Control": "no-store" } });
}

export function preflight(): Response {
  return new Response(null, { status: 204, headers: CORS });
}

/**
 * The address other people can reach this page at. The bridge has no fixed name, so it comes from the request; when
 * that's this Mac's own localhost (the demo laptop), swap in its Wi-Fi address so shared links work on other devices.
 */
export function publicOrigin(h: Headers): string {
  const host = h.get("x-forwarded-host") ?? h.get("host") ?? "localhost:5170";
  const proto = h.get("x-forwarded-proto") ?? "http";
  const [, name, port] = /^(\[[^\]]+\]|[^:]+)(?::(\d+))?$/.exec(host) ?? [];
  if (!/^(localhost|127\.0\.0\.1|\[::1\])$/.test(name ?? "")) return `${proto}://${host}`;
  const lan = Object.values(networkInterfaces())
    .flat()
    .find((i) => i && i.family === "IPv4" && !i.internal)?.address;
  return `${proto}://${lan ?? name}${port ? `:${port}` : ""}`;
}

/**
 * The headset app (apps/webxr) as the Quest reaches it: /xr on this same address when the page came over https (the
 * public link), else the Mac's own https server (:5180/xr) at its Wi-Fi address, since the room needs a secure page.
 */
export function viewerOrigin(h: Headers): string {
  const set = process.env.NEXT_PUBLIC_VIEWER_URL;
  if (set) return set.replace(/\/$/, "");
  const origin = publicOrigin(h);
  if (origin.startsWith("https:")) return `${origin}/xr`;
  return `https://${new URL(origin).hostname}:5180/xr`;
}

const LOOPBACK = /^(localhost|127(\.\d{1,3}){3}|\[?::1\]?|::ffff:127(\.\d{1,3}){3})$/i;

/**
 * Whether the page is being viewed on this Mac itself rather than from another device on the Wi-Fi: the Host it was
 * asked for, and the address Next recorded for the request. Casual privacy for a family's dream, not a lock: a client
 * on the network that fakes both headers gets past it.
 */
export function onThisMac(h: Headers): boolean {
  const host = (h.get("host") ?? "").replace(/:\d+$/, "");
  const from = (h.get("x-forwarded-for") ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  return LOOPBACK.test(host) && from.every((a) => LOOPBACK.test(a));
}
