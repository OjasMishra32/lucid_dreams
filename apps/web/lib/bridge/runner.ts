import "server-only";
import { spawn } from "node:child_process";
import { join } from "node:path";
import type { JobStatus } from "../dream";
import { REPO, readDream } from "./dreams";
import { getJob, updateJob, type JobRecord } from "./store";

// Real jobs: every call goes through Ojasva's pipeline/runner/lucid_runner.py, which prints one JSON object.
const RUNNER = join(REPO, "pipeline", "runner", "lucid_runner.py");
const STATUS_TTL_MS = 4000;
const FETCH_TRIES = 3;

const g = globalThis as unknown as {
  __lucidRunner?: {
    status: Map<string, { at: number; value: Promise<JobStatus> }>;
    fetching: Map<string, { state: "running" | "failed"; tries: number; error?: string }>;
  };
};
const state = (g.__lucidRunner ??= { status: new Map(), fetching: new Map() });

function runner(args: string[]): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const p = spawn(/*turbopackIgnore: true*/ process.env.PYTHON ?? "python3", [RUNNER, ...args], { cwd: REPO });
    let out = "";
    let err = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", reject);
    p.on("close", (code) => {
      const line = out.trim().split("\n").pop() ?? "";
      if (code === 0 && line) {
        try {
          return resolve(JSON.parse(line));
        } catch {
          // fall through
        }
      }
      reject(new Error((err || out).trim().slice(-400) || `runner exited ${code}`));
    });
  });
}

/** Called once the upload is on disk. Sending the clip to HiPerGator can take a while, so it runs in the background. */
export function startRunnerJob(job: JobRecord) {
  if (job.kind === "avatar") return; // not wired to the pipeline yet; status says so
  updateJob(job.id, { submit: "running" });
  runner(["submit", job.file, "--name", job.name, "--id", job.id])
    .then(() => updateJob(job.id, { submit: "done" }))
    .catch((e: Error) => updateJob(job.id, { submit: "failed", error: e.message }));
}

export async function runnerStatus(id: string): Promise<JobStatus | null> {
  const job = getJob(id);
  const base = { id, etaS: null } as const;

  if (job?.kind === "avatar") {
    return { ...base, status: "failed", stage: "check", progress: 0.05,
      message: "Avatars aren't connected to the pipeline yet. Make a replay for now." };
  }
  if (job?.submit === "running") {
    return { ...base, status: "running", stage: "upload", progress: 0.02, message: "Sending your clip to HiPerGator" };
  }
  if (job?.submit === "failed") {
    return { ...base, status: "failed", stage: "upload", progress: 0.02,
      message: "Couldn't reach HiPerGator. Check Ojasva's connection and try again." };
  }
  if (readDream(id)) {
    return { ...base, status: "done", stage: "export", progress: 1, etaS: 0, message: "Ready" };
  }

  const f = state.fetching.get(id);
  if (f?.state === "running") return bringingHome(id);
  if (f?.state === "failed" && f.tries >= FETCH_TRIES) {
    return { ...base, status: "failed", stage: "export", progress: 0.99,
      message: "The dream is made but couldn't be copied back. Ojasva can run lucid_runner.py fetch." };
  }

  let remote: JobStatus;
  try {
    remote = await cachedStatus(id);
  } catch {
    // HiPerGator unreachable for a moment: hold the last known state instead of flipping to failed.
    if (job?.last) return { ...job.last, message: "Reconnecting to HiPerGator" };
    if (!job) return null;
    return { ...base, status: "queued", stage: "views", progress: 0.05, message: "Reconnecting to HiPerGator" };
  }

  if (remote.status === "done") {
    startFetch(id);
    return bringingHome(id);
  }
  if (job) updateJob(id, { last: remote });
  return remote;
}

function cachedStatus(id: string): Promise<JobStatus> {
  const hit = state.status.get(id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const value = runner(["status", id]) as Promise<JobStatus>;
  state.status.set(id, { at: Date.now(), value });
  value.catch(() => state.status.delete(id));
  return value;
}

function startFetch(id: string) {
  const prev = state.fetching.get(id);
  if (prev?.state === "running") return;
  const tries = (prev?.tries ?? 0) + 1;
  state.fetching.set(id, { state: "running", tries });
  if (getJob(id)) updateJob(id, { fetch: "running" });
  runner(["fetch", id])
    .then(() => {
      state.fetching.delete(id);
      if (getJob(id)) updateJob(id, { fetch: "done" });
    })
    .catch((e: Error) => {
      state.fetching.set(id, { state: "failed", tries, error: e.message });
      if (getJob(id)) updateJob(id, { fetch: "failed", error: e.message });
    });
}

function bringingHome(id: string): JobStatus {
  return { id, status: "running", stage: "export", progress: 0.99, etaS: 30, message: "Bringing them home" };
}
