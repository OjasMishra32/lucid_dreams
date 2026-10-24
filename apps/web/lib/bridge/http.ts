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
