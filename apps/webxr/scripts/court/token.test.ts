// serve.mjs --token (token-gate.mjs, P36 for a short tunnelled headset test): refused without the token, the cookie set
// by /?k=<token> lets everything through, and a wrong token, a wrong cookie or none at all get a bodiless 404. The gate
// on its own, then serve.mjs itself on a temp page and bundle (outside every checkout).
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { COOKIE, cookieValue, goodToken, tokenGate } from "../../src/court/token-gate.mjs";

const TOKEN = "0123456789abcdef0123456789abcdef";
const req = (url: string, cookie?: string) => ({ url, headers: cookie ? { cookie } : {} });

test("the gate: no token, a wrong one or a wrong cookie is a 404; /?k=<token> sets the cookie and redirects to the clean URL", () => {
  const gate = tokenGate(TOKEN);
  assert.deepEqual(gate(req("/")), { status: 404 });
  assert.deepEqual(gate(req("/bundle/court.json")), { status: 404 });
  assert.deepEqual(gate(req("/?k=wrong")), { status: 404 });
  assert.deepEqual(gate(req(`/?k=${TOKEN}x`)), { status: 404 });
  assert.deepEqual(gate(req("/", `${COOKIE}=nope`)), { status: 404 });
  assert.deepEqual(gate(req("/", `other=${TOKEN}`)), { status: 404 });
  const set = gate(req(`/?k=${TOKEN}&mode=court&bundle=/bundle/&stats`));
  assert.equal(set!.status, 302);
  assert.equal(set!.location, "/?mode=court&bundle=%2Fbundle%2F&stats=");
  assert.match(set!.cookie!, new RegExp(`^${COOKIE}=${TOKEN}; Path=/; HttpOnly; SameSite=Strict; Max-Age=\\d+$`));
  assert.equal(gate(req("/bundle/video/show.h264", `a=1; ${COOKIE}=${TOKEN}; b=2`)), null);
  assert.equal(gate(req("/court-sw.js", `${COOKIE}=${TOKEN}`)), null);
  assert.equal(cookieValue(`x=1;${COOKIE}=abc`), "abc");
  assert.equal(goodToken("short"), false);
  assert.equal(goodToken("has space in it 0123456"), false);
  assert.equal(goodToken(TOKEN), true);
  assert.throws(() => tokenGate("weak"));
});

/** One request to the server; resolves { status, headers, body }. */
function get(port: number, path: string, cookie?: string): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((ok, fail) => {
    const r = request({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...(cookie ? { cookie } : {}) } }, (res) => {
      let body = "";
      res.on("data", (c) => (body += c));
      res.on("end", () => ok({ status: res.statusCode ?? 0, headers: res.headers, body }));
    });
    r.on("error", fail);
    r.end();
  });
}

test("serve.mjs --token: refused without the token (404, no body), allowed with the cookie /?k= sets", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "court-token-"));
  const dist = join(tmp, "dist");
  const bundle = join(tmp, "bundle");
  mkdirSync(dist);
  mkdirSync(bundle);
  writeFileSync(join(dist, "index.html"), "<!doctype html><title>court</title>");
  writeFileSync(join(bundle, "court.json"), '{"title":"t"}');
  const serve = join(dirname(fileURLToPath(import.meta.url)), "../../src/court/serve.mjs");
  const srv = spawn(process.execPath, [serve, "--bundle", bundle, "--dist", dist, "--port", "0", "--token", TOKEN], { stdio: ["ignore", "pipe", "pipe"] });
  try {
    const port = await new Promise<number>((ok, fail) => {
      srv.stdout.on("data", (d) => {
        const m = String(d).match(/127\.0\.0\.1:(\d+)/);
        if (m) ok(Number(m[1]));
      });
      srv.on("exit", (code) => fail(new Error(`serve.mjs exited ${code}`)));
    });
    for (const path of ["/", "/bundle/court.json", "/court-sw.js", "/?k=wrong", "/index.html"]) {
      const r = await get(port, path);
      assert.equal(r.status, 404, path);
      assert.equal(r.body, "", `${path}: no body`);
    }
    const first = await get(port, `/?k=${TOKEN}&mode=court&bundle=/bundle/`);
    assert.equal(first.status, 302);
    assert.equal(first.headers.location, "/?mode=court&bundle=%2Fbundle%2F");
    const cookie = String((first.headers["set-cookie"] as string[])[0]).split(";")[0];
    assert.equal((await get(port, "/?mode=court&bundle=/bundle/", cookie)).status, 200);
    const court = await get(port, "/bundle/court.json", cookie);
    assert.equal(court.status, 200);
    assert.equal(court.body, '{"title":"t"}');
    assert.equal((await get(port, "/bundle/court.json", `${COOKIE}=0123456789abcdef0123456789abcdee`)).status, 404);
  } finally {
    srv.kill();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("serve.mjs refuses a weak --token", async () => {
  const serve = join(dirname(fileURLToPath(import.meta.url)), "../../src/court/serve.mjs");
  const tmp = mkdtempSync(join(tmpdir(), "court-token-"));
  writeFileSync(join(tmp, "court.json"), "{}");
  try {
    const code = await new Promise<number | null>((ok) => spawn(process.execPath, [serve, "--bundle", tmp, "--dev", "--token", "abc"], { stdio: "ignore" }).on("exit", ok));
    assert.equal(code, 2);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
