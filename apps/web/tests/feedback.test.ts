import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// "Watch me try" offline: a stubbed Gemini answer, a temp dreams folder and a temp data folder. npm run test:feedback

const root = mkdtempSync(join(tmpdir(), "lucid-feedback-"));
process.env.LUCID_DREAMS_DIR = join(root, "dreams");
process.env.LUCID_DATA_DIR = join(root, "data");
process.env.GEMINI_API_KEY = "test-key-never-sent"; // the stub answers; nothing here reaches Google
process.env.FEEDBACK_PER_HOUR = "3";
let clockMs = Date.now();
/** Every call gets an hour of its own on the stub clock, so the hourly cap only bites where a test asks it to. */
const hourOf = () => { const t = (clockMs += 2 * 3600_000); return () => t; };

type Feedback = import("../lib/dream").Feedback;
type Attempt = import("../lib/bridge/gemini").Attempt;
type Mod = typeof import("../lib/bridge/feedback");
let M: Mod;
let G: typeof import("../lib/bridge/gemini");
let route: typeof import("../app/api/dreams/[id]/feedback/route");

const STEPS = [
  { start: 0, end: 1.6, title: "Load", tip: "Sink your hips.", speed: 0.5, repeat: 2 },
  { start: 1.6, end: 3.2, title: "Release", tip: "Flick your wrist." },
];
// a WebM header and an MP4 header, enough for sniffing; nothing plays them
const WEBM = (n = 0) => Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(`attempt-${n}`.padEnd(64, "."))]);
const MP4 = (extra = "") => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from("ftypisom"), Buffer.from(`....${extra}`.padEnd(64, "."))]);

function dream(id: string, more: Record<string, unknown> = {}, plan: Record<string, unknown> | null = {}) {
  const dir = join(process.env.LUCID_DREAMS_DIR!, id);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dream.json"), JSON.stringify({
    id, name: id, kind: "replay", fps: 25, frameCount: 121, durationS: 4.84, units: "meters", upAxis: "+Y", bounds: null,
    frames: null, avatar: null, audio: null, preview: null, thumb: null, intent: "teach me this shot", createdAt: "2026-10-24T03:00:00Z",
    experience: "experience.json", ...more,
  }));
  if (plan)
    writeFileSync(join(dir, "experience.json"), JSON.stringify({
      intent: "teach me this shot", mode: "teach", title: "A first shot", summary: "x", place: "ahead", steps: STEPS,
      durationS: 4.84, createdAt: "2026-10-24T03:05:00Z", ...plan,
    }));
}
function recording(name: string, bytes: Buffer): string {
  const dir = join(root, "uploads", name);
  mkdirSync(dir, { recursive: true });
  const p = join(dir, "attempt.bin");
  writeFileSync(p, bytes);
  return p;
}
const answer = (more: Partial<Feedback> = {}): Omit<Feedback, "createdAt"> => ({
  summary: "Good rhythm; the elbow drifts.", seen: true, attemptS: 6, source: "clip", model: "stub",
  notes: [{ attemptT: 2.1, teacherT: 1.6, tone: "fix", title: "Elbow flares", note: "Keep your elbow under the ball." }],
  ...more,
});
const teacher = async () => ({ path: join(root, "teacher.mp4"), offsetS: 0, orbit: false });
const keepAsIs = (): Partial<import("../lib/bridge/feedback").Deps> => ({ teacher, clean: async () => null, now: hourOf() });
const leftovers = () => (existsSync(join(root, "data", "tmp")) ? readdirSync(join(root, "data", "tmp")) : []);

before(async () => {
  M = await import("../lib/bridge/feedback");
  G = await import("../lib/bridge/gemini");
  route = await import("../app/api/dreams/[id]/feedback/route");
  writeFileSync(join(root, "teacher.mp4"), MP4());
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("cleanFeedback holds the notes to the clip", () => {
  const ctx = { teacherS: 4.84, attempt: { durationS: 6 } };

  test("times land inside both videos, in order, at most six", () => {
    const notes = Array.from({ length: 9 }, (_, i) => ({ attemptT: 5.9 - i * 0.5, teacherT: 99, tone: "fix", title: `N${i}`, note: "Do it." }));
    const out = G.cleanFeedback({ seen: true, summary: "ok", notes }, ctx);
    assert.equal(out.notes.length, 6);
    assert.deepEqual(out.notes.map((n) => n.attemptT), [...out.notes.map((n) => n.attemptT)].sort((a, b) => a - b));
    assert.ok(out.notes.every((n) => n.teacherT === 4.8 && n.attemptT <= 6));
  });

  test("a note past the end of the recording, or with no words, is dropped", () => {
    const out = G.cleanFeedback({ seen: true, summary: "", notes: [
      { attemptT: 40, tone: "fix", title: "Late", note: "Nope." },
      { attemptT: 1, tone: "good", title: "", note: "No title." },
      { attemptT: -1, tone: "good", title: "Early", note: "Before the start." },
      { attemptT: 1, teacherT: null, tone: "weird", title: "Kept", note: "  Spaces   squeezed. " },
    ] }, ctx);
    assert.deepEqual(out.notes, [{ attemptT: 1, teacherT: null, tone: "fix", title: "Kept", note: "Spaces squeezed." }]);
  });

  test("when Gemini couldn't see the move there are no notes, only what to change", () => {
    const out = G.cleanFeedback({ seen: false, summary: "Step back so your feet are in frame.", notes: [{ attemptT: 1, tone: "fix", title: "x", note: "y" }] }, ctx);
    assert.equal(out.seen, false);
    assert.deepEqual(out.notes, []);
    assert.match(out.summary, /Step back/);
  });

  test("garbage in, an empty answer out", () => {
    const out = G.cleanFeedback({ notes: "nope" } as never, ctx);
    assert.deepEqual(out.notes, []);
  });
});

describe("recordings", () => {
  test("WebM, MP4 and MOV are told apart; anything else isn't a video", () => {
    assert.equal(M.sniff(WEBM()), "video/webm");
    assert.equal(M.sniff(MP4()), "video/mp4");
    assert.equal(M.sniff(Buffer.concat([Buffer.from([0, 0, 0, 20]), Buffer.from("ftypqt  ....")])), "video/quicktime");
    assert.equal(M.sniff(Buffer.from("<html>not a video at all</html>")), null);
  });

  test("a location tag is found, a plain recording has none", () => {
    assert.ok(M.hasLocation(MP4("©xyz+29.6516-082.3248/")));
    assert.ok(M.hasLocation(MP4("com.apple.quicktime.location.ISO6709")));
    assert.equal(M.hasLocation(WEBM()), false);
  });
});

describe("giveFeedback", () => {
  test("notes are saved into the plan, and nothing of the recording is left on this Mac", async () => {
    dream("try-ok");
    let seen: Attempt | null = null;
    let existedWhenAsked = false;
    const fb = await M.giveFeedback("try-ok", { path: recording("ok", WEBM(1)), durationS: 6 }, {
      ...keepAsIs(),
      ask: async (a) => ((seen = a), (existedWhenAsked = existsSync(a.attempt.path)), answer()),
    });
    assert.equal(fb.notes[0].title, "Elbow flares");
    assert.ok(existedWhenAsked, "Gemini was given the recording");
    assert.equal(seen!.attempt.mime, "video/webm");
    assert.equal(seen!.teacherS, 4.84);
    assert.deepEqual(seen!.steps.map((s) => s.title), ["Load", "Release"]);
    assert.deepEqual(leftovers(), [], "the temp copy is deleted");
    const plan = JSON.parse(readFileSync(join(process.env.LUCID_DREAMS_DIR!, "try-ok", "experience.json"), "utf8"));
    assert.equal(plan.feedback.notes.length, 1);
    assert.equal(plan.steps.length, 2, "the lesson's own steps are untouched");
    assert.equal(JSON.stringify(plan).includes("attempt-1"), false, "no video bytes in the plan");
    assert.deepEqual((M.feedbackState("try-ok") as { state: string }).state, "ready");
  });

  test("a re-encoded copy replaces the original, and the original is the caller's to delete", async () => {
    dream("try-clean");
    const path = recording("clean", MP4("©xyz+29.6516-082.3248/"));
    let sent: Attempt | null = null;
    await M.giveFeedback("try-clean", { path, durationS: 6 }, {
      teacher,
      now: hourOf(),
      clean: async (_src, _len, out) => (writeFileSync(out, MP4("clean")), out),
      ask: async (a) => ((sent = a), answer()),
    });
    assert.notEqual(sent!.attempt.path, path);
    assert.ok(M.hasLocation(readFileSync(path)), "the original still has its tag: it was never sent");
    assert.deepEqual(leftovers(), []);
  });

  test("a video that carries where it was filmed is refused when it can't be cleaned", async () => {
    dream("try-gps");
    let asked = 0;
    await assert.rejects(
      M.giveFeedback("try-gps", { path: recording("gps", MP4("©xyz+29.6516-082.3248/")), durationS: 6 }, { ...keepAsIs(), ask: async () => (asked++, answer()) }),
      (e: InstanceType<typeof M.FeedbackError>) => e.status === 400 && /where it was filmed/.test(e.message),
    );
    assert.equal(asked, 0);
    assert.deepEqual(leftovers(), []);
  });

  test("never for a private dream, by flag or by id, and Gemini is never asked", async () => {
    dream("try-private", { private: true });
    dream("ian-grandma-lesson");
    let asked = 0;
    for (const id of ["try-private", "ian-grandma-lesson"]) {
      await assert.rejects(
        M.giveFeedback(id, { path: recording(id, WEBM(2)), durationS: 6 }, { ...keepAsIs(), ask: async () => (asked++, answer()) }),
        (e: InstanceType<typeof M.FeedbackError>) => e.status === 403,
      );
      assert.deepEqual(M.feedbackState(id), { state: "off" });
    }
    assert.equal(asked, 0);
  });

  test("never for a held dream", async () => {
    dream("try-held");
    writeFileSync(join(process.env.LUCID_DREAMS_DIR!, ".held"), "try-held\n");
    let asked = 0;
    await assert.rejects(
      M.giveFeedback("try-held", { path: recording("held", WEBM(3)), durationS: 6 }, { ...keepAsIs(), ask: async () => (asked++, answer()) }),
      (e: InstanceType<typeof M.FeedbackError>) => e.status === 404,
    );
    assert.equal(asked, 0);
    assert.deepEqual(M.feedbackState("try-held"), { state: "off" });
  });

  test("needs a lesson from a video: not an avatar, not a plan that isn't a lesson", async () => {
    dream("try-avatar", { kind: "avatar" });
    dream("try-companion", {}, { mode: "companion", steps: undefined });
    for (const id of ["try-avatar", "try-companion"]) {
      await assert.rejects(M.giveFeedback(id, { path: recording(id, WEBM(4)), durationS: 6 }, keepAsIs()), (e: InstanceType<typeof M.FeedbackError>) => e.status >= 400);
      assert.deepEqual(M.feedbackState(id), { state: "off" });
    }
  });

  test("the same recording of the same plan is never sent twice", async () => {
    dream("try-again");
    let asked = 0;
    const deps = { ...keepAsIs(), ask: async () => (asked++, answer()) };
    const a = await M.giveFeedback("try-again", { path: recording("again1", WEBM(5)), durationS: 6 }, deps);
    const b = await M.giveFeedback("try-again", { path: recording("again2", WEBM(5)), durationS: 6 }, deps);
    assert.equal(asked, 1);
    assert.deepEqual(b, a);
  });

  test("a Gemini failure is a sentence, the lock lets go and nothing is left behind", async () => {
    dream("try-fail");
    await assert.rejects(
      M.giveFeedback("try-fail", { path: recording("fail", WEBM(6)), durationS: 6 }, { ...keepAsIs(), ask: async () => { throw new Error('{"error":{"code":429,"status":"RESOURCE_EXHAUSTED"}}'); } }),
      (e: InstanceType<typeof M.FeedbackError>) => e.status === 502 && /quota/i.test(e.message),
    );
    assert.deepEqual(leftovers(), []);
    const ok = await M.giveFeedback("try-fail", { path: recording("fail2", WEBM(7)), durationS: 6 }, { ...keepAsIs(), ask: async () => answer() });
    assert.equal(ok.notes.length, 1);
  });

  test("one at a time", async () => {
    dream("try-busy");
    let release: () => void = () => {};
    const slow = M.giveFeedback("try-busy", { path: recording("slow", WEBM(10)), durationS: 6 }, {
      ...keepAsIs(),
      ask: () => new Promise((res) => (release = () => res(answer()))),
    });
    await new Promise((r) => setTimeout(r, 20));
    await assert.rejects(
      M.giveFeedback("try-busy", { path: recording("busy", WEBM(11)), durationS: 6 }, { ...keepAsIs(), ask: async () => answer() }),
      (e: InstanceType<typeof M.FeedbackError>) => e.status === 429 && /moment/.test(e.message),
    );
    release();
    assert.equal((await slow).notes.length, 1);
  });

  test("at most FEEDBACK_PER_HOUR an hour, then it opens again", async () => {
    dream("try-cap");
    const now = hourOf();
    let asked = 0;
    const deps = { ...keepAsIs(), now, ask: async () => (asked++, answer()) };
    for (let i = 0; i < 3; i++) await M.giveFeedback("try-cap", { path: recording(`cap${i}`, WEBM(40 + i)), durationS: 6 }, deps);
    await assert.rejects(
      M.giveFeedback("try-cap", { path: recording("cap3", WEBM(43)), durationS: 6 }, deps),
      (e: InstanceType<typeof M.FeedbackError>) => e.status === 429 && /hour/.test(e.message),
    );
    assert.equal(asked, 3);
    const t = now() + 3600_001;
    const later = await M.giveFeedback("try-cap", { path: recording("cap4", WEBM(44)), durationS: 6 }, { ...deps, now: () => t });
    assert.equal(later.notes.length, 1);
  });

  test("a recording that isn't a video, is empty or is too long is turned away before Gemini", async () => {
    dream("try-bad");
    let asked = 0;
    const ask = async () => (asked++, answer());
    const bad = (bytes: Buffer, durationS: number, status: number) =>
      assert.rejects(M.giveFeedback("try-bad", { path: recording(`bad${status}${durationS}`, bytes), durationS }, { ...keepAsIs(), ask }), (e: InstanceType<typeof M.FeedbackError>) => e.status === status);
    await bad(Buffer.from("<html></html>"), 6, 400);
    await bad(Buffer.alloc(0), 6, 400);
    await bad(WEBM(20), 31, 400);
    await bad(WEBM(21), 0.2, 400);
    assert.equal(asked, 0);
  });
});

describe("the route", () => {
  const post = (id: string, bytes: Buffer, durationS = "6") => {
    const body = new FormData();
    body.append("durationS", durationS);
    body.append("attempt", new Blob([new Uint8Array(bytes)]), "attempt");
    return route.POST(new Request(`http://localhost/api/dreams/${id}/feedback`, { method: "POST", body }), { params: Promise.resolve({ id }) });
  };

  test("a private dream's attempt is refused and its upload is gone", async () => {
    dream("route-private", { private: true });
    const r = await post("route-private", WEBM(30));
    assert.equal(r.status, 403);
    assert.match((await r.json()).error, /private/);
    assert.deepEqual(leftovers(), []);
  });

  test("something that isn't multipart is a 400", async () => {
    dream("route-plain");
    const r = await route.POST(new Request("http://localhost/x", { method: "POST", body: "hi" }), { params: Promise.resolve({ id: "route-plain" }) });
    assert.equal(r.status, 400);
  });

  test("another website's form post is refused, this page's own is not", async () => {
    dream("route-origin");
    const body = () => { const f = new FormData(); f.append("durationS", "6"); f.append("attempt", new Blob([new Uint8Array(WEBM(32))])); return f; };
    const from = (origin: string) => route.POST(
      new Request("http://localhost:5170/x", { method: "POST", body: body(), headers: { origin, host: "localhost:5170" } }),
      { params: Promise.resolve({ id: "route-origin" }) },
    );
    assert.equal((await from("https://evil.example")).status, 403);
    assert.notEqual((await from("http://localhost:5170")).status, 403);
  });

  test("any ian-grandma id is private, in any case, and is refused before its upload is read", async () => {
    for (const id of ["ian-grandma2", "ian-grandmaX", "ian-grandma.old", "IAN-GRANDMA"]) {
      dream(id);
      assert.equal((await post(id, WEBM(33))).status, 403, id);
    }
    assert.deepEqual(leftovers(), []);
  });

  test("a missing dream is a 404", async () => {
    assert.equal((await post("no-such-dream", WEBM(31))).status, 404);
    assert.deepEqual(leftovers(), []);
  });

  test("GET says whether the button should be there", async () => {
    dream("route-get");
    const r = await route.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "route-get" }) });
    assert.deepEqual(await r.json(), { state: "none" });
    const p = await route.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id: "route-private" }) });
    assert.deepEqual(await p.json(), { state: "off" });
  });
});
