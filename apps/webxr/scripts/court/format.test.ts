// court.json and frames.json: the stand-in bundle validates, and every broken field is named in a readable error.
//   node --experimental-transform-types --test apps/webxr/scripts/court/
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { BALL_CARD, CourtFormatError, LABEL, chooseStream, loadCourt, validateCards, validateCourt, validateFrames } from "../../src/court/format.ts";
import { FIXTURE, standinBundle } from "./standin.mjs";

// the tests break arbitrary fields of plain JSON, so its values stay loosely typed here (and only here)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const fresh = () => structuredClone(standinBundle()) as { court: Json; frames: Json[]; cards: Json[] };

test("the stand-in court.json, frames.json and cards.json validate", () => {
  const { court, frames, cards } = fresh();
  assert.deepEqual(validateCourt(court), []);
  assert.deepEqual(validateFrames(frames, court as never), []);
  assert.deepEqual(validateCards(cards, court as never, frames as never), []);
});

test("the committed fixture (scripts/court/fixtures/court.json) is the stand-in's court.json", () => {
  // regenerate with: node apps/webxr/scripts/court/standin.mjs --fixture
  assert.deepEqual(JSON.parse(readFileSync(FIXTURE, "utf8")), JSON.parse(JSON.stringify(fresh().court)));
});

test("the stand-in has a gap between the pair and a third person in the lit region (P43), and the ball's card at the make", () => {
  const { court, cards } = fresh();
  const atF = cards[court.video.segments.eases[0].frames[1]].cards as Json[];
  assert.deepEqual(atF.map((c) => c.id).sort(), ["defender", "shooter", "trailer"]);
  const [s, d] = ["shooter", "defender"].map((id) => atF.find((c) => c.id === id)!.foot);
  assert.ok(Math.hypot(s[0] - d[0], s[2] - d[2]) > 0.75, "the pair's feet are far enough apart for a gap");
  assert.ok(cards.some((f) => (f.cards as Json[]).some((c) => c.id === BALL_CARD)), "the ball has a card somewhere");
});

test("they still validate after a JSON round trip", () => {
  const { court, frames } = JSON.parse(JSON.stringify(fresh()));
  assert.deepEqual(validateCourt(court), []);
  assert.deepEqual(validateFrames(frames, court), []);
});

test("unknown fields are ignored, so the format can grow", () => {
  const { court } = fresh();
  court.future = { anything: 1 };
  court.freeze.players[0].later = true;
  assert.deepEqual(validateCourt(court), []);
});

test("anything that isn't an object is refused with one clear error", () => {
  for (const bad of [null, 3, "court", [1, 2]]) {
    const errors = validateCourt(bad);
    assert.equal(errors.length, 1);
    assert.match(errors[0], /^court\.json: expected an object/);
  }
});

// [what breaks, how, the field the error must name, a word the explanation must contain]
const BROKEN: [string, (c: Json) => void, string, RegExp][] = [
  ["version", (c) => (c.version = 2), "version", /1/],
  ["label", (c) => (c.label = "Real footage."), "label", /exactly/],
  ["missing caption", (c) => delete c.caption, "caption", /missing/],
  ["empty title", (c) => (c.title = " "), "title", /text/],
  ["rim height", (c) => (c.court.rim[1] = 2.5), "court.rim", /3\.05/],
  ["court size", (c) => (c.court.length = -1), "court.length", /greater than 0/],
  ["hardwood colour", (c) => (c.court.hardwood = [1.2, 0.5, 0.3]), "court.hardwood[0]", /between 0 and 1/],
  ["floor path", (c) => (c.court.floor = "../court/floor.jpg"), "court.floor", /inside the bundle/],
  ["camera k1", (c) => (c.camera.k1 = 0.1), "camera.k1", /undistorted/],
  ["camera cx", (c) => (c.camera.cx = 5000), "camera.cx", /inside the image/],
  ["camera width", (c) => (c.camera.width = 3840.5), "camera.width", /whole number/],
  ["capture fps", (c) => (c.camera.captureFps = 0), "camera.captureFps", /greater than 0/],
  ["codec", (c) => (c.video.codec = "h264"), "video.codec", /avc1/],
  ["display rate", (c) => (c.video.displayHz = 0), "video.displayHz", /greater than 0/],
  ["video file scheme", (c) => (c.video.file = "https://example.com/show.h264"), "video.file", /inside the bundle/],
  ["absolute path", (c) => (c.video.freeze = "/video/freeze.png"), "video.freeze", /inside the bundle/],
  ["fallback shape", (c) => (c.video.fallbacks.small = "video/show-small.h264"), "video.fallbacks.small", /object/],
  ["live region aspect", (c) => (c.video.regions.live = [0, 0, 1536, 900]), "video.regions.live", /aspect/],
  ["regions overlap", (c) => (c.video.regions.plate = [0, 800, 1536, 864]), "video.regions", /overlap/],
  ["region outside the stream", (c) => (c.video.regions.mattes = [0, 1728, 1536, 500]), "video.regions.mattes", /inside the stream/],
  ["plate size", (c) => (c.video.regions.plate = [0, 864, 1500, 864]), "video.regions.plate", /live region's size/],
  ["small copy shape", (c) => (c.video.fallbacks.small.width = 1400), "video.fallbacks.small.height", /shape/],
  ["pass 2 speed", (c) => (c.video.pass2Speed = 1.2), "video.pass2Speed", /between 0 and 1/],
  ["missing cards", (c) => delete c.video.cards, "video.cards", /missing/],
  ["light level", (c) => (c.light.crowd = 1.5), "light.crowd", /between 0 and 1/],
  ["penumbra", (c) => (c.light.penumbra = 1), "light.penumbra", /at least 1.5/],
  ["light alternative", (c) => delete c.light.alternative.floor, "light.alternative.floor", /missing/],
  ["backboard", (c) => (c.court.backboard.length = 3), "court.backboard", /four corners/],
  ["extra named ball", (c) => (c.freeze.others[0].id = BALL_CARD), "freeze.others[0].id", /ball's card/],
  ["pass 1 reversed", (c) => (c.video.segments.pass1 = [10, 2]), "video.segments.pass1", /first <= last/],
  ["fractional range", (c) => (c.video.segments.resume = [0.5, 20]), "video.segments.resume", /whole/],
  ["no eases", (c) => (c.video.segments.eases = []), "video.segments.eases", /at least one/],
  ["ease start outside pass 2", (c) => (c.video.segments.eases[0].start = c.video.segments.pass1[0]), "video.segments.eases[0].start", /pass 2/],
  ["ease seconds", (c) => (c.video.segments.eases[1].seconds = 3), "video.segments.eases[1].seconds", /frames/],
  ["eases out of order", (c) => c.video.segments.eases.reverse(), "video.segments.eases", /order/],
  ["overlapping segments", (c) => (c.video.segments.resume[0] = c.video.segments.pass2[1]), "video.segments", /overlap/],
  ["cutoff after the last ease", (c) => (c.video.cutoff = c.video.segments.pass2[1]), "video.cutoff", /last ease start/],
  ["freeze source", (c) => (c.video.freezeSource = "600"), "video.freezeSource", /number/],
  ["make needed by a one-shot", (c) => delete c.video.makeSource, "video.makeSource", /make/],
  ["seat ray", (c) => (c.seat.ray = "broadcast"), "seat.ray", /freeze/],
  ["seat distance", (c) => (c.seat.distance = 9), "seat.distance", /distanceRange/],
  ["seat range", (c) => (c.seat.distanceRange = [7, 4]), "seat.distanceRange", /low, high/],
  ["pair off the floor", (c) => (c.seat.pairCentre[1] = 1), "seat.pairCentre", /floor/],
  ["no spots", (c) => (c.seat.spots = []), "seat.spots", /at least one/],
  ["spot not a point", (c) => (c.seat.spots[1] = [1, 0]), "seat.spots[1]", /\[x, y, z\]/],
  ["ring area", (c) => (c.seat.ringArea = [4.5]), "seat.ringArea", /width, depth/],
  ["no players", (c) => (c.freeze.players = []), "freeze.players", /at least one/],
  ["seen fraction", (c) => (c.freeze.players[0].seenFraction = 1.5), "freeze.players[0].seenFraction", /between 0 and 1/],
  ["duplicate id", (c) => (c.freeze.players[1].id = c.freeze.players[0].id), "freeze.players[1].id", /unique/],
  ["capsule radius", (c) => (c.freeze.players[0].capsules[0].r = 0), "freeze.players[0].capsules[0].r", /greater than 0/],
  ["no capsules", (c) => (c.freeze.players[1].capsules = []), "freeze.players[1].capsules", /at least one/],
  ["bounds", (c) => (c.freeze.players[0].bounds.min[1] = 5), "freeze.players[0].bounds", /min/],
  ["shadow rect", (c) => (c.freeze.players[0].shadow.rect = [1, 1, 0, 2]), "freeze.players[0].shadow.rect", /minX/],
  ["missing proxy", (c) => delete c.freeze.players[0].proxy, "freeze.players[0].proxy", /missing/],
  ["ball radius", (c) => (c.freeze.ball.radius = -0.1), "freeze.ball.radius", /greater than 0/],
  ["ball erase player", (c) => (c.freeze.ball.erase[0].player = "nobody"), "freeze.ball.erase[0].player", /no player/],
  ["extra kind", (c) => (c.freeze.others[0].kind = "card"), "freeze.others[0].kind", /splats, body or relief/],
  ["extra pose", (c) => (c.freeze.others[0].pose = "B"), "freeze.others[0].pose", /A or C/],
  ["relief past 15 deg", (c) => Object.assign(c.freeze.others[0], { kind: "relief", maxRayAngle: 20 }), "freeze.others[0].maxRayAngle", /15/],
  ["extra id clash", (c) => (c.freeze.others[0].id = c.freeze.players[0].id), "freeze.others[0].id", /unique/],
  ["stands plane", (c) => (c.freeze.stands.proxy[0].points.length = 3), "freeze.stands.proxy[0].points", /four/],
  ["stands kind", (c) => (c.freeze.stands.proxy[0].kind = "dome"), "freeze.stands.proxy[0].kind", /plane/],
  ["card quad", (c) => (c.freeze.stands.cards[0].quad[2] = [0, "1", 0]), "freeze.stands.cards[0].quad[2][1]", /number/],
  ["too few crowd sources", (c) => (c.audio.sources.length = 2), "audio.sources", /4/],
  ["one-shot cue", (c) => (c.audio.oneShots[0].at = "dunk"), "audio.oneShots[0].at", /make or stepIn/],
  ["event position", (c) => (c.audio.events = [{ frame: 1300, kind: "bounce", at: [0, 0], file: "audio/sfx/bounce.m4a" }]), "audio.events[0].at", /\[x, y, z\]/],
  ["interp share", (c) => (c.metrics.interpShare = 2), "metrics.interpShare", /between 0 and 1/],
  ["metrics map", (c) => (c.metrics.seatPsnr = { players: "high" }), "metrics.seatPsnr.players", /number/],
];

test("metrics not measured yet may be null (the project's convention)", () => {
  const { court } = fresh();
  court.metrics.reprojDeg = { median: null, p95: null };
  court.metrics.heldOutPsnrVsGenerated = { shooter: null };
  court.metrics.seatPsnr = { players: null };
  assert.deepEqual(validateCourt(court), []);
});

for (const [what, breakIt, field, why] of BROKEN) {
  test(`a broken ${what} is named: ${field}`, () => {
    const { court } = fresh();
    breakIt(court);
    const errors = validateCourt(court);
    const hit = errors.find((e) => e.startsWith(`${field}: `));
    assert.ok(hit, `no error for ${field}; got:\n  ${errors.join("\n  ") || "(none)"}`);
    assert.match(hit, why);
  });
}

test("several broken fields are all reported at once", () => {
  const { court } = fresh();
  court.version = 3;
  court.camera.k1 = 0.2;
  court.seat.ray = "x";
  const errors = validateCourt(court);
  for (const f of ["version", "camera.k1", "seat.ray"]) assert.ok(errors.some((e) => e.startsWith(`${f}: `)), f);
});

test("the honesty label is the plan's exact text", () => {
  assert.equal(LABEL, "Real footage, rebuilt in 3D. Not affiliated with the NBA or the players.");
  assert.equal(fresh().court.label, LABEL);
});

// ---------------- frames.json ----------------

const BROKEN_FRAMES: [string, (f: Json[], c: Json) => void, RegExp][] = [
  ["empty", (f) => (f.length = 0), /frames\.json: expected one entry per show frame/],
  ["too short for the segments", (f) => (f.length = f.length - 5), /frames\.json: .*resume ends on show frame \d+/],
  ["camera not a unit quaternion", (f) => (f[5].q = [0, 0, 0, 2]), /^frames\.json\[5\]\.q: .*unit/],
  ["focal", (f) => (f[7].f = 0), /^frames\.json\[7\]\.f: .*greater than 0/],
  ["interp flag", (f) => (f[3].interp = "no"), /^frames\.json\[3\]\.interp: .*true or false/],
  ["real frame at a fractional source frame", (f) => Object.assign(f[0], { interp: false, src: f[0].src + 0.5 }), /^frames\.json\[0\]\.src: .*whole/],
  ["an ease that misses F", (f, c) => (f[c.video.segments.eases[0].frames[1]].src += 1), /^frames\.json\[\d+\]\.src: .*ease 0 must end on F/],
  ["F shown as an in-between", (f, c) => (f[c.video.segments.eases[2].frames[1]].interp = true), /^frames\.json\[\d+\]\.interp: .*F is a real frame/],
  ["eases that end on different cameras", (f, c) => (f[c.video.segments.eases[1].frames[1]].f += 50), /^frames\.json\[\d+\]: .*camera F/],
];

for (const [what, breakIt, why] of BROKEN_FRAMES) {
  test(`frames.json: ${what} is named`, () => {
    const { court, frames } = fresh();
    breakIt(frames, court);
    const errors = validateFrames(frames, court as never);
    assert.ok(errors.some((e) => why.test(e)), `nothing matched ${why}; got:\n  ${errors.join("\n  ") || "(none)"}`);
  });
}

test("frames.json that isn't an array is refused", () => {
  const { court } = fresh();
  assert.match(validateFrames({ frames: [] }, court as never)[0], /^frames\.json: expected one entry per show frame/);
});

// ---------------- loadCourt ----------------

function fakeFetch(files: Record<string, unknown>) {
  const asked: string[] = [];
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    asked.push(url);
    if (!(url in files)) return new Response("not here", { status: 404 });
    return new Response(JSON.stringify(files[url]), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  return { fetcher, asked };
}

test("loadCourt reads court.json and frames.json and resolves bundle paths beside court.json", async () => {
  const { court, frames, cards } = fresh();
  const { fetcher, asked } = fakeFetch({
    "http://127.0.0.1:5180/bundle/court.json": court,
    "http://127.0.0.1:5180/bundle/video/frames.json": frames,
    "http://127.0.0.1:5180/bundle/video/cards.json": cards,
  });
  const bundle = await loadCourt("http://127.0.0.1:5180/bundle/court.json", { fetcher });
  assert.deepEqual(asked, ["http://127.0.0.1:5180/bundle/court.json", "http://127.0.0.1:5180/bundle/video/frames.json", "http://127.0.0.1:5180/bundle/video/cards.json"]);
  assert.equal(bundle.court.title, court.title);
  assert.equal(bundle.frames.length, frames.length);
  assert.equal(bundle.cards.length, frames.length);
  assert.equal(bundle.file("video/show.h264"), "http://127.0.0.1:5180/bundle/video/show.h264");
  // a folder URL works too
  const again = await loadCourt("http://127.0.0.1:5180/bundle/", { fetcher });
  assert.equal(again.base, "http://127.0.0.1:5180/bundle/");
});

test("loadCourt refuses an invalid bundle with every error listed", async () => {
  const { court, frames, cards } = fresh();
  court.camera.k1 = 0.3;
  court.seat.ray = "x";
  const { fetcher } = fakeFetch({ "http://h/b/court.json": court, "http://h/b/video/frames.json": frames, "http://h/b/video/cards.json": cards });
  await assert.rejects(loadCourt("http://h/b/court.json", { fetcher }), (e: unknown) => {
    assert.ok(e instanceof CourtFormatError);
    assert.ok(e.errors.some((m) => m.startsWith("camera.k1: ")));
    assert.ok(e.errors.some((m) => m.startsWith("seat.ray: ")));
    assert.match(e.message, /http:\/\/h\/b\/court\.json/);
    return true;
  });
});

test("loadCourt names a missing file by its URL", async () => {
  const { court } = fresh();
  const { fetcher } = fakeFetch({ "http://h/b/court.json": court });
  await assert.rejects(loadCourt("http://h/b/court.json", { fetcher }), /http:\/\/h\/b\/video\/frames\.json: HTTP 404/);
});

// ---------------- the pre-built streams (?show=1080, ?hz=90) ----------------

/** The stand-in plus a 90 Hz bake with its own frames.json (the same frame list stands in for it here). */
function withHz90() {
  const { court, frames, cards } = fresh();
  const v = court.video;
  const segments = structuredClone(v.segments);
  for (const e of segments.eases) e.seconds = (e.frames[1] - e.frames[0] + 1) / 90; // the same frames last less at 90 Hz
  court.video.fallbacks.hz90 = { file: "video/show-90.h264", codec: "avc1.640033", width: 1536, height: 2160, displayHz: 90, frames: "video/frames-90.json", cards: "video/cards-90.json", segments, cutoff: v.cutoff };
  return { court, frames, cards };
}

test("chooseStream: the small copy keeps every frame and segment; the file, codec, size and scaled regions change", () => {
  const { court } = fresh();
  const c = chooseStream(court as never, "small");
  assert.equal(c.video.file, "video/show-small.h264");
  assert.equal(c.video.codec, "avc1.640033");
  assert.deepEqual([c.video.width, c.video.height], [1280, 1800]);
  assert.deepEqual(c.video.regions.live, [0, 0, 1280, 720]);
  assert.deepEqual(c.video.regions.mattes, [0, 1440, 1280, 360]);
  assert.deepEqual(c.video.segments, court.video.segments);
  assert.equal(c.video.frames, court.video.frames);
  assert.equal(court.video.file, "video/show.h264", "the original is untouched");
  assert.equal(chooseStream(court as never, null), court);
});

test("chooseStream: the 90 Hz bake brings its own display rate, frames.json, segments and cutoff", () => {
  const { court } = withHz90();
  const c = chooseStream(court as never, "hz90");
  assert.equal(c.video.displayHz, 90);
  assert.equal(c.video.frames, "video/frames-90.json");
  assert.equal(c.video.file, "video/show-90.h264");
  assert.equal(c.video.cutoff, court.video.fallbacks.hz90.cutoff);
});

test("chooseStream: a fallback the bundle doesn't have is a clear error", () => {
  assert.throws(() => chooseStream(fresh().court as never, "hz90"), /no 90 Hz bake \(video\.fallbacks\.hz90\)/);
});

test("loadCourt with ?hz=90 fetches and validates the 90 Hz frames.json", async () => {
  const { court, frames, cards } = withHz90();
  const { fetcher, asked } = fakeFetch({ "http://h/b/court.json": court, "http://h/b/video/frames-90.json": frames, "http://h/b/video/cards-90.json": cards });
  const bundle = await loadCourt("http://h/b/court.json", { fetcher, fallback: "hz90" });
  assert.equal(bundle.court.video.displayHz, 90);
  assert.deepEqual(asked, ["http://h/b/court.json", "http://h/b/video/frames-90.json", "http://h/b/video/cards-90.json"]);
});

// ---------------- cards.json ----------------

const BROKEN_CARDS: [string, (k: Json[]) => void, RegExp][] = [
  ["one entry short", (k) => k.pop(), /^cards\.json: expected one entry per show frame/],
  ["a person twice in a frame", (k) => k[10].cards.push({ ...k[10].cards[0], tile: [1200, 0, 1210, 10], order: 9 }), /^cards\.json\[10\]\.cards\[\d\]\.id: .*one card per person/],
  ["a foot off the floor", (k) => (k[3].cards[0].foot[1] = 0.5), /^cards\.json\[3\]\.cards\[0\]\.foot: .*floor/],
  ["a box outside the live region", (k) => (k[4].cards[0].box = [10, 10, 1600, 200]), /^cards\.json\[4\]\.cards\[0\]\.box: .*inside the live region/],
  ["a tile outside the atlas", (k) => (k[5].cards[0].tile = [0, 0, 100, 500]), /^cards\.json\[5\]\.cards\[0\]\.tile: .*inside the matte atlas/],
  ["two cards sharing a tile", (k) => (k[6].cards[1].tile = k[6].cards[0].tile), /^cards\.json\[6\]\.cards\[1\]\.tile: .*no other card/],
  ["two cards with one order", (k) => (k[7].cards[1].order = k[7].cards[0].order), /^cards\.json\[7\]\.cards\[1\]\.order: .*no other card/],
];

for (const [what, breakIt, why] of BROKEN_CARDS) {
  test(`cards.json: ${what} is named`, () => {
    const { court, frames, cards } = fresh();
    breakIt(cards);
    const errors = validateCards(cards, court as never, frames as never);
    assert.ok(errors.some((e) => why.test(e)), `nothing matched ${why}; got:\n  ${errors.slice(0, 5).join("\n  ") || "(none)"}`);
  });
}
