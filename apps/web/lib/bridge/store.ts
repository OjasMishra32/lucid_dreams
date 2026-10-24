import "server-only";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { JobKind, JobStatus } from "../dream";
import { DATA_DIR } from "./dreams";

/** What the bridge remembers about a job it was given. Survives restarts via .data/jobs.json. */
export interface JobRecord {
  id: string;
  name: string;
  kind: JobKind;
  mode: "mock" | "runner";
  file: string; // the uploaded clip or photo on this Mac
  fileName: string;
  startS: number; // where the 5-second window starts in a long clip
  createdAt: number;
  // runner mode
  submit?: "running" | "done" | "failed";
  fetch?: "running" | "done" | "failed";
  error?: string;
  last?: JobStatus; // last status we saw, for when HiPerGator is briefly unreachable
}

const FILE = join(DATA_DIR, "jobs.json");

// One map per server process, kept on globalThis so dev reloads don't forget jobs.
const g = globalThis as unknown as { __lucidJobs?: Map<string, JobRecord> };

function jobs(): Map<string, JobRecord> {
  if (!g.__lucidJobs) {
    g.__lucidJobs = new Map();
    if (existsSync(FILE)) {
      try {
        for (const j of JSON.parse(readFileSync(FILE, "utf8")) as JobRecord[]) g.__lucidJobs.set(j.id, j);
      } catch {
        // a torn write: start fresh rather than refuse to boot
      }
    }
  }
  return g.__lucidJobs;
}

function save() {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(FILE + ".tmp", JSON.stringify([...jobs().values()], null, 2));
  renameSync(FILE + ".tmp", FILE);
}

export function getJob(id: string): JobRecord | undefined {
  return jobs().get(id);
}

export function putJob(job: JobRecord): JobRecord {
  jobs().set(job.id, job);
  save();
  return job;
}

export function updateJob(id: string, patch: Partial<JobRecord>): JobRecord | undefined {
  const j = jobs().get(id);
  if (!j) return undefined;
  Object.assign(j, patch);
  save();
  return j;
}

export function allJobs(): JobRecord[] {
  return [...jobs().values()].sort((a, b) => b.createdAt - a.createdAt);
}
