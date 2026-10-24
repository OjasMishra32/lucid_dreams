// Checks Talk with them in the viewer (src/talk.ts, the relay in vite.config.ts, apps/talk/server.mjs): his jaw opens
// the right way on his own rig and never past 8.6 degrees; the relay answers for Vishal and refuses a family's talk;
// a spoken question gets a reply in his words (and, once his voice is cloned, a WAV of it). Needs the Talk server
// (:5175) and a viewer server (the dev server, LUCID_HTTP=1 on :5181, by default).
//   node scripts/check_talk.ts [http://localhost:5181] [dreams/vishal-lhm]
import { registerHooks } from "node:module";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import ts from "typescript";
import * as THREE from "three";

// src/ is written for Vite (extensionless imports): resolve and transpile it on the fly
const SRC = pathToFileURL(resolve(dirname(fileURLToPath(import.meta.url)), "../src")).href;
registerHooks({
  resolve(spec, ctx, next) {
    if (/^\.\.?\//.test(spec) && !/\.[a-z]+$/.test(spec) && ctx.parentURL?.startsWith(SRC)) return next(spec + ".ts", ctx);
    return next(spec, ctx);
  },
  load(url, ctx, next) {
    if (!url.startsWith(SRC) || !url.endsWith(".ts")) return next(url, ctx);
    const out = ts.transpileModule(readFileSync(fileURLToPath(url), "utf8"), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 }, fileName: url });
    return { format: "module", source: out.outputText, shortCircuit: true };
  },
});
const { openJaw } = await import("../src/talk.ts");

let failed = 0;
const check = (name: string, ok: boolean, detail: string) => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name}: ${detail}`);
  if (!ok) failed++;
};
const base = process.argv[2] ?? "http://localhost:5181";
const bundle = resolve(dirname(fileURLToPath(import.meta.url)), "../../..", process.argv[3] ?? "dreams/vishal-lhm");

// ---------------- his jaw, on his own rig
const skeleton = JSON.parse(readFileSync(join(bundle, "avatar/skeleton.json"), "utf8"));
const rest = skeleton.rest as number[][];
const pose = () => rest.map(() => new THREE.Quaternion());
// the chin: a point in front of and below the jaw joint, where their face is
const facing = Math.sign(rest[23][2] + rest[24][2] - 2 * rest[15][2]);
const chin = new THREE.Vector3(0, -0.06, 0.08 * facing);
for (const level of [0, 0.5, 1, 3]) {
  const local = pose();
  openJaw(local, skeleton, level);
  const angle = 2 * Math.acos(Math.min(1, Math.abs(local[22].w)));
  const moved = chin.clone().applyQuaternion(local[22]);
  if (level === 0) check("shut with no sound", angle < 1e-6, `${THREE.MathUtils.radToDeg(angle).toFixed(2)} degrees`);
  else {
    check(`open at ${level}`, angle > 0 && angle <= 0.1501, `${THREE.MathUtils.radToDeg(angle).toFixed(1)} degrees (at most 8.6)`);
    check(`the chin goes down at ${level}`, moved.y < chin.y, `${((moved.y - chin.y) * 1000).toFixed(1)} mm`);
  }
}

// ---------------- the relay and the Talk server
const get = async (path: string) => {
  const r = await fetch(base + path);
  return { status: r.status, body: await r.json().catch(() => null) };
};
const health = await get("/talk/vishal/health").catch(() => null);
if (!health) {
  check("the viewer server answers", false, `nothing at ${base}`);
} else {
  check("Vishal can be talked to", health.status === 200 && health.body?.ok === true, JSON.stringify(health.body));
  const family = await get("/talk/grandma/health");
  check("a family's talk never goes through the relay", family.status === 404, `${family.status}`);
  const nobody = await get("/talk/nobody/health");
  check("nobody else either", nobody.status === 404, `${nobody.status}`);
  // a spoken question (macOS's own voice) -> his reply
  if (process.platform === "darwin") {
    const dir = mkdtempSync(join(tmpdir(), "talk-"));
    execFileSync("say", ["-o", join(dir, "q.aiff"), "Hey Vishal, what did you build this weekend?"]);
    execFileSync("ffmpeg", ["-v", "error", "-y", "-i", join(dir, "q.aiff"), "-ar", "16000", "-ac", "1", join(dir, "q.wav")]);
    const t0 = Date.now();
    const r = await fetch(`${base}/talk/vishal?session=check`, { method: "POST", headers: { "Content-Type": "audio/wav" }, body: readFileSync(join(dir, "q.wav")) });
    const j = (await r.json()) as { heard?: string; reply?: string; audio?: string | null; error?: string };
    check("he heard the question", /vishal/i.test(j.heard ?? ""), JSON.stringify(j.heard ?? j.error));
    check("he answers in words", (j.reply ?? "").length > 10, `${JSON.stringify(j.reply)} (${Date.now() - t0} ms)`);
    if (health.body?.voice) {
      check("in his cloned voice", !!j.audio, String(j.audio));
      if (j.audio) {
        const wav = Buffer.from(await (await fetch(base + j.audio)).arrayBuffer());
        const seconds = (wav.length - 44) / (22050 * 2);
        check("a WAV you can hear", wav.subarray(0, 4).toString() === "RIFF" && seconds > 0.8, `${seconds.toFixed(1)} s`);
      }
    } else console.log("     (his voice isn't cloned yet: words only, never another voice)");
    check("words only without a voice", health.body?.voice || j.audio === null, String(j.audio));
  }
}
if (!existsSync(join(bundle, "dream.json"))) check("his bundle", false, `no ${bundle}`);
console.log(failed ? `\n${failed} FAILED` : "\nTALK_OK");
process.exit(failed ? 1 : 0);
