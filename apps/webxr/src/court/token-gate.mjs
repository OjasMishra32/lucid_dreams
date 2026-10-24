// serve.mjs --token: the gate that makes a quick-tunnel URL useless without the token (P36, a short headset test only).
// The first visit to /?k=<token> sets an HttpOnly cookie and redirects to the same URL without k; every request after
// that needs the cookie. Anything else gets 404 with no body, so a stranger can't tell what is there. Plain JS beside
// serve.mjs. Stream C (`core`).
import { timingSafeEqual } from "node:crypto";

export const COOKIE = "court_k";
/** The cookie lasts this long, seconds (a test session; the tunnel stops right after). */
export const COOKIE_MAX_AGE = 4 * 3600;
/** A token is at least this long and only URL-safe characters (`openssl rand -hex 16` gives 32). */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/;

/** True for a token strong enough to gate with. */
export function goodToken(token) {
  return typeof token === "string" && TOKEN.test(token);
}

/** The named cookie's value in a Cookie header (null if absent). */
export function cookieValue(header, name = COOKIE) {
  for (const part of String(header ?? "").split(";")) {
    const at = part.indexOf("=");
    if (at > 0 && part.slice(0, at).trim() === name) return part.slice(at + 1).trim();
  }
  return null;
}

/**
 * The gate for one token: (req) => null when the request may pass, else { status: 404 } or the redirect that sets the
 * cookie, { status: 302, location, cookie }.
 */
export function tokenGate(token) {
  if (!goodToken(token)) throw new Error("--token needs at least 16 letters, digits, - or _ (openssl rand -hex 16)");
  const want = Buffer.from(token);
  const same = (v) => {
    if (typeof v !== "string") return false;
    const got = Buffer.from(v);
    return got.length === want.length && timingSafeEqual(got, want);
  };
  return (req) => {
    let url;
    try {
      url = new URL(req.url ?? "/", "http://127.0.0.1");
    } catch {
      return { status: 404 };
    }
    const k = url.searchParams.get("k");
    if (k !== null) {
      if (!same(k)) return { status: 404 };
      url.searchParams.delete("k");
      // Lax, not Strict: a link typed as http:// comes back as https (serve.mjs), and that hop is cross-site to the
      // browser, which would hold back a Strict cookie on the redirect and leave the page a 404
      return { status: 302, location: `${url.pathname}${url.search}`, cookie: `${COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${COOKIE_MAX_AGE}` };
    }
    return same(cookieValue(req.headers?.cookie)) ? null : { status: 404 };
  };
}
