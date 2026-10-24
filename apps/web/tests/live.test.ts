import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

// /live offline: HiPerGator's answers are canned text or a stand-in lucid_runner.py that runs the same shell script on
// this machine. Nothing here talks to HiPerGator. npm run test:live

const root = mkdtempSync(join(tmpdir(), "lucid-live-"));
const hpg = join(root, "hpg"); // the stand-in's "remote" filesystem
process.env.LUCID_DREAMS_DIR = join(root, "dreams");
process.env.LUCID_DATA_DIR = join(root, "data");
process.env.LUCID_RUNNER_DIR = join(root, "runner");
process.env.FAKE_REMOTE = hpg;
process.env.BRIDGE_MODE = "runner"; // peekFile only fetches in runner mode; the stand-in answers, not HiPerGator
const python = (() => {
  try {
    return execFileSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" }).trim();
  } catch {
    return null;
  }
})();

type L = typeof import("../lib/bridge/liveRun");
let L: L;
const NOW = 1_792_000_000;

const STATUS = {
  stages: {
    views: { state: "done", startedAt: NOW - 1500, endedAt: NOW - 1128 },
    reconstruct: { state: "running", startedAt: NOW - 1100 },
  },
};
const JOB = { id: "jump-shot", kind: "replay", frames: 121, submittedAt: NOW - 1600 };
const SQUEUE = [
  "9001_0|lucid-recon|RUNNING|hpg-b200|gres:gpu:1|c0701a-s2",
  "9001_1|lucid-recon|RUNNING|hpg-b200|gres:gpu:1|c0701a-s3",
  "9001_[2-11]|lucid-recon|PENDING|hpg-b200|gres:gpu:1|",
  "9002|lucid-export|PENDING|hpg-b200|gres:gpu:1|",
  "9003|someone-elses-job|RUNNING|hpg-b200|gres:gpu:4|c0900a-s1",
].join("\n");
const CANNED = `@@now
${NOW}
@@status
${JSON.stringify(STATUS)}
@@job
${JSON.stringify(JOB)}
@@slurm
{"views": "8999", "reconstruct": "9001", "export": "9002", "chunks": 12}
@@frames
47
@@peeks
${NOW - 60} recon/peek-000011.jpg
${NOW - 50} recon/peek-source-000011.jpg
${NOW - 900} recon/peek-source-000000.jpg
${NOW - 905} recon/peek-000000.jpg
@@squeue
${SQUEUE}
`;
const RUNNING = { id: "jump-shot", status: "running", stage: "reconstruct", progress: 0.62, etaS: 700, message: "Building them in 3D, frame by frame" } as const;

before(async () => {
  L = await import("../lib/bridge/liveRun");
  mkdirSync(join(root, "runner"), { recursive: true });
  mkdirSync(join(root, "runner", "bin"), { recursive: true });
  if (process.platform === "darwin") {
    // GNU stat -c '%Y %n' as macOS's stat: HiPerGator's is GNU
    writeFileSync(join(root, "runner", "bin", "stat"), '#!/bin/sh\nshift 2\nfor f in "$@"; do /usr/bin/stat -f "%m $f" "$f"; done\n', { mode: 0o755 });
  }
  writeFileSync(join(root, "runner", "lucid_runner.py"), `import os, shutil, subprocess
REMOTE = os.environ["FAKE_REMOTE"]
HOST = "fake"
def remote(cmd):
    env = dict(os.environ, PATH=os.path.join(os.path.dirname(__file__), "bin") + os.pathsep + os.environ["PATH"])
    return subprocess.run(["sh", "-c", cmd], capture_output=True, text=True, check=True, env=env).stdout
def rsync(src, dst, *extra):
    shutil.copyfile(src.split(":", 1)[1], dst)
`);
});
after(() => rmSync(root, { recursive: true, force: true }));

describe("parseDetails", () => {
  test("reads the stages, the job, the frames, the strips and the queue", () => {
    const d = L.parseDetails(CANNED)!;
    assert.equal(d.now, NOW);
    assert.equal(d.stages.views.endedAt, NOW - 1128);
    assert.equal(d.job?.frames, 121);
    assert.equal(d.frames, 47);
    assert.deepEqual(d.peeks.map((p) => p.name), ["peek-000011.jpg", "peek-source-000011.jpg", "peek-source-000000.jpg", "peek-000000.jpg"]);
    assert.equal(d.squeue.length, 5);
  });

  test("a run folder that isn't there, or no answer, is null; a half-written file doesn't break the rest", () => {
    assert.equal(L.parseDetails("@@missing\n"), null);
    assert.equal(L.parseDetails(""), null);
    const d = L.parseDetails("@@now\n5\n@@status\n{\"stages\": {\"vi\n@@frames\n3\n")!;
    assert.deepEqual(d.stages, {});
    assert.equal(d.frames, 3);
  });

  test("only strips named the way the reconstruction writes them are listed", () => {
    const d = L.parseDetails(`@@peeks\n10 recon/peek-000001.jpg\n11 recon/../../etc/passwd\n12 recon/peek-x.jpg\n13 recon/peek-source-000002.jpg.bak\n`)!;
    assert.deepEqual(d.peeks.map((p) => p.name), ["peek-000001.jpg"]);
  });
});

describe("the GPUs", () => {
  test("a task array counts every task, running or waiting; other people's jobs never appear", () => {
    const gpus = L.gpusOf(L.parseDetails(CANNED)!.squeue);
    assert.deepEqual(gpus.map((g) => [g.stage, g.type, g.running, g.waiting]), [["reconstruct", "B200", 2, 10], ["export", "B200", 0, 1]]);
  });

  test("the type comes from the GRES when it has one, else the partition", () => {
    assert.equal(L.gpuType("gres:gpu:b200:1", "hpg-turin"), "B200");
    assert.equal(L.gpuType("gres:gpu:1", "hpg-b200"), "B200");
    assert.equal(L.gpuType("gres:gpu:l4:1", "x"), "L4");
    assert.equal(L.gpuType("gres:gpu:1", "rtx-pro-6000"), "RTX PRO 6000");
    assert.equal(L.gpuType("gres:gpu:1", "weird"), "weird");
  });
});

describe("buildRun", () => {
  const build = (status = RUNNING as never, d = L.parseDetails(CANNED), kind: "replay" | "avatar" = "replay") =>
    L.buildRun({ id: "jump-shot", name: "Jump shot", kind }, status, d, NOW * 1000 + 2000);

  test("a replay mid-reconstruction: real timings, frames, GPUs, the newest strip of each kind", () => {
    const r = build();
    assert.equal(r.source, "hpg");
    assert.deepEqual(r.stages.map((s) => [s.stage, s.state, s.durationS]), [
      ["upload", "done", null], ["check", "done", null], ["views", "done", 372], ["reconstruct", "running", 1100], ["export", "pending", null],
    ]);
    assert.deepEqual(r.frames, { done: 47, total: 121 });
    assert.equal(r.elapsedS, 1600);
    assert.equal(r.gpus[0].running, 2);
    assert.deepEqual(r.peeks.map((p) => [p.kind, p.name, p.frame]), [["real", "peek-source-000011.jpg", 11], ["imagined", "peek-000011.jpg", 11]]);
    assert.match(r.peeks[0].url, /^\/api\/live\/peek\?run=jump-shot&name=peek-source-000011\.jpg&at=\d+$/);
  });

  test("the export starting is what ends the reconstruction (it is never marked done)", () => {
    const d = L.parseDetails(CANNED)!;
    d.stages.export = { state: "running", startedAt: NOW - 100 };
    const r = build({ ...RUNNING, stage: "export" } as never, d);
    const recon = r.stages.find((s) => s.stage === "reconstruct")!;
    assert.deepEqual([recon.state, recon.durationS], ["done", 1000]);
    assert.equal(r.stages.find((s) => s.stage === "export")!.state, "running");
    assert.equal(r.frames!.done, 121);
  });

  test("a failed run says where, and an avatar has no views stage or frames", () => {
    const failed = build({ id: "jump-shot", status: "failed", stage: "views", progress: 0.1, etaS: null, message: "The views step failed. Ojasva is on it." } as never);
    assert.equal(failed.stages.find((s) => s.stage === "views")!.state, "failed");
    const avatar = build({ ...RUNNING } as never, L.parseDetails(CANNED), "avatar");
    assert.equal(avatar.stages.some((s) => s.stage === "views"), false);
    assert.equal(avatar.frames, null);
  });

  test("an upscale stage shows only when the run has one", () => {
    assert.equal(build().stages.some((s) => s.stage === "upscale"), false);
    const d = L.parseDetails(CANNED)!;
    d.stages.upscale = { state: "done", startedAt: NOW - 1200, endedAt: NOW - 1130 };
    assert.equal(build(RUNNING as never, d).stages.find((s) => s.stage === "upscale")!.durationS, 70);
  });

  test("done means every stage done", () => {
    const r = build({ id: "jump-shot", status: "done", stage: "export", progress: 1, etaS: 0, message: "Ready" } as never);
    assert.ok(r.stages.every((s) => s.state === "done"));
  });

  test("without HiPerGator's details it falls back to the job API's stage and says so", () => {
    const r = build(RUNNING as never, null);
    assert.equal(r.source, "job");
    assert.deepEqual(r.stages.map((s) => s.state), ["done", "done", "done", "running", "pending"]);
    assert.deepEqual([r.frames, r.gpus, r.peeks, r.elapsedS], [null, [], [], null]);
  });
});

describe("reading the run's folder, through the runner's own remote and rsync", { skip: python ? false : "no python3" }, () => {
  const run = join(hpg, "runs", "lesson-1");
  before(() => {
    mkdirSync(process.env.LUCID_DREAMS_DIR!, { recursive: true });
    writeFileSync(join(process.env.LUCID_DREAMS_DIR!, ".runs.json"), '["lesson-1"]'); // lucid_runner.py remembers what it submitted
    mkdirSync(join(run, "recon", "frames"), { recursive: true });
    writeFileSync(join(run, "status.json"), JSON.stringify(STATUS));
    writeFileSync(join(run, "job.json"), JSON.stringify(JOB));
    writeFileSync(join(run, "slurm.json"), '{"views": "8999", "reconstruct": "9001", "export": "9002", "chunks": 12}');
    for (let i = 0; i < 3; i++) writeFileSync(join(run, "recon", "frames", `00000${i}.spz`), "x");
    writeFileSync(join(run, "recon", "peek-source-000000.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    writeFileSync(join(run, "recon", "peek-000000.jpg"), "not a jpeg");
  });

  test("the one SSH call's script gives the folder's contents as data", async () => {
    const d = await L.remoteDetails("lesson-1");
    assert.ok(d, "the stand-in answered");
    assert.equal(d!.frames, 3);
    assert.equal(d!.job?.submittedAt, JOB.submittedAt);
    assert.equal(d!.stages.views.state, "done");
    assert.ok(d!.now && d!.now > 1.7e9);
    assert.deepEqual(d!.peeks.map((p) => p.name).sort(), ["peek-000000.jpg", "peek-source-000000.jpg"]);
  });

  test("a run that isn't there is null", async () => {
    assert.equal(await L.remoteDetails("no-such-run"), null);
  });

  test("a strip is fetched once, as a file of its own, and only if it is a JPEG", async () => {
    const listing = (await L.remoteDetails("lesson-1"))!.peeks;
    const at = listing.find((p) => p.name === "peek-source-000000.jpg")!.at;
    const file = await L.peekFile("lesson-1", "peek-source-000000.jpg", at);
    assert.ok(file && existsSync(file));
    assert.equal(readFileSync(file!)[0], 0xff);
    assert.equal(await L.peekFile("lesson-1", "peek-source-000000.jpg", at), file, "the second ask is the same file");
    const badAt = listing.find((p) => p.name === "peek-000000.jpg")!.at;
    assert.equal(await L.peekFile("lesson-1", "peek-000000.jpg", badAt), null, "something that isn't a JPEG is dropped");
    assert.equal(await L.peekFile("lesson-1", "peek-source-000000.jpg", at + 1), null, "a time the run's listing doesn't have is never asked for");
    assert.equal(await L.peekFile("lesson-1", "peek-source-000099.jpg", at), null, "nor a name it doesn't have");
  });

  test("names that aren't strips, odd times and private or held runs are refused", async () => {
    for (const [id, name, at] of [
      ["lesson-1", "../../etc/passwd", 1_791_999_000],
      ["lesson-1", "peek-1.jpg", 1_791_999_000],
      ["lesson-1", "peek-000000.jpg", 5],
      ["lesson-1", "peek-000000.jpg", Number.NaN],
      ["ian-grandma-1", "peek-000000.jpg", 1_791_999_000],
      ["ian-grandma", "peek-000000.jpg", 1_791_999_000],
      ["../lesson-1", "peek-000000.jpg", 1_791_999_000],
    ] as const) assert.equal(await L.peekFile(id, name, at), null, `${id} ${name} ${at}`);
    assert.equal(await L.peekFile("never-heard-of", "peek-000000.jpg", 1_791_999_000), null, "a run nobody submitted is never asked about");
    writeFileSync(join(process.env.LUCID_DREAMS_DIR!, ".held"), "Lesson-1\n");
    assert.equal(L.allowed("lesson-1"), false);
    assert.equal(L.allowed("LESSON-1-1024-0301"), false, "a dropped clip of a held dream is held too, in any case");
    assert.equal(L.allowed("lesson-10"), true, "only the name, or the name and a dash");
  });
});
