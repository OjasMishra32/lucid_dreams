import "server-only";
import type { JobKind, JobStatus } from "../dream";
import { slug } from "../dream";
import type { Dream } from "../dream";
import { isRunId } from "./dreams";
import { sweepExperiences } from "./experience";
import { mockStatus } from "./mock";
import { repairAvatars, runnerStatus, startRunnerJob } from "./runner";
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

/** Jobs this bridge started that haven't finished, newest first, for the library's "In progress" row. */
export async function activeJobs(): Promise<{ job: JobRecord; status: JobStatus }[]> {
  const recent = allJobs().filter((j) => Date.now() - j.createdAt < 6 * 3600_000);
  const out = await Promise.all(recent.map(async (job) => ({ job, status: await jobStatus(job.id) })));
  return out.filter((x): x is { job: JobRecord; status: JobStatus } => !!x.status && x.status.status !== "done");
}

/** Whenever the library is listed: plan dreams that have no plan yet, and (runner mode) finish avatars missing .ply. */
export function tend(dreams: Dream[]) {
  sweepExperiences(dreams);
  if (MODE === "runner") repairAvatars(dreams);
}

export function isKind(v: unknown): v is JobKind {
  return v === "replay" || v === "avatar";
}
