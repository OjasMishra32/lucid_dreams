// The loading page's progress (loading.ts): bytes stream in and add up across files, a length the server never sent
// still finishes at what came in, and a failed file is reported and rethrown.
import { test } from "node:test";
import assert from "node:assert/strict";
import { LoadProgress, megabytes } from "../../src/court/loading.ts";

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
