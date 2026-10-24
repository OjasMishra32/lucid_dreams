// Tests for qa/offline.mjs's file lists: what the main show needs and what each fallback adds. Pure node, no browser.
//   node --test apps/webxr/scripts/court/qa/offline.test.mjs
import { test } from "node:test";
import assert from "node:assert/strict";
import { filePaths, wanted } from "./offline.mjs";

const court = {
  title: "Stand-in",
  video: {
    file: "video/show.h264",
    frames: "video/frames.json",
    cards: "video/cards.json",
    fallbacks: {
      small: { file: "video/show-small.h264", codec: "avc1.640033", width: 1280, height: 1800 },
      hz90: { file: "video/show-90.h264", frames: "video/frames-90.json", cards: "video/cards-90.json", displayHz: 90 },
    },
  },
  freeze: { players: [{ id: "a", splats: "players/a/freeze.ply" }] },
};

test("file paths are bundle-relative strings that look like files, nothing outside the bundle", () => {
  assert.deepEqual(filePaths({ a: "x/y.png", b: ["../up.png", "/abs.png", "no-extension", 3], c: { d: "z.spz" } }).sort(), ["x/y.png", "z.spz"]);
});

test("the main show is court.json and every file outside video.fallbacks", () => {
  assert.deepEqual(wanted(court).main.sort(), ["court.json", "players/a/freeze.ply", "video/cards.json", "video/frames.json", "video/show.h264"]);
});

test("each fallback lists its own files, and null when the bundle has none", () => {
  const { fallbacks } = wanted(court);
  assert.deepEqual(fallbacks.small, ["video/show-small.h264"]);
  assert.deepEqual(fallbacks.hz90.sort(), ["video/cards-90.json", "video/frames-90.json", "video/show-90.h264"]);
  assert.equal(fallbacks.element, null);
  assert.deepEqual(wanted({ ...court, video: { ...court.video, fallbacks: { element: "video/pass1.mp4" } } }).fallbacks.element, ["video/pass1.mp4"]);
});
