import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";

// Which run /live shows, and which it never does, in the bridge's mock mode (no HiPerGator anywhere near).

const root = mkdtempSync(join(tmpdir(), "lucid-live-state-"));
process.env.LUCID_DREAMS_DIR = join(root, "dreams");
process.env.LUCID_DATA_DIR = join(root, "data");
delete process.env.BRIDGE_MODE;

let live: typeof import("../lib/bridge/liveRun");
let store: typeof import("../lib/bridge/store");
let route: typeof import("../app/api/live/run/route");
let peek: typeof import("../app/api/live/peek/route");

const job = (id: string, name: string, ageS: number, more: Record<string, unknown> = {}) =>
  store.putJob({ id, name, kind: "replay", mode: "mock", file: "/x.mp4", fileName: "x.mp4", startS: 0, createdAt: Date.now() - ageS * 1000, ...more } as never);

before(async () => {
  live = await import("../lib/bridge/liveRun");
  store = await import("../lib/bridge/store");
  route = await import("../app/api/live/run/route");
  peek = await import("../app/api/live/peek/route");
  mkdirSync(process.env.LUCID_DREAMS_DIR!, { recursive: true });
  job("jump-shot", "Jump shot", 20); // working (the mock takes 60 s)
  job("older-one", "Older one", 600); // finished long ago
  job("ian-grandma-avatar", "Grandma", 5, { kind: "avatar" }); // private by id, newest and working
  job("legend", "A legend", 10); // held
  job("flagged", "Flagged", 8); // private by flag in its dream.json
  mkdirSync(join(process.env.LUCID_DREAMS_DIR!, "flagged"));
  writeFileSync(join(process.env.LUCID_DREAMS_DIR!, "flagged", "dream.json"), JSON.stringify({ id: "flagged", name: "Flagged", kind: "replay", private: true }));
  writeFileSync(join(process.env.LUCID_DREAMS_DIR!, ".held"), "legend\n");
});
after(() => rmSync(root, { recursive: true, force: true }));

test("without a choice it shows the run that is working, never a private or held one", async () => {
  const s = await live.liveState(null);
  assert.equal(s.run?.id, "jump-shot");
  assert.equal(s.run?.source, "job");
  assert.deepEqual(s.run?.stages.map((x) => x.stage), ["upload", "check", "views", "reconstruct", "export"]);
  const ids = s.choices.map((c) => c.id);
  assert.deepEqual(ids.sort(), ["jump-shot", "older-one"]);
  assert.equal(s.choices.find((c) => c.id === "jump-shot")!.live, true);
});

test("asking for a private or held run by name gets a different one, and nothing of theirs", async () => {
  for (const want of ["ian-grandma-avatar", "ian-grandma", "legend", "flagged"]) {
    const s = await live.liveState(want);
    assert.equal(s.run?.id, "jump-shot", want);
    assert.equal(JSON.stringify(s).includes(want), false, `${want} appears nowhere`);
  }
  assert.equal(await live.liveRun("ian-grandma-avatar"), null);
  assert.equal(await live.liveRun("legend"), null);
});

test("a run asked for by name is the one shown; auto lets a finished one give way to a working one", async () => {
  assert.equal((await live.liveState("older-one")).run?.id, "older-one");
  assert.equal((await live.liveState("older-one", true)).run?.id, "jump-shot");
  assert.equal((await live.liveState("jump-shot", true)).run?.id, "jump-shot");
});

test("the API says the same, and a made-up or hostile id is just ignored", async () => {
  const ask = async (q: string) => (await route.GET(new Request(`http://localhost/api/live/run${q}`))).json();
  assert.equal((await ask("?run=jump-shot")).run.id, "jump-shot");
  assert.equal((await ask("?run=../../etc")).run.id, "jump-shot");
  assert.equal((await ask("?run=ian-grandma-avatar")).run.id, "jump-shot");
});

test("no strips in mock mode, and the strip route refuses what isn't one", async () => {
  const get = (q: string) => peek.GET(new Request(`http://localhost/api/live/peek${q}`));
  assert.equal((await get("?run=jump-shot&name=peek-000000.jpg&at=1791999000")).status, 404);
  assert.equal((await get("?run=ian-grandma&name=peek-000000.jpg&at=1791999000")).status, 404);
  assert.equal((await get("")).status, 404);
});
