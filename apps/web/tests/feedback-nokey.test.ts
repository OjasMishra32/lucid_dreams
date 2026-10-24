import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

// With no GEMINI_API_KEY, "Watch me try" is off everywhere: no button, no call. (Its own file, so its own process.)

const root = mkdtempSync(join(tmpdir(), "lucid-feedback-nokey-"));
process.env.LUCID_DREAMS_DIR = join(root, "dreams");
process.env.LUCID_DATA_DIR = join(root, "data");
delete process.env.GEMINI_API_KEY;
after(() => rmSync(root, { recursive: true, force: true }));

test("no key: state off, and an attempt is turned away before anything is read or sent", async () => {
  const dir = join(root, "dreams", "lesson");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "dream.json"), JSON.stringify({ id: "lesson", name: "Lesson", kind: "replay", durationS: 4.84, intent: "teach me", experience: "experience.json", createdAt: "2026-10-24T03:00:00Z" }));
  writeFileSync(join(dir, "experience.json"), JSON.stringify({
    intent: "teach me", mode: "teach", title: "T", summary: "", place: "ahead", createdAt: "2026-10-24T03:05:00Z",
    steps: [{ start: 0, end: 1.6, title: "Load" }, { start: 1.6, end: 3.2, title: "Release" }],
  }));
  const M = await import("../lib/bridge/feedback");
  const { GEMINI_ON } = await import("../lib/bridge/experience");
  assert.equal(GEMINI_ON, false);
  assert.deepEqual(M.feedbackState("lesson"), { state: "off" });
  let asked = 0;
  await assert.rejects(
    M.giveFeedback("lesson", { path: join(root, "missing.webm"), durationS: 6 }, { ask: async () => (asked++, { summary: "", seen: true, notes: [], attemptS: 6, source: "clip" }) }),
    (e: InstanceType<typeof M.FeedbackError>) => e.status === 503 && /no Gemini key/.test(e.message),
  );
  assert.equal(asked, 0);
});
