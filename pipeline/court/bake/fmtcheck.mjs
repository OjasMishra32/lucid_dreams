// Runs format.ts's validators (and annexb.ts's splitter) over a baked video/ folder. Read-only: the checkout is an
// extract of origin/court-side (fmtcheck.py makes it); nothing there is edited.
//   node fmtcheck.mjs <checkout> <video-dir> [--info video.json]
// video.json = { "camera": (a subset of) SourceCamera, "video": ShowVideoInfo } (what the bake writes for court.json's `video`).
// Checks, for the main stream and each fallback: court.json validates with this video block spliced into the
// court.json fixture, frames.json and cards.json validate for that stream, and the .h264 has one access unit per show
// frame, an IDR at exactly every segment start and the SPS codec the court says.
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, videoDir, ...rest] = process.argv.slice(2);
const infoPath = rest[0] === "--info" ? rest[1] : join(videoDir, "..", "video.json");
const src = (p) => pathToFileURL(resolve(checkout, "apps/webxr", p)).href;
const { validateCourt, validateFrames, validateCards, chooseStream } = await import(src("src/court/format.ts"));
const { splitAnnexB, spsCodec } = await import(src("src/court/annexb.ts"));

const read = (p) => JSON.parse(readFileSync(p, "utf8"));
const fixture = read(resolve(checkout, "apps/webxr/scripts/court/fixtures/court.json"));
const info = read(infoPath);
const bundleRoot = resolve(videoDir, "..");
const court = { ...fixture, video: info.video, camera: { ...fixture.camera, ...(info.camera ?? {}) } };
const problems = [];
// the fixture cues a one-shot on "make"; the bake may not know the make frame (a layers/assembly fact): check with a stand-in
if (court.video.makeSource === undefined) court.video = { ...court.video, makeSource: court.video.freezeSource + 1 };
for (const e of validateCourt(court)) problems.push(`court.json: ${e}`);

const report = [];
for (const name of [null, ...Object.keys(court.video.fallbacks ?? {}).filter((k) => k === "small" || k === "hz90")]) {
  let view;
  try {
    view = chooseStream(court, name);
  } catch (e) {
    problems.push(String(e));
    continue;
  }
  const tag = name ?? "main";
  const v = view.video;
  const frames = read(join(bundleRoot, v.frames));
  const cards = read(join(bundleRoot, v.cards));
  for (const e of validateFrames(frames, view)) problems.push(`${tag} frames: ${e}`);
  // the small copy shares the main stream's cards.json, whose boxes are in main-stream pixels: check them against the main
  // regions (validating them against the scaled regions, as chooseStream gives, rejects every card; reported to the integrator)
  for (const e of validateCards(cards, name === "small" ? court : view, frames)) problems.push(`${tag} cards: ${e}`);
  const file = join(bundleRoot, v.file);
  if (!existsSync(file)) {
    problems.push(`${tag}: ${v.file} is missing`);
    continue;
  }
  const bytes = new Uint8Array(readFileSync(file));
  const units = splitAnnexB(bytes);
  const keyAt = units.flatMap((u, i) => (u.key ? [i] : []));
  const starts = [v.segments.pass1, v.segments.pass2, v.segments.resume, ...v.segments.eases.map((e) => e.frames)].map((r) => r[0]).sort((a, b) => a - b);
  if (units.length !== frames.length) problems.push(`${tag}: ${units.length} access units for ${frames.length} show frames`);
  if (keyAt.join() !== starts.join()) problems.push(`${tag}: IDRs at ${keyAt.join(",")}, segments start at ${starts.join(",")}`);
  const sps = spsCodec(bytes);
  if (sps?.codec !== v.codec) problems.push(`${tag}: SPS says ${sps?.codec}, court.json says ${v.codec}`);
  report.push({ stream: tag, frames: units.length, idr: keyAt, codec: sps?.codec, bytes: bytes.length });
}
console.log(JSON.stringify({ ok: problems.length === 0, problems, report }));
process.exitCode = problems.length ? 1 : 0;
