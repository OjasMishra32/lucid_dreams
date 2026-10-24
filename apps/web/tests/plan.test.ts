import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { clean, type Plan } from "../lib/bridge/gemini";
import { compare, fromExperience, loadCases, type IntentCase } from "./intents";

// clean() with canned model outputs: no key, no network. npm run test:plan

const D = 4.84; // the pipeline's 5-second window
const STEPS = [
  { start: 0, end: 1.6, title: "Load", tip: "Sink your hips.", speed: 0.5, repeat: 2 },
  { start: 1.6, end: 3.2, title: "Rise", tip: "Drive up through your legs." },
  { start: 3.2, end: 4.8, title: "Release", tip: "Flick your wrist." },
];
const replay = (intent: string | null, more: Partial<Plan> = {}): Plan => ({
  name: "Test", intent, kind: "replay", durationS: D, video: { path: "window.mp4", offsetS: 0, orbit: false }, ...more,
});
const avatar = (intent: string | null): Plan => ({ name: "Test", intent, kind: "avatar", durationS: D, photo: { path: "photo.jpg", mime: "image/jpeg" } });
const answer = (fields: Record<string, unknown>) => ({ title: "A plan", summary: "What they do.", ...fields });
const plan = (c: IntentCase): Plan => ({ name: c.name, intent: c.sentence, kind: c.kind, durationS: D, intentOnly: true });

describe("the forty sentences", () => {
  const cases = loadCases();

  test("the file is well-formed: ten per mode, every showcase moment", () => {
    assert.equal(cases.length, 40);
  });

  test("a right answer from the model stays right", () => {
    for (const c of cases) {
      const e = c.expect;
      const raw = answer({
        mode: e.mode,
        place: e.place,
        ...(e.environment ? { environment: e.environment } : {}),
        objects: e.objects.map((o) => o.split("|")[0]),
        ...(e.strength ? { strength: e.strength } : {}),
        ...(e.mode === "teach" ? { steps: STEPS } : {}),
      });
      assert.deepEqual(compare(e, fromExperience(clean(raw, plan(c)))), [], `${c.id}: "${c.sentence}"`);
    }
  });

  test("companions and chess come out right even when the model slips on place, room and props", () => {
    for (const c of cases.filter((c) => c.expect.mode === "companion" || c.expect.mode === "play")) {
      const raw = answer({ mode: c.expect.mode, place: "beside", objects: ["Hand"] });
      assert.deepEqual(compare(c.expect, fromExperience(clean(raw, plan(c)))), [], `${c.id}: "${c.sentence}"`);
    }
  });

  test("an avatar asked for chess plays it, whatever mode the model picked", () => {
    // (except below: company asked for, and heard)
    for (const c of cases.filter((c) => /chess/.test(c.sentence))) {
      const e = clean(answer({ mode: "companion", place: "facing" }), plan(c));
      assert.deepEqual(compare(c.expect, fromExperience(e)), [], `${c.id}: "${c.sentence}"`);
    }
  });
});

describe("chess", () => {
  test("needs an avatar across the board: a replay asked to play is watched instead", () => {
    const e = clean(answer({ mode: "play", place: "facing", strength: "gm" }), replay("play chess with me"));
    assert.equal(e.mode, "watch");
    assert.equal(e.play, undefined);
  });

  test("the strength the sentence names wins over the model's", () => {
    const at = (intent: string, strength?: string) => clean(answer({ mode: "play", place: "facing", strength }), avatar(intent)).play?.strength;
    assert.equal(at("play chess with me at Magnus Carlsen's level", "gm"), "carlsen");
    assert.equal(at("a game at Bobby Fischer's peak rating", "club"), "fischer");
    assert.equal(at("give me a grandmaster-level chess game", "master"), "gm");
    assert.equal(at("challenge me like a chess master would", "gm"), "master");
    assert.equal(at("play chess, go easy on me", "max"), "club");
    assert.equal(at("play chess against me at full strength", "club"), "max");
    assert.equal(at("everything you’ve got at chess", "club"), "max"); // a phone's curly apostrophe
  });

  test("a level the sentence doesn't plainly name is the model's", () => {
    const at = (intent: string, strength?: string) => clean(answer({ mode: "play", place: "facing", strength }), avatar(intent)).play?.strength;
    assert.equal(at("play chess with me and don't go easy on me", "max"), "max");
    assert.equal(at("play chess with me, don’t go easy", "gm"), "gm");
    assert.equal(at("a chess game, not too casual please", "expert"), "expert");
    assert.equal(at("play chess with me and don't go easy on me"), "club");
  });

  test("otherwise the model's strength, else club", () => {
    assert.equal(clean(answer({ mode: "play", place: "facing", strength: "expert" }), avatar("play chess with me")).play?.strength, "expert");
    assert.equal(clean(answer({ mode: "play", place: "facing", strength: "superhuman" }), avatar("play chess with me")).play?.strength, "club");
    assert.equal(clean(answer({ mode: "play", place: "facing" }), avatar("play chess with me")).play?.strength, "club");
  });

  test("a play plan faces you, in your room, with a chessboard first", () => {
    const e = clean(answer({ mode: "play", place: "ahead", objects: ["chess clock", "Chess Board"] }), avatar("play chess with me"));
    assert.equal(e.place, "facing");
    assert.equal(e.environment, "room");
    assert.deepEqual(e.objects, ["chessboard", "chess clock"]);
  });
});

describe("companions", () => {
  test("an avatar asked for company keeps it when chess only comes up", () => {
    const e = clean(answer({ mode: "companion", place: "facing" }), avatar("we used to play chess, I just want to sit with him"));
    assert.equal(e.mode, "companion");
    assert.equal(e.play, undefined);
    assert.equal(e.environment, "room");
    // the model heard a game: it plays
    assert.equal(clean(answer({ mode: "watch", place: "facing" }), avatar("sit with me and play chess")).mode, "play");
  });

  test("face you and stay in your room", () => {
    const e = clean(answer({ mode: "companion", place: "beside", objects: [] }), replay("sit next to me on the couch like old times"));
    assert.equal(e.place, "facing");
    assert.equal(e.environment, "room");
    assert.equal(e.objects, undefined);
  });

  test("go where the user names", () => {
    assert.equal(clean(answer({ mode: "companion", place: "facing" }), replay("take me to the mountains with my brother")).environment, "mountains");
    assert.equal(clean(answer({ mode: "companion", place: "facing", environment: "studio" }), replay("dance with me at my wedding")).environment, "studio");
  });

  test("never pick up a lesson's props from what the user does meanwhile", () => {
    const e = clean(answer({ mode: "companion", place: "facing" }), replay("keep me company while I play guitar"));
    assert.equal(e.objects, undefined);
    assert.equal(e.environment, "room");
  });
});

describe("lessons", () => {
  const lesson = (intent: string, fields: Record<string, unknown> = {}) =>
    clean(answer({ mode: "teach", place: "facing", steps: STEPS, ...fields }), replay(intent));

  test("an instrument sits beside you, in the concert hall, with the instrument", () => {
    const e = lesson("teach me this strum", { category: "Guitar" });
    assert.equal(e.place, "beside");
    assert.equal(e.environment, "concert-hall");
    assert.deepEqual(e.objects, ["guitar"]);
    assert.deepEqual(lesson("teach me this piece", { category: "Piano" }).objects, ["piano", "bench"]);
    assert.deepEqual(lesson("help me learn this trumpet solo").objects, ["trumpet"]);
    assert.deepEqual(lesson("teach me to play the sax").objects, ["saxophone"]);
  });

  test("'next to me' is beside, whatever the activity", () => {
    assert.equal(lesson("sit next to me and teach me this piece").place, "beside");
    assert.equal(lesson("stand next to me and teach me this jab", { place: "ahead" }).place, "beside");
  });

  test("a whole-body move is ahead of you, at its home", () => {
    const shot = lesson("teach me this jump shot", { objects: ["Basketball hoop"] });
    assert.equal(shot.place, "ahead");
    assert.equal(shot.environment, "court");
    assert.deepEqual(shot.objects, ["basketball", "hoop"]);
    assert.equal(lesson("teach me this salsa step").environment, "studio");
    assert.equal(lesson("teach me this boxing combo").environment, "ring");
    assert.equal(lesson("coach me through this squat").environment, "gym");
    const serve = lesson("break down her tennis serve for me");
    assert.equal(serve.place, "ahead");
    assert.equal(serve.environment, "room"); // the court is a basketball court: said out loud, so no player picks it from "serve"
    assert.equal(lesson("teach me this tennis drop shot").environment, "room"); // the players' own words would say court
    assert.deepEqual(lesson("teach me this crossover dribble").objects, ["basketball"]); // no shot, no hoop
  });

  test("hands-on work faces you, in your room", () => {
    const e = lesson("teach me how she flips the omelette", { place: "ahead", objects: ["Frying pans", "spatula"] });
    assert.equal(e.place, "facing");
    assert.equal(e.environment, "room");
    assert.deepEqual(e.objects, ["pan", "spatula"]);
  });

  test("words inside other activities don't count", () => {
    const box = lesson("show me how to fold this paper box", { place: "ahead" });
    assert.equal(box.place, "facing");
    assert.equal(box.environment, "room"); // not the ring the players would pick from "box"
    assert.equal(lesson("teach me to knit this jumper").environment, "room"); // nor the court from "jumper"
    assert.equal(lesson("teach me to make this salsa", { place: "ahead" }).place, "ahead"); // cooking or dance: the model's call
    assert.equal(lesson("teach me to make this salsa").environment, undefined);
  });

  test("the model's environment stands; a named place wins over it", () => {
    assert.equal(lesson("teach me this jump shot", { environment: "gym" }).environment, "gym");
    assert.equal(lesson("teach me this jump shot in my driveway", { environment: "court" }).environment, "room");
    assert.equal(lesson("teach me this yoga flow in the mountains", { environment: "studio" }).environment, "mountains");
  });

  test("exercises and things named after places aren't places", () => {
    assert.equal(lesson("coach me through these mountain climbers", { environment: "gym" }).environment, "gym");
    assert.equal(lesson("coach me through these mountain climbers").environment, undefined);
    assert.equal(lesson("teach me the mountain pose", { environment: "studio" }).environment, "studio");
    assert.equal(lesson("teach me the jump shot I hit on my home court").environment, "court");
    assert.equal(lesson("teach me this deadlift in my home gym", { environment: "gym" }).environment, "gym");
    assert.equal(lesson("teach me this jump shot at home").environment, "room");
  });

  test("martial arts are at home in the ring, like the players say", () => {
    const e = lesson("teach me this karate kata", { place: "facing" });
    assert.equal(e.place, "ahead");
    assert.equal(e.environment, "ring");
  });

  test("a photo can't teach, and a clip needs two steps", () => {
    assert.equal(clean(answer({ mode: "teach", place: "ahead", steps: STEPS }), avatar("teach me this")).mode, "companion");
    assert.equal(lesson("teach me this jump shot", { steps: [STEPS[0]] }).mode, "watch");
  });

  test("a sentence-only test of a replay can still teach", () => {
    const e = clean(answer({ mode: "teach", place: "ahead", steps: STEPS }), { name: "Test", intent: "teach me this jump shot", kind: "replay", durationS: D, intentOnly: true });
    assert.equal(e.mode, "teach");
    assert.equal(e.steps?.length, 3);
  });

  test("steps stay inside the clip, in order, without overlaps, at sane speeds", () => {
    const e = lesson("teach me this jump shot", {
      steps: [
        { start: 3, end: 9, title: "Release", speed: 4, repeat: 9 },
        { start: -1, end: 3.4, title: "Load", speed: 0.1, repeat: 0 },
        { start: 1, end: 1.1, title: "Blink" },
      ],
    });
    assert.deepEqual(e.steps, [
      { start: 0, end: 3, title: "Load", tip: undefined, speed: 0.25, repeat: 1 },
      { start: 3, end: 4.8, title: "Release", tip: undefined, speed: 1, repeat: 3 },
    ]);
  });
});

describe("watching", () => {
  const watch = (intent: string, fields: Record<string, unknown> = {}) => clean(answer({ mode: "watch", place: "facing", ...fields }), replay(intent));

  test("following along puts them ahead of you", () => {
    assert.equal(watch("I want to follow along with this workout").place, "ahead");
    assert.equal(watch("put her dance on so I can dance along").place, "ahead");
    assert.equal(watch("let me watch her dance this ballet solo").place, "facing");
  });

  test("an activity's home fills a missing environment; a named place wins", () => {
    assert.equal(watch("I just want to hear him play the piano").environment, "concert-hall");
    assert.deepEqual(watch("I just want to hear him play the piano").objects, ["piano", "bench"]);
    assert.equal(watch("let me watch his tai chi in the mountains", { environment: "studio" }).environment, "mountains");
    assert.equal(watch("play back grandpa's toast from the wedding").environment, undefined);
    assert.equal(watch("play this cello piece for me").mode, "watch"); // "play" is playback, not chess
  });
});

describe("objects", () => {
  test("are lowercase singular nouns, deduplicated, at most four", () => {
    const e = clean(
      answer({ mode: "watch", place: "facing", objects: ["Dumbbells", "the bench", "Left hand!", "hands", "", 3, "dumbbell", "kettlebells", "water bottles", "jump rope"] }),
      replay("let me watch this"),
    );
    assert.deepEqual(e.objects, ["dumbbell", "bench", "kettlebell", "water bottle"]);
  });

  test("plurals the plain rules would get wrong", () => {
    const e = clean(answer({ mode: "watch", place: "facing", objects: ["Tomatoes", "bay leaves", "Blueberries", "cookies"] }), replay("let me watch this"));
    assert.deepEqual(e.objects, ["tomato", "bay leaf", "blueberry", "cookie"]);
    const f = clean(answer({ mode: "watch", place: "facing", objects: ["canoes", "oboes", "shoes", "glasses"] }), replay("let me watch this"));
    assert.deepEqual(f.objects, ["canoe", "oboe", "glasses"]); // a shoe is clothing
  });

  test("plain names for the same thing", () => {
    const e = clean(answer({ mode: "watch", place: "facing", objects: ["Chess pieces", "skillet", "knives", "drums"] }), replay("let me watch this"));
    assert.deepEqual(e.objects, ["chessboard", "pan", "knife", "drum kit"]);
  });
});

describe("whatever comes back", () => {
  test("nonsense still makes a valid plan", () => {
    const e = clean({ mode: "dance", place: "upside down", environment: "moon", objects: "ball", steps: "many" }, replay(null));
    assert.equal(e.mode, "watch");
    assert.equal(e.place, "facing");
    assert.equal(e.environment, undefined);
    assert.equal(e.objects, undefined);
    assert.equal(e.title, "Test");
  });
});
