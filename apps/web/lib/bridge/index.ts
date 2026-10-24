import "server-only";
import type { JobKind, JobStatus } from "../dream";
import { slug } from "../dream";
import type { Dream } from "../dream";
import { bundleComplete, isRunId, readDream } from "./dreams";
import { sweepExperiences } from "./experience";
import { mockStatus } from "./mock";
import { remoteStatus, repairAvatars, runnerStatus, startRunnerJob } from "./runner";
import { runName, runSubmittedAt, submittedRuns } from "./runs";
import { allJobs, getJob, putJob, type JobRecord } from "./store";

export const MODE: "mock" | "runner" = process.env.BRIDGE_MODE === "runner" ? "runner" : "mock";

/** Same id scheme as lucid_runner.py: name slug plus a timestamp, so ids read well in logs and folders. */
export function newJobId(name: string): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  const stamp = `${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
  let id = `${slug(name)}-${stamp}`;
  for (let i = 2; getJob(id); i++) id = `${slug(name)}-${stamp}-${i}`;
  return id;
}

export function createJob(job: Omit<JobRecord, "mode" | "createdAt">): JobRecord {
  const record = putJob({ ...job, mode: MODE, createdAt: Date.now() });
  if (MODE === "runner") startRunnerJob(record);
  return record;
}

export async function jobStatus(id: string): Promise<JobStatus | null> {
  if (!isRunId(id)) return null; // every way into the runner comes through here
  const job = getJob(id);
  if (job?.mode === "mock") return mockStatus(job);
  if (MODE === "runner") return runnerStatus(id); // also answers for runs the autopilot started
  return null;
}

const RECENT_MS = 6 * 3600_000;

export type ActiveJob = { id: string; name: string; status: JobStatus };

/**
 * Runs that haven't finished, for the library's "In progress" row: the ones this bridge started, newest first, then
 * (runner mode) the ones started by hand or by the autopilot.
 */
export async function activeJobs(): Promise<ActiveJob[]> {
  const recent = allJobs().filter((j) => Date.now() - j.createdAt < RECENT_MS);
  const mine = await Promise.all(recent.map(async (job) => ({ id: job.id, name: job.name, status: await jobStatus(job.id) })));
  const others = MODE === "runner" ? await otherRuns() : [];
  return [...mine, ...others].filter((x): x is ActiveJob => !!x.status && x.status.status !== "done");
}

// Runs found finished or long failed: not asked about again for a couple of minutes (a resubmitted one comes back).
const g = globalThis as unknown as { __lucidSettled?: Map<string, number> };
const settled = (g.__lucidSettled ??= new Map());

/**
 * Every run lucid_runner.py submitted that this bridge didn't (dreams/.runs.json), with live status. Only HiPerGator
 * is asked, never a fetch: a run done there is the autopilot's to bring home, and one already here is in the library
 * (or, half copied, finishing like any other).
 */
async function otherRuns(): Promise<ActiveJob[]> {
  const ids = submittedRuns().filter((id) => !getJob(id) && Date.now() - (settled.get(id) ?? 0) > 120_000).reverse();
  const out = await Promise.all(
    ids.map(async (id): Promise<ActiveJob | null> => {
      const d = readDream(id);
      if (d && bundleComplete(d)) return null;
      const status = d ? await runnerStatus(id) : await remoteStatus(id);
      if (!status) return null;
      const old = Date.now() - (runSubmittedAt(id) ?? 0) > RECENT_MS;
      if (status.status === "done" || (status.status === "failed" && old)) {
        settled.set(id, Date.now());
        return null;
      }
      return { id, name: runName(id), status };
    }),
  );
  return out.filter((x): x is ActiveJob => x !== null);
}

/** Whenever the library is listed: plan dreams that have no plan yet, and (runner mode) finish avatars missing .ply. */
export function tend(dreams: Dream[]) {
  sweepExperiences(dreams);
  if (MODE === "runner") repairAvatars(dreams);
}

export function isKind(v: unknown): v is JobKind {
  return v === "replay" || v === "avatar";
}
