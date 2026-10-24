// What the QA-owned scenarios (scenarios.mjs) need from the machine: a free port, this checkout's vite, and a registry
// that kills every child the run started, so nothing outlives a hung scenario, an interrupt or an exit. The page-driven
// checks all go through the integrator's e2e.mjs (it has --query for URL flags); this file opens no browser.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ChildRegistry } from "./lib.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
export const WEBXR = resolve(HERE, "../../..");

/** Every child process of this run (killed on exit). */
export const children = new ChildRegistry();
process.on("exit", () => children.killAll());

/** A free TCP port on 127.0.0.1. */
export function freePort() {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const { port } = s.address();
      s.close(() => ok(port));
    });
  });
}

/** This checkout's vite on a free port, accepted only once its own output names the port. */
export async function startVite() {
  let log = "";
  for (let attempt = 0; attempt < 3; attempt++) {
    const port = await freePort();
    const server = children.add(
      spawn(process.execPath, [join(WEBXR, "node_modules/vite/bin/vite.js"), "--port", String(port), "--strictPort", "--host", "127.0.0.1"], {
        cwd: WEBXR,
        env: { ...process.env, LUCID_HTTP: "1" },
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
    log = "";
    server.stdout.on("data", (d) => (log += d));
    server.stderr.on("data", (d) => (log += d));
    const until = Date.now() + 30000;
    while (Date.now() < until && server.exitCode === null) {
      if (log.includes(`127.0.0.1:${port}`)) {
        try {
          if ((await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(5000) })).ok) return { server, port };
        } catch {
          // not answering yet
        }
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    server.kill();
  }
  throw new Error(`vite did not start:\n${log}`);
}
