// The loading page's progress (loading.ts): bytes stream in and add up across files, a length the server never sent
// still finishes at what came in, and a failed file is reported and rethrown; with the files the page waits for named up
// front (their sizes from a HEAD each), the total is known before any byte arrives and the bar never runs backwards,
// however late a file starts.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadProgress, expectedFiles, megabytes } from "../../src/court/loading.ts";

/** A fetch that answers with these chunks (and a Content-Length when given). */
const fake = (chunks: number[], length?: number, status = 200): typeof fetch =>
  (async () => {
    const body = new ReadableStream<Uint8Array>({
      start(c) {
        for (const n of chunks) c.enqueue(new Uint8Array(n).fill(7));
        c.close();
      },
    });
    return new Response(body, { status, headers: length === undefined ? {} : { "Content-Length": String(length) } });
  }) as typeof fetch;

test("bytes stream in with their progress, and add up across files", async () => {
  const p = new LoadProgress();
  const seen: number[] = [];
  const watch = (async (url: string) => {
    const res = await fake([3, 4, 5], 12)(url);
    return res;
  }) as typeof fetch;
  const a = p.bytes("/bundle/a", "a", watch);
  const b = p.bytes("/bundle/b", "b", fake([10], 10));
  seen.push(p.snapshot().files);
  const [ba, bb] = await Promise.all([a, b]);
  assert.equal(ba.length, 12);
  assert.equal(ba[11], 7);
  assert.equal(bb.length, 10);
  const s = p.snapshot();
  assert.deepEqual([s.loaded, s.total, s.files, s.done, s.pending], [22, 22, 2, 2, []]);
  assert.equal(seen[0], 2, "a file reports as soon as it starts");
  assert.equal(megabytes({ ...s, loaded: 87e6, total: 190e6 }), "87 / 190 MB");
});

test("a file mid-way counts its bytes against its length, and is pending", () => {
  const p = new LoadProgress();
  p.progress("show", 40, 100);
  p.progress("shooter", 5, 0); // no length yet
  const s = p.snapshot();
  assert.deepEqual([s.loaded, s.total, s.done], [45, 105, 0]);
  assert.deepEqual(s.pending, ["show", "shooter"]);
  p.finished("shooter");
  assert.deepEqual([p.snapshot().loaded, p.snapshot().total], [45, 105]);
});

test("no Content-Length: the file finishes at what came in", async () => {
  const p = new LoadProgress();
  assert.equal((await p.bytes("/x", "x", fake([6, 6]))).length, 12);
  assert.deepEqual([p.snapshot().loaded, p.snapshot().total], [12, 12]);
});

test("a failed file is in the errors, done, and rethrown", async () => {
  const p = new LoadProgress();
  await assert.rejects(p.bytes("/x", "show video", fake([], 0, 404)), /HTTP 404/);
  const s = p.snapshot();
  assert.deepEqual(s.errors, ["show video: HTTP 404"]);
  assert.equal(s.done, 1);
});

/** A HEAD that answers each URL with its size (404 for a URL it doesn't know). */
const heads = (sizes: Record<string, number>): typeof fetch =>
  (async (url: string, init?: RequestInit) => {
    assert.equal(init?.method, "HEAD");
    const n = sizes[url];
    return n === undefined ? new Response(null, { status: 404 }) : new Response(null, { status: 200, headers: { "Content-Length": String(n) } });
  }) as typeof fetch;

test("expected files: the total is known before any byte, and a file that starts late never sends the bar backwards", async () => {
  const p = new LoadProgress();
  await p.expect([{ key: "the show", url: "/bundle/show" }, { key: "players/a/freeze.ply", url: "/bundle/a" }, { key: "players/a/reality.ply", url: "/bundle/r" }], heads({ "/bundle/show": 100, "/bundle/a": 30, "/bundle/r": 20 }));
  const fractions: number[] = [];
  const look = () => {
    const s = p.snapshot();
    assert.equal(s.total, 150, "the total from the start");
    fractions.push(s.loaded / s.total);
  };
  look();
  // the first batch: the show and the splats, in pieces; the reality splats only once those are in (as under ?probe)
  for (const n of [10, 50, 100]) (p.progress("the show", n, 100), look());
  p.progress("players/a/freeze.ply", 30, 30);
  p.finished("the show");
  p.finished("players/a/freeze.ply");
  look();
  p.progress("players/a/reality.ply", 0, 0);
  look();
  p.progress("players/a/reality.ply", 20, 20);
  p.finished("players/a/reality.ply");
  look();
  assert.deepEqual(fractions, [...fractions].sort((a, b) => a - b), `never backwards: ${fractions.join(", ")}`);
  assert.equal(fractions.at(-1), 1, "and it ends full");
  const s = p.snapshot();
  assert.deepEqual([s.files, s.done, s.pending], [3, 3, []]);
});

test("expected files: until every size is known the total reads 0 (the bar waits instead of jumping)", async () => {
  const p = new LoadProgress();
  let answer: () => void = () => {};
  const slow = (async (url: string, init?: RequestInit) => {
    if (url === "/b") await new Promise<void>((r) => (answer = r));
    return heads({ "/a": 10, "/b": 90 })(url, init);
  }) as typeof fetch;
  const sized = p.expect([{ key: "a", url: "/a" }, { key: "b", url: "/b" }], slow);
  p.progress("a", 10, 10);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(p.snapshot().total, 0, "b's size is still out");
  answer();
  await sized;
  assert.deepEqual([p.snapshot().loaded, p.snapshot().total], [10, 100]);
});

test("expected files: a HEAD that fails leaves the file's own Content-Length to count", async () => {
  const p = new LoadProgress();
  await p.expect([{ key: "a", url: "/a" }, { key: "gone", url: "/nowhere" }], heads({ "/a": 10 }));
  assert.equal(p.snapshot().total, 10);
  p.progress("gone", 0, 40);
  assert.equal(p.snapshot().total, 50);
});

test("expectedFiles: the show stream and every splat file loaded before the page is ready, under the keys their loaders report", () => {
  const bundle = {
    court: {
      video: { file: "video/show.h264" },
      freeze: {
        players: [{ splats: "players/s/freeze.ply", reality: "players/s/reality.ply" }, { splats: "players/d/freeze.ply", reality: "players/d/reality.ply" }],
        others: [
          { kind: "splats", file: "others/t/freeze.ply", reality: "others/t/reality.ply" },
          { kind: "relief", file: "others/r/relief.glb", reality: "others/r/reality.glb" },
        ],
      },
    },
    file: (path: string) => `/bundle/${path}`,
  } as unknown as Parameters<typeof expectedFiles>[0];
  const keys = (o: { reality: boolean; element: boolean }) => expectedFiles(bundle, o).map((f) => `${f.key} ${f.url}`);
  assert.deepEqual(keys({ reality: false, element: false }), [
    "the show /bundle/video/show.h264",
    "players/s/freeze.ply /bundle/players/s/freeze.ply",
    "players/d/freeze.ply /bundle/players/d/freeze.ply",
    "others/t/freeze.ply /bundle/others/t/freeze.ply",
  ]);
  assert.deepEqual(keys({ reality: true, element: true }), [
    "players/s/freeze.ply /bundle/players/s/freeze.ply",
    "players/d/freeze.ply /bundle/players/d/freeze.ply",
    "others/t/freeze.ply /bundle/others/t/freeze.ply",
    "players/s/reality.ply /bundle/players/s/reality.ply",
    "players/d/reality.ply /bundle/players/d/reality.ply",
    "others/t/reality.ply /bundle/others/t/reality.ply",
  ]);
});
