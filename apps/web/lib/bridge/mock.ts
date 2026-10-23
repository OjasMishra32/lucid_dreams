import "server-only";
import { existsSync, mkdirSync, readdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobStatus, Stage } from "../dream";
import { DREAMS_DIR, listDreams, readDream } from "./dreams";
import { allJobs, type JobRecord } from "./store";

// Same weights and words as pipeline/lucid/status.py, so the mock feels exactly like a real run, only faster.
const WEIGHTS: Record<Stage, number> = { upload: 0.03, check: 0.02, views: 0.35, upscale: 0, reconstruct: 0.5, export: 0.1 };
const TIMELINE: { stage: Stage | "queued"; share: number; message: string }[] = [
  { stage: "queued", share: 0.06, message: "Waiting for a GPU" },
  { stage: "check", share: 0.04, message: "Checking the clip" },
  { stage: "views", share: 0.35, message: "Imagining every angle of them" },
  { stage: "reconstruct", share: 0.45, message: "Building them in 3D, frame by frame" },
  { stage: "export", share: 0.1, message: "Getting them ready for your room" },
];

const TOTAL_S = Number(process.env.MOCK_SECONDS ?? 60);

export function mockStatus(job: JobRecord): JobStatus {
  const elapsed = (Date.now() - job.createdAt) / 1000;
  let t = elapsed / TOTAL_S;
  if (t >= 1) return finish(job);

  let progress = WEIGHTS.upload;
  for (const step of TIMELINE) {
    if (t < step.share) {
      const frac = t / step.share;
      if (step.stage === "queued") {
        return { id: job.id, status: "queued", stage: "views", progress: round(progress), etaS: eta(elapsed), message: step.message };
      }
      progress += WEIGHTS[step.stage] * frac;
      return { id: job.id, status: "running", stage: step.stage, progress: round(progress), etaS: eta(elapsed), message: step.message };
    }
    t -= step.share;
    if (step.stage !== "queued") progress += WEIGHTS[step.stage];
  }
  return finish(job);
}

function finish(job: JobRecord): JobStatus {
  const made = readDream(job.id) ?? standIn(job);
  if (!made) {
    return {
      id: job.id, status: "failed", stage: "export", progress: 0.9, etaS: null,
      message: "No sample bundle to stand in with. Copy dreams/synthetic-test from Ojasva's Mac into dreams/.",
    };
  }
  return { id: job.id, status: "done", stage: "export", progress: 1, etaS: 0, message: "Ready" };
}

/** A finished mock job becomes a real-looking bundle: the sample's files, linked, under the job's id and name. */
function standIn(job: JobRecord) {
  const mockIds = new Set(allJobs().filter((j) => j.mode === "mock").map((j) => j.id));
  const wanted = process.env.LUCID_SAMPLE_DREAM ?? "synthetic-test";
  const sample = readDream(wanted) ?? listDreams().find((d) => !mockIds.has(d.id)) ?? null;
  if (!sample) return null;

  const src = realpathSync(join(DREAMS_DIR, sample.id));
  const dst = join(DREAMS_DIR, job.id);
  mkdirSync(dst, { recursive: true });
  for (const entry of readdirSync(src)) {
    if (entry === "dream.json" || existsSync(join(dst, entry))) continue;
    symlinkSync(join(src, entry), join(dst, entry));
  }
  const dream = { ...sample, id: job.id, name: job.name, createdAt: new Date().toISOString() };
  writeFileSync(join(dst, "dream.json"), JSON.stringify(dream, null, 2));
  return dream;
}

function eta(elapsed: number) {
  return Math.max(0, Math.round(TOTAL_S - elapsed));
}

function round(x: number) {
  return Math.round(Math.min(x, 0.999) * 1000) / 1000;
}
