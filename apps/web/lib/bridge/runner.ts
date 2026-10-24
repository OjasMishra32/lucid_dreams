import "server-only";
import { execFile, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import type { Dream, JobStatus } from "../dream";
import { REPO, avatarComplete, bundleComplete as complete, isRunId, readDream } from "./dreams";
import { fetches, fetching } from "./fetches";
import { ensureExperience } from "./experience";
import { getJob, updateJob, type JobRecord } from "./store";

// Real jobs: every call goes through Ojasva's pipeline/runner/lucid_runner.py, which prints one JSON object.
const RUNNER = join(REPO, "pipeline", "runner", "lucid_runner.py");
const STATUS_TTL_MS = 4000;
const FETCH_TRIES = 3;
const FETCH_BACKOFF_MS = 60_000; // a Wi-Fi drop shouldn't burn every retry in seconds
const run = promisify(execFile);

type Live = { status: Map<string, { at: number; value: Promise<JobStatus> }>; submitting: Set<string> };
const g = globalThis as unknown as { __lucidRunner?: Live };
const state: Live = (g.__lucidRunner ??= { status: new Map(), submitting: new Set() });

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
  updateJob(job.id, { submit: "running" });
  state.submitting.add(job.id);
  submitInput(job)
    .then((file) => {
      // --name=<value> in one token, so a name starting with "-" can't read as an option
      const args = ["submit", file, `--name=${job.name}`, `--id=${job.id}`, `--kind=${job.kind}`];
      if (job.kind === "replay" && job.startS > 0) args.push(`--start-s=${job.startS.toFixed(2)}`);
      if (job.intent) args.push(`--intent=${job.intent}`);
      return runner(args);
    })
    .then(() => updateJob(job.id, { submit: "done" }))
    .catch((e: Error) => updateJob(job.id, { submit: "failed", error: e.message }))
    .finally(() => state.submitting.delete(job.id));
}

/** iPhone photos arrive as HEIC, which the avatar stage can't open: hand it a JPEG made on the Mac instead. */
async function submitInput(job: JobRecord): Promise<string> {
  if (!/\.heic$/i.test(job.file)) return job.file;
  const jpg = job.file.replace(/\.heic$/i, ".jpg");
  if (!existsSync(jpg)) await run("sips", ["-s", "format", "jpeg", job.file, "--out", jpg], { timeout: 60_000 });
  return jpg;
}

export async function runnerStatus(id: string): Promise<JobStatus | null> {
  if (!isRunId(id)) return null; // ids go into an SSH command inside lucid_runner.py
  const job = getJob(id);
  const base = { id, etaS: null } as const;

  if (job && !job.submit) {
    // recorded before this bridge sent avatars on (they were held back then): it never reached HiPerGator
    return { ...base, status: "failed", stage: "upload", progress: 0, message: "This one was never sent to the GPUs. Make it again." };
  }
  if (job?.submit === "running") {
    if (state.submitting.has(id)) {
      return { ...base, status: "running", stage: "upload", progress: 0.02, message: "Sending your clip to HiPerGator" };
    }
    // the bridge restarted mid-send: ask HiPerGator whether the run made it there
    try {
      await cachedStatus(id);
      updateJob(id, { submit: "done" });
    } catch {
      updateJob(id, { submit: "failed", error: "interrupted" });
      return { ...base, status: "failed", stage: "upload", progress: 0.02, message: "The upload was cut off. Make it again." };
    }
  }
  if (job?.submit === "failed") {
    return { ...base, status: "failed", stage: "upload", progress: 0.02,
      message: "Couldn't reach HiPerGator. Check Ojasva's connection and try again." };
  }
  // dream.json lands first in a fetch: only call it done once the whole bundle is here
  if (fetching(id)) return bringingHome(id);
  const dream = readDream(id);
  if (dream && complete(dream)) {
    fetches.delete(id); // complete on disk, however it got here (a manual fetch after a failed one counts)
    return { ...base, status: "done", stage: "export", progress: 1, etaS: 0, message: "Ready" };
  }
  const f = fetches.get(id);
  if (f?.state === "failed") {
    if (f.tries < FETCH_TRIES) {
      if (Date.now() - (f.at ?? 0) >= FETCH_BACKOFF_MS) startFetch(id);
      return bringingHome(id);
    }
    return { ...base, status: "failed", stage: "export", progress: 0.99,
      message: "The dream is made but couldn't be copied back. Ojasva can run lucid_runner.py fetch." };
  }
  if (dream) {
    startFetch(id); // half here (an avatar without its .ply, or a fetch that broke off): finish copying it
    return bringingHome(id);
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

/** What HiPerGator says about a run, and nothing else (no fetch): for listing runs this bridge didn't start. */
export function remoteStatus(id: string): Promise<JobStatus | null> {
  if (!isRunId(id)) return Promise.resolve(null);
  return cachedStatus(id).catch(() => null);
}

function cachedStatus(id: string): Promise<JobStatus> {
  const hit = state.status.get(id);
  if (hit && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
  const value = runner(["status", id]) as Promise<JobStatus>;
  state.status.set(id, { at: Date.now(), value });
  value.catch(() => state.status.delete(id));
  return value;
}

/**
 * Copy the bundle back. The runner leaves .ply files out unless asked (a replay's PLY frames are huge; players stream
 * the SPZ copies), but an avatar's only Gaussian file is avatar/avatar.ply, so avatars come with their PLYs.
 */
function startFetch(id: string) {
  const prev = fetches.get(id);
  if (prev?.state === "running") return;
  const tries = (prev?.tries ?? 0) + 1;
  fetches.set(id, { state: "running", tries });
  if (getJob(id)) updateJob(id, { fetch: "running" });
  const avatar = getJob(id)?.kind === "avatar" || readDream(id)?.kind === "avatar";
  runner(["fetch", id, ...(avatar ? ["--with-ply"] : [])])
    .then((dream) => {
      // a run this bridge didn't start (the autopilot's) only shows it's an avatar once its dream.json is here
      if (!avatar && (dream as { kind?: string } | null)?.kind === "avatar") return runner(["fetch", id, "--with-ply"]);
    })
    .then(() => {
      const d = readDream(id);
      if (d && !complete(d)) {
        // a whole fetch came back and the bundle is still short: it's missing on HiPerGator too; stop asking
        fetches.set(id, { state: "failed", tries: FETCH_TRIES, at: Date.now(), error: "the bundle on HiPerGator is incomplete" });
        if (getJob(id)) updateJob(id, { fetch: "failed", error: "the bundle on HiPerGator is incomplete" });
        return;
      }
      fetches.delete(id);
      if (getJob(id)) updateJob(id, { fetch: "done" });
      ensureExperience(id);
    })
    .catch((e: Error) => {
      fetches.set(id, { state: "failed", tries, at: Date.now(), error: e.message });
      if (getJob(id)) updateJob(id, { fetch: "failed", error: e.message });
    });
}

/**
 * Bring back avatar.ply for avatars that arrived without it. The autopilot fetches every run without PLYs, which for
 * an avatar is the only Gaussian file; the library listing calls this so the headset never gets an empty avatar.
 */
export function repairAvatars(dreams: Dream[]) {
  for (const d of dreams) if (!avatarComplete(d) && !fetching(d.id) && (fetches.get(d.id)?.tries ?? 0) < FETCH_TRIES) startFetch(d.id);
}

function bringingHome(id: string): JobStatus {
  return { id, status: "running", stage: "export", progress: 0.99, etaS: 30, message: "Bringing them home" };
}
