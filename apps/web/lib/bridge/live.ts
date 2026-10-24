import "server-only";
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { dreamFile, type JobKind, type JobState, type JobStatus, type Stage } from "../dream";
import type { LiveGpus, LivePeek, LiveReply, LiveRun, LiveStage, LiveStageState } from "../live";
import { DATA_DIR, DREAMS_DIR, REPO, heldIds, isRunId, listReady, readDream } from "./dreams";
import { fetching } from "./fetches";
import { MODE, activeJobs, jobStatus } from "./index";
import { mockStatus, mockTimeline } from "./mock";
import { runName, runSubmittedAt, submittedRuns } from "./runs";
import { allJobs, getJob, type JobRecord } from "./store";

// The live pipeline page (/live): one run's stages with real timings, the GPUs on it and its latest fitted frame.
// A demo (mock) run is its own real timeline on this Mac. A real run is read from HiPerGator through lucid_runner's own
// SSH connection (remote() and rsync(), as hpg.ts does): files and squeue only, never anything that changes the cluster.

const run = promisify(execFile);
const PYTHON = process.env.PYTHON ?? "python3";
const RUNNER_DIR = join(REPO, "pipeline", "runner");
const LIVE_DIR = join(DATA_DIR, "live"); // the latest fitted frame of each run, copied from HiPerGator
const ACCOUNT = "iruchkin"; // the lab's Slurm account (#SBATCH --account in pipeline/hpg/*.sbatch)
const READ_TTL_MS = 5000; // every viewer of the page shares one read of HiPerGator per run this often
const PICK_TTL_MS = 8000;
const PEEK_RETRY_MS = 30_000;
const PEEK_MAX_PX = 3600; // the strip is ten views wide; the page never needs more than this
const PEEK_NAME = /^peek-(\d{6})\.jpg$/;
const ID_PATTERN = "[A-Za-z0-9][A-Za-z0-9_.-]{0,99}"; // isRunId, checked again on the Python side

/**
 * Runs on HiPerGator's login node (python3, stdlib only): everything the page needs about one run in one JSON line.
 * Reads job.json, slurm.json and status.json, asks lucid.status for the runner's own words, lists the fitted frames
 * recon.py wrote (stage-recon.sbatch: --out $RUN/recon, so $RUN/recon/peek-<frame>.jpg) and lists the lab's jobs.
 */
const REMOTE_SCRIPT = `
import glob, json, os, subprocess, sys, time
run, code, account = sys.argv[1:4]
out = {"now": time.time(), "exists": os.path.isdir(run), "dir": run}
def load(name):
    try:
        with open(os.path.join(run, name)) as f:
            return json.load(f)
    except Exception:
        return None
def cmd(args, **kw):
    try:
        p = subprocess.run(args, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, universal_newlines=True, timeout=20, **kw)
        return p.stdout if p.returncode == 0 else None
    except Exception:
        return None
if out["exists"]:
    out["real"] = os.path.realpath(run)
    out["job"] = load("job.json")
    out["slurm"] = load("slurm.json")
    out["status"] = load("status.json")
    shown = cmd([sys.executable, "-m", "lucid.status", "show", "."], cwd=run, env=dict(os.environ, PYTHONPATH=code))
    try:
        out["show"] = json.loads(shown) if shown else None
    except ValueError:
        out["show"] = None
    out["bundle"] = os.path.isfile(os.path.join(run, "bundle", "dream.json"))
    frames = os.path.join(run, "recon", "frames")
    out["frames"] = len([f for f in os.listdir(frames) if f.endswith(".spz")]) if os.path.isdir(frames) else None
    out["reports"] = []
    for p in glob.glob(os.path.join(run, "recon", "recon-*.json")):
        try:
            with open(p) as f:
                took = json.load(f).get("seconds")
        except Exception:
            took = None
        out["reports"].append({"end": os.path.getmtime(p), "seconds": took})
    out["peeks"] = [{"name": os.path.basename(p), "mtime": os.path.getmtime(p), "size": os.path.getsize(p)}
                    for p in glob.glob(os.path.join(run, "recon", "peek-*.jpg"))]
fields = "JobID:24|,ArrayJobID:24|,ArrayTaskID:16|,UserName:32|,Name:64|,State:24|,Partition:96|,WorkDir:400|,tres-alloc:400|"
q = cmd(["squeue", "-h", "-r", "-A", account, "-O", fields])
if q is None:
    q = cmd(["squeue", "-h", "-r", "-A", account, "-o", "%A|%F|%K|%u|%j|%T|%P|%Z|"])
out["squeue"] = q
print(json.dumps(out))
`.trim();

/** Mac side: lucid_runner's remote() runs the script above on HiPerGator, with the run id (validated twice) as its path. */
const READ_CODE = [
  "import re, sys",
  `sys.path.insert(0, ${JSON.stringify(RUNNER_DIR)})`,
  "import lucid_runner as r",
  "rid = sys.argv[1]",
  `if not re.fullmatch(${JSON.stringify(ID_PATTERN)}, rid): raise SystemExit("not a run id")`,
  `script = ${JSON.stringify(REMOTE_SCRIPT)}`,
  `cmd = "python3 - '%s/runs/%s' '%s/code/pipeline' '%s' <<'PY'\\n%s\\nPY" % (r.REMOTE, rid, r.REMOTE, ${JSON.stringify(ACCOUNT)}, script)`,
  "sys.stdout.write(r.remote(cmd))",
].join("\n");

/** Mac side: one fitted frame copied home with lucid_runner's rsync. */
const PEEK_CODE = [
  "import re, sys",
  `sys.path.insert(0, ${JSON.stringify(RUNNER_DIR)})`,
  "import lucid_runner as r",
  "rid, name, dest = sys.argv[1:4]",
  `if not re.fullmatch(${JSON.stringify(ID_PATTERN)}, rid) or not re.fullmatch(r"peek-[0-9]{6}[.]jpg", name): raise SystemExit("bad name")`,
  `r.rsync(f"{r.HOST}:{r.REMOTE}/runs/{rid}/recon/{name}", dest)`,
].join("\n");

type StageEntry = { state?: string; startedAt?: number; endedAt?: number };
type RemotePeek = { name: string; mtime: number; size: number };

/** What HiPerGator said about a run (REMOTE_SCRIPT's JSON). Times are seconds on its clock. */
interface RemoteRead {
  now: number;
  exists: boolean;
  dir: string;
  real?: string;
  job?: {
    id?: string; name?: string; kind?: string; submittedAt?: number; frames?: number; chunks?: number;
    viewsPerLayer?: number; layerPitches?: number[];
  } | null;
  slurm?: Record<string, unknown> | null;
  status?: { stages?: Record<string, StageEntry> } | null;
  show?: JobStatus | null;
  bundle?: boolean;
  frames?: number | null;
  reports?: { end: number; seconds?: number | null }[]; // one per finished chunk: when it ended and how long it took
  peeks?: RemotePeek[];
  squeue?: string | null;
}

/** at: when it answered (bridge clock). skew: bridge clock minus HiPerGator's, so its times read on ours. */
type Heard = { data: RemoteRead; at: number; skew: number };
type PeekMeta = RemotePeek & { width: number; height: number };

type Live = {
  reads: Map<string, { at: number; value: Promise<Heard>; pending?: boolean }>;
  last: Map<string, Heard>;
  bringing: Set<string>;
  peekFailedAt: Map<string, number>;
  pick: { at: number; value: Promise<string | null> } | null;
};
const g = globalThis as unknown as { __lucidLive?: Live };
const cache: Live = (g.__lucidLive ??= { reads: new Map(), last: new Map(), bringing: new Set(), peekFailedAt: new Map(), pick: null });

async function python(code: string, args: string[], timeout: number): Promise<string> {
  const { stdout } = await run(PYTHON, ["-c", code, ...args], { cwd: REPO, timeout, maxBuffer: 8 * 1024 * 1024 });
  return stdout;
}

function readRemote(id: string): Promise<Heard> {
  const hit = cache.reads.get(id);
  // one read per run at a time: while HiPerGator is slow to answer, every poll waits on the read already under way
  // instead of opening another SSH session; the TTL runs from when it answered
  if (hit && (hit.pending || Date.now() - hit.at < READ_TTL_MS)) return hit.value;
  const value = python(READ_CODE, [id], 20_000).then((out) => {
    const data = JSON.parse(out.trim().split("\n").pop() ?? "") as RemoteRead;
    const heard: Heard = { data, at: Date.now(), skew: Date.now() - data.now * 1000 };
    cache.last.set(id, heard);
    return heard;
  });
  const entry = { at: Date.now(), value, pending: true };
  const settle = () => {
    entry.at = Date.now();
    entry.pending = false;
  };
  value.then(settle, settle); // a failed read is kept for the TTL too, so a dropped connection isn't asked every poll
  cache.reads.set(id, entry);
  return value;
}

// ---------------------------------------------------------------------------------------------------------------
// Which run the page shows

const BUILDING: JobState[] = ["running", "queued"];

function hidden(id: string): boolean {
  if (heldIds().has(id)) return true; // held back until it's good enough to show (dreams/.held)
  return (readDream(id) as { private?: boolean } | null)?.private === true; // a family's dream stays theirs
}

/** Newest first: this bridge's jobs by when they arrived, others by the stamp in their id, then by .runs.json order. */
function newestFirst(ids: string[]): string[] {
  const order = new Map(submittedRuns().map((id, i) => [id, i]));
  const when = (id: string) => getJob(id)?.createdAt ?? runSubmittedAt(id) ?? 0;
  return [...ids].sort((a, b) => when(b) - when(a) || (order.get(b) ?? -1) - (order.get(a) ?? -1));
}

/** The newest run still building (queued or running), or null. */
function newestBuilding(): Promise<string | null> {
  if (cache.pick && Date.now() - cache.pick.at < PICK_TTL_MS) return cache.pick.value;
  const value = activeJobs()
    .then((jobs) => {
      const ids = jobs.filter((j) => BUILDING.includes(j.status.status) && !hidden(j.id)).map((j) => j.id);
      return newestFirst(ids)[0] ?? null;
    })
    .catch(() => null);
  cache.pick = { at: Date.now(), value };
  return value;
}

/** The newest run of any state: this bridge's jobs, and (runner mode) every run lucid_runner submitted. */
function newestRun(): string | null {
  const mine = allJobs()
    .filter((j) => MODE === "runner" || j.mode === "mock")
    .map((j) => j.id);
  const others = MODE === "runner" ? submittedRuns() : [];
  return newestFirst([...new Set([...mine, ...others])].filter((id) => !hidden(id)))[0] ?? null;
}

/**
 * GET /api/live: the run named by `want`; with `follow` (the page was opened without ?id=), a run that has finished
 * gives way to the newest one still building, and with no run named, the newest building run, else the newest run.
 */
export async function liveReply(want: string | null, follow: boolean): Promise<LiveReply> {
  const reply = (r: LiveRun | null, reason?: LiveReply["reason"]): LiveReply => ({
    now: Date.now(),
    refreshS: !r ? 5 : !BUILDING.includes(r.state) ? 10 : r.demo ? 2 : 5,
    run: r,
    ...(reason ? { reason } : {}),
  });
  if (want) {
    if (!isRunId(want)) return reply(null, "unknown");
    const shown = await liveRun(want);
    if (shown && follow && !BUILDING.includes(shown.state)) {
      const next = await newestBuilding();
      const other = next && next !== want ? await liveRun(next) : null;
      if (other) return reply(other);
    }
    if (shown) return reply(shown);
    // offline: a run this Mac knows from HiPerGator while the bridge is in demo mode; anything else is unknown
    if (!follow) return reply(null, MODE === "mock" && known(want) && !hidden(want) ? "offline" : "unknown");
  }
  const id = (await newestBuilding()) ?? newestRun();
  const shown = id ? await liveRun(id) : null;
  return reply(shown, shown ? undefined : "none");
}

export async function liveRun(id: string): Promise<LiveRun | null> {
  if (!isRunId(id) || hidden(id)) return null;
  const job = getJob(id);
  if (job?.mode === "mock") return mockRun(job);
  if (MODE !== "runner") return null; // only the demo Mac reaches HiPerGator
  return runnerRun(id, job);
}

/** A run this Mac knows: one of the bridge's jobs, one lucid_runner submitted (.runs.json), or a fetched bundle. */
function known(id: string): boolean {
  return !!getJob(id) || submittedRuns().includes(id) || !!readDream(id);
}

function inLibrary(id: string): boolean {
  const d = readDream(id);
  return !!d && listReady([d]).length > 0;
}

// ---------------------------------------------------------------------------------------------------------------
// A demo run: the mock's own schedule, as it really unfolds on this Mac

function mockRun(job: JobRecord): LiveRun {
  const status = mockStatus(job); // also turns a finished job into its stand-in bundle, as the job page does
  const now = Date.now();
  const steps = new Map(mockTimeline(job).map((t) => [t.stage, t]));
  const avatar = job.kind === "avatar";
  const order: Stage[] = avatar ? ["check", "reconstruct", "export"] : ["check", "views", "reconstruct", "export"];
  const done = status.status === "done";

  const stages: LiveStage[] = [{ stage: "upload", state: "done", startedAt: null, endedAt: null }];
  for (const stage of order) {
    const step = steps.get(stage)!;
    // an avatar has no other angles to imagine: the mock builds it across both steps, as mockStatus reports it
    const startedAt = avatar && stage === "reconstruct" ? steps.get("views")!.startedAt : step.startedAt;
    const endedAt = step.endedAt;
    const state: LiveStageState = done || now >= endedAt ? "done" : now >= startedAt ? "running" : "waiting";
    stages.push({ stage, state, startedAt: state === "waiting" ? null : startedAt, endedAt: state === "done" ? endedAt : null });
  }
  const check = stages[1];
  if (check.state === "waiting") {
    check.state = "queued"; // the mock's wait for a GPU comes before its check
    check.startedAt = steps.get("queued")!.startedAt;
  }
  // the mock only fails at the end of its schedule (no sample bundle to stand in): it stopped then, not at every poll
  const scheduleEnd = steps.get("export")!.endedAt;
  if (status.status === "failed") {
    const last = stages[stages.length - 1];
    last.state = "failed";
    last.endedAt = scheduleEnd;
  }

  // the sample bundle stands in for the result: its thumb, never a made-up fitted frame
  const made = readDream(job.id);
  const sample = made ?? readDream(process.env.LUCID_SAMPLE_DREAM ?? "synthetic-test");
  const thumb = sample?.thumb && existsSync(join(DREAMS_DIR, sample.id, sample.thumb)) ? dreamFile(sample.id, sample.thumb) : null;

  return {
    id: job.id,
    name: job.name,
    kind: job.kind,
    demo: true,
    state: status.status,
    message: done ? "Ready" : status.message,
    startedAt: job.createdAt,
    endedAt: done || status.status === "failed" ? scheduleEnd : null,
    stages,
    gpus: null,
    idle: false,
    peek: null,
    thumb,
    ready: done && inLibrary(job.id),
    heardAt: now,
    stale: false,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// A real run, read from HiPerGator

async function runnerRun(id: string, job: JobRecord | undefined): Promise<LiveRun | null> {
  // only runs this Mac knows are read from HiPerGator: any other id typed into the address would open an SSH session
  // through Ojasva's shared connection on every request
  if (!known(id)) return null;
  // the bridge's own status of its job is a second SSH call: asked alongside the read, not after it
  const asking: Promise<JobStatus | null> = job ? jobStatus(id).catch(() => null) : Promise.resolve(null);
  const heard = await readRemote(id).catch(() => null);
  const last = heard ?? cache.last.get(id) ?? null;
  const data = last?.data ?? null;
  const local = readDream(id);
  // HiPerGator has no such run and neither has this Mac (a listed run since cleared away there is gone too)
  if (data && !data.exists && !job && !local) return null;

  const kind: JobKind = job?.kind ?? (data?.job?.kind === "avatar" ? "avatar" : local?.kind ?? "replay");
  const ready = inLibrary(id);
  let status: JobStatus | null = await asking;
  // made on HiPerGator: the bridge may still be bringing it home ("running" to the job API), but the GPUs are done
  const made = ready || !!data?.bundle || fetching(id);
  if (made && status?.status !== "failed") status = { id, status: "done", stage: "export", progress: 1, etaS: 0, message: "Ready" };
  if (!status && data?.show) status = data.show;

  const state: JobState = status?.status ?? (data?.exists ? "queued" : "running");
  const done = state === "done";
  const failed = state === "failed";
  const skew = last?.skew ?? 0;
  const hpgTime = (s: unknown) => (typeof s === "number" && s > 0 ? Math.round(s * 1000 + skew) : null);
  // job.json's submittedAt is written by lucid_runner on this Mac, so it's on the bridge's clock already
  const submittedAt = typeof data?.job?.submittedAt === "number" ? Math.round(data.job.submittedAt * 1000) : null;

  // upload (this Mac to HiPerGator) and the check: known from the bridge's own job; the check has no timing of its own
  const upload: LiveStage = { stage: "upload", state: "done", startedAt: null, endedAt: null };
  if (job?.submit === "failed" || (failed && status?.stage === "upload")) {
    upload.state = "failed";
    upload.startedAt = job?.createdAt ?? null;
  } else if (job && status?.stage === "upload" && !done) {
    upload.state = "running";
    upload.startedAt = job.createdAt;
  } else if (job && submittedAt && submittedAt >= job.createdAt) {
    upload.startedAt = job.createdAt;
    upload.endedAt = submittedAt;
  }
  const check: LiveStage = { stage: "check", state: upload.state === "done" ? "done" : "waiting", startedAt: null, endedAt: null };

  // the GPU stages, from status.json (pipeline/lucid/status.py)
  const raw = data?.status?.stages ?? {};
  const order: Stage[] = kind === "avatar" ? ["reconstruct", "export"] : ["views", ...(raw.upscale ? (["upscale"] as Stage[]) : []), "reconstruct", "export"];
  const gpuStages: LiveStage[] = order.map((stage) => {
    const e = raw[stage] ?? {};
    const s: LiveStageState = e.state === "running" || e.state === "done" || e.state === "failed" ? e.state : "waiting";
    return { stage, state: s, startedAt: hpgTime(e.startedAt), endedAt: s === "running" ? null : hpgTime(e.endedAt) };
  });
  const byStage = new Map(gpuStages.map((s) => [s.stage, s]));
  const rec = byStage.get("reconstruct")!;
  const exp = byStage.get("export")!;

  const views = data?.job?.viewsPerLayer && Array.isArray(data.job.layerPitches) ? data.job.viewsPerLayer * data.job.layerPitches.length : null;
  if (views && byStage.has("views")) byStage.get("views")!.views = views;

  if (kind === "replay") {
    // every chunk marks reconstruct running and none marks it done: it's done once its chunks have all reported, or
    // once the export (which only starts after every chunk succeeded) has begun
    const total = data?.job?.frames ?? 121;
    const chunks = Number(data?.job?.chunks ?? data?.slurm?.chunks) || 0;
    const busy = chunks ? Math.ceil(total / Math.ceil(total / chunks)) : 0; // 121 frames in 12 chunks: the 12th is empty
    const reports = (Array.isArray(data?.reports) ? data.reports : [])
      .map((r) => ({ end: hpgTime(r?.end), took: typeof r?.seconds === "number" && r.seconds > 0 ? r.seconds * 1000 : null }))
      .filter((r): r is { end: number; took: number | null } => r.end !== null);
    const lastReport = reports.length ? Math.max(...reports.map((r) => r.end)) : null;
    if (rec.state === "running" && (exp.startedAt || done || (busy && reports.length >= busy))) {
      rec.state = "done";
      rec.endedAt = lastReport && (!exp.startedAt || lastReport <= exp.startedAt) ? lastReport : exp.startedAt ?? lastReport;
    }
    rec.frames = { done: rec.state === "done" || done ? total : Math.min(data?.frames ?? 0, total), total };
    // how many chunks really ran side by side (each on its own GPU), from when each began and ended: when the lab was
    // busy they queue one after another, and the page must not claim more GPUs at once than there were
    if (rec.state === "done" || done) {
      const peak = atOnce(reports);
      if (peak) rec.gpus = peak;
    }
  }

  if (done) for (const s of [check, ...gpuStages]) s.state = "done";

  // next up and waiting for its GPUs, from when the stage before it ended (the first one: from when it was sent)
  let prevEnd: number | null = submittedAt;
  let prevDone = upload.state === "done";
  for (const s of gpuStages) {
    if (data && s.state === "waiting" && prevDone && !failed && !done) {
      s.state = "queued";
      s.startedAt = prevEnd;
    }
    if (s.state !== "queued" && s.startedAt && prevEnd && s.startedAt - prevEnd >= 60_000) s.waitedS = Math.round((s.startedAt - prevEnd) / 1000);
    prevEnd = s.endedAt;
    prevDone = s.state === "done";
  }

  // GPUs: the lab's jobs in Slurm; this run's are the ones in its slurm.json or working in its folder
  let gpus: LiveGpus | null = null;
  let idle = false;
  if (data?.squeue != null) {
    const rows = parseSqueue(data.squeue);
    const ids = slurmIds(data.slurm);
    const dirs = [data.dir, data.real].filter((d): d is string => !!d);
    const ours = rows.filter((r) => ids.has(r.base) || dirs.some((d) => r.dir === d || r.dir.startsWith(d + "/")));
    const working = ours.filter((r) => r.busy);
    const models = new Map<string, number>();
    for (const r of working) models.set(r.model ?? "GPU", (models.get(r.model ?? "GPU") ?? 0) + r.gpus);
    gpus = {
      run: [...models].map(([model, count]) => ({ model, count })).filter((m) => m.count > 0).sort((a, b) => b.count - a.count),
      waiting: ours.filter((r) => r.state === "PENDING").reduce((n, r) => n + Math.max(1, r.gpus), 0),
      lab: rows.filter((r) => r.busy).reduce((n, r) => n + r.gpus, 0),
    };
    for (const s of gpuStages) {
      if (s.state !== "running") continue;
      const n = working.filter((r) => stageOf(r, data.slurm) === s.stage).reduce((k, r) => k + r.gpus, 0);
      if (n) s.gpus = n;
    }
    // idle only once its jobs were queued (slurm.json): before that it's still being sent, not off the GPUs
    idle = !!data.exists && !!data.slurm && upload.state === "done" && !done && !failed && ours.length === 0;
  }

  // the latest fitted frame: copied home in the background, shown once it's here
  const newest = (data?.peeks ?? []).filter((p) => PEEK_NAME.test(p.name)).sort((a, b) => b.mtime - a.mtime || b.name.localeCompare(a.name))[0];
  if (newest && heard) wantPeek(id, newest);
  const peek = localPeek(id, views);
  const thumb = !peek && ready && local?.thumb ? dreamFile(id, local.thumb) : null;

  // the headline follows the stages above, in the runner's words (status.py's message stays on "Building them in 3D"
  // through the export, since nothing marks reconstruct done); the bridge's own words for sending and bringing home
  const current = gpuStages.find((s) => s.state === "running") ?? gpuStages.find((s) => s.state === "queued");
  const words: Partial<Record<Stage, string>> = {
    views: "Imagining every angle of them",
    upscale: "Sharpening every view",
    reconstruct: kind === "avatar" ? "Building them in 3D" : "Building them in 3D, frame by frame",
    export: "Getting them ready for your room",
  };
  const said = idle ? "Not on the GPUs right now" : current?.state === "queued" ? "Waiting for a GPU" : current ? words[current.stage] : null;

  const stages = [upload, check, ...gpuStages];
  const ends = stages.map((s) => s.endedAt).filter((t): t is number => t !== null);
  return {
    id,
    name: job?.name ?? local?.name ?? data?.job?.name ?? runName(id),
    kind,
    demo: false,
    state,
    message: done
      ? ready ? "Ready" : "Made on HiPerGator, and on its way to the library"
      : failed || status?.stage === "upload" || !data
        ? status?.message ?? "Reconnecting to HiPerGator"
        : said ?? status?.message ?? "Waiting for a GPU",
    startedAt: upload.startedAt ?? submittedAt ?? gpuStages.find((s) => s.startedAt)?.startedAt ?? null,
    // a failure with no time of its own (the upload) has no end to show, rather than one that grows at every poll
    endedAt: done ? exp.endedAt ?? (ends.length ? Math.max(...ends) : null) : failed && ends.length ? Math.max(...ends) : null,
    stages,
    gpus,
    idle,
    peek,
    thumb,
    ready,
    heardAt: last?.at ?? null,
    stale: !heard,
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Slurm

type Row = { base: string; name: string; state: string; dir: string; gpus: number; model: string | null; busy: boolean };

const MODELS: [RegExp, string][] = [
  [/b200/i, "B200"],
  [/rtx|6000/i, "RTX PRO 6000"],
  [/turin|\bl4\b|_l4|l4_/i, "L4"],
];

function modelOf(s: string): string | null {
  return MODELS.find(([re]) => re.test(s))?.[1] ?? null;
}

/** squeue -h -r -O ...| (or the -o fallback): JobID | ArrayJobID | ArrayTaskID | user | name | state | partition | dir | tres. */
function parseSqueue(text: string): Row[] {
  const rows: Row[] = [];
  for (const line of text.split("\n")) {
    const f = line.split("|").map((x) => x.trim());
    if (f.length < 6 || !f[0]) continue;
    const [jobId, arrayJob, , , name, state, partition = "", dir = "", tres = ""] = f;
    const base = /^\d+$/.test(arrayJob) && arrayJob !== "0" ? arrayJob : jobId.split("_")[0];
    const typed = /gres\/gpu:([^=,]+)=(\d+)/i.exec(tres);
    const plain = /gres\/gpu=(\d+)/i.exec(tres);
    // without tres (an older squeue), every lucid stage still asks for exactly one GPU (#SBATCH --gpus=1)
    const gpus = plain ? Number(plain[1]) : typed ? Number(typed[2]) : !tres && name.startsWith("lucid-") ? 1 : 0;
    // a waiting job may list several partitions: its model isn't decided yet
    const model = (typed && modelOf(typed[1])) || (partition.includes(",") ? null : modelOf(partition));
    const s = state.toUpperCase();
    rows.push({ base, name, state: s, dir, gpus, model, busy: /^(RUNNING|COMPLETING|CONFIGURING)/.test(s) });
  }
  return rows;
}

/** The most chunks that were running at the same moment, from each one's end and duration; null if any is unknown. */
function atOnce(reports: { end: number; took: number | null }[]): number | null {
  if (!reports.length || reports.some((r) => r.took === null)) return null;
  const edges = reports.flatMap((r) => [{ t: r.end - r.took!, d: 1 }, { t: r.end, d: -1 }]);
  edges.sort((a, b) => a.t - b.t || a.d - b.d); // one ending as another starts: not at once
  let n = 0;
  let peak = 0;
  for (const e of edges) peak = Math.max(peak, (n += e.d));
  return peak || null;
}

/** Every Slurm job id in slurm.json: views, reconstruct, export, avatar, and re-queued chunks. */
function slurmIds(slurm: Record<string, unknown> | null | undefined): Set<string> {
  const ids = new Set<string>();
  for (const [k, v] of Object.entries(slurm ?? {})) {
    if (k === "chunks") continue;
    for (const x of Array.isArray(v) ? v : [v]) if (typeof x === "string" || typeof x === "number") ids.add(String(x).trim());
  }
  return ids;
}

const STAGE_OF_JOB: Record<string, Stage> = { "lucid-views": "views", "lucid-recon": "reconstruct", "lucid-export": "export", "lucid-avatar": "reconstruct" };

function stageOf(r: Row, slurm: Record<string, unknown> | null | undefined): Stage | null {
  if (STAGE_OF_JOB[r.name]) return STAGE_OF_JOB[r.name];
  for (const [k, v] of Object.entries(slurm ?? {})) {
    if ((Array.isArray(v) ? v : [v]).map(String).includes(r.base)) {
      return k === "views" ? "views" : k === "export" ? "export" : k === "chunks" ? null : "reconstruct";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------
// The latest fitted frame (recon.py --peek): copied to .data/live/<id>/, one per run

let peekViews: number[] | null = null;

/** The views stage-recon.sbatch asks recon.py to peek at (the pairs in each strip), read from the script itself. */
function peekViewList(): number[] {
  if (!peekViews) {
    try {
      const m = /--peek\s+([\d,]+)/.exec(readFileSync(join(REPO, "pipeline", "hpg", "stage-recon.sbatch"), "utf8"));
      peekViews = m ? m[1].split(",").filter(Boolean).map(Number) : [];
    } catch {
      peekViews = [];
    }
    if (!peekViews.length) peekViews = [0, 4, 8, 12, 20];
  }
  return peekViews;
}

function readPeekMeta(id: string): PeekMeta | null {
  try {
    const m = JSON.parse(readFileSync(join(LIVE_DIR, id, "peek.json"), "utf8")) as PeekMeta;
    return PEEK_NAME.test(m.name) && existsSync(join(LIVE_DIR, id, m.name)) ? m : null;
  } catch {
    return null;
  }
}

function localPeek(id: string, views: number | null): LivePeek | null {
  const m = readPeekMeta(id);
  if (!m) return null;
  return {
    url: `/api/live/peek?id=${encodeURIComponent(id)}&f=${m.name}&v=${Math.round(m.mtime)}`,
    frame: Number(PEEK_NAME.exec(m.name)![1]),
    width: m.width,
    height: m.height,
    pairs: peekViewList().length,
    of: views,
  };
}

function wantPeek(id: string, newest: RemotePeek) {
  const have = readPeekMeta(id);
  if (have && have.name === newest.name && have.mtime === newest.mtime) return;
  if (cache.bringing.has(id) || Date.now() - (cache.peekFailedAt.get(id) ?? 0) < PEEK_RETRY_MS) return;
  cache.bringing.add(id);
  bringPeek(id, newest)
    .catch(() => cache.peekFailedAt.set(id, Date.now()))
    .finally(() => cache.bringing.delete(id));
}

async function bringPeek(id: string, p: RemotePeek) {
  const dir = join(LIVE_DIR, id);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `incoming-${p.name}`);
  rmSync(tmp, { force: true });
  await python(PEEK_CODE, [id, p.name, tmp], 120_000);
  if (statSync(tmp).size !== p.size) throw new Error("copied while it was being written"); // the next read tries again
  let size = jpegSize(readFileSync(tmp));
  if (!size) throw new Error("not a JPEG");
  if (Math.max(size.width, size.height) > PEEK_MAX_PX) {
    try {
      await run("sips", ["-Z", String(PEEK_MAX_PX), tmp], { timeout: 60_000 }); // macOS; elsewhere the full strip is served
      size = jpegSize(readFileSync(tmp)) ?? size;
    } catch {
      // keep the full-size strip
    }
  }
  renameSync(tmp, join(dir, p.name));
  // written aside and renamed: a poll reading it mid-write would find no strip and blank the picture for a moment
  writeFileSync(join(dir, "peek.json.tmp"), JSON.stringify({ ...p, ...size } satisfies PeekMeta));
  renameSync(join(dir, "peek.json.tmp"), join(dir, "peek.json"));
  for (const f of readdirSync(dir)) if (PEEK_NAME.test(f) && f !== p.name) rmSync(join(dir, f), { force: true });
}

/** Width and height from a JPEG's frame header. */
function jpegSize(b: Buffer): { width: number; height: number } | null {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) return null;
    const m = b[i + 1];
    if (m === 0xff) {
      i++; // fill byte
      continue;
    }
    if (m === 0x01 || (m >= 0xd0 && m <= 0xd8)) {
      i += 2; // no length
      continue;
    }
    if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
      return { height: b.readUInt16BE(i + 5), width: b.readUInt16BE(i + 7) };
    }
    i += 2 + b.readUInt16BE(i + 2);
  }
  return null;
}

/** GET /api/live/peek: the file for a run's fitted frame, if it's been copied here. */
export function peekPath(id: string, name: string): string | null {
  if (!isRunId(id) || !PEEK_NAME.test(name) || hidden(id)) return null;
  const p = join(LIVE_DIR, id, name);
  return existsSync(p) ? p : null;
}
