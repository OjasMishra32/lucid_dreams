import "server-only";
import { execFile } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  STAGES, STAGE_LABELS, isPrivate,
  type JobKind, type JobStatus, type LiveChoice, type LiveGpus, type LivePeek, type LiveRun, type LiveStage, type LiveState, type Stage,
} from "../dream";
import { DATA_DIR, REPO, heldIds, isRunId, readDream } from "./dreams";
import { MODE, activeJobs } from "./index";
import { mockStatus } from "./mock";
import { remoteStatus } from "./runner";
import { runName, runSubmittedAt, submittedRuns } from "./runs";
import { allJobs, getJob } from "./store";

// /live, for the judges: how a dream is made, shown instead of told. For a run it reads, through lucid_runner.py's own
// SSH link and its own `remote` and `rsync`, only these (nothing is written on HiPerGator, and never a whole run):
//   - status.json, job.json and slurm.json from the run's folder: each stage's start and end, the frame count, the Slurm ids;
//   - `squeue` for those Slurm ids: the GPUs this run holds or waits for;
//   - the names and times of recon/peek-*.jpg, and the newest of each kind, one file at a time: ground truth beside our
//     render, written by the reconstruction (recon.py --peek).
// The runner's `status` call (stage, progress, ETA) is used as it is. Never for a private run or a held one.

const exec = promisify(execFile);
const RUNNER_DIR = process.env.LUCID_RUNNER_DIR ?? join(REPO, "pipeline", "runner"); // (tests point it at a stand-in)
const CACHE = join(DATA_DIR, "live");
const DETAILS_TTL_MS = 5000;
const PEEK_RE = /^peek(-source)?-(\d{6})\.jpg$/;

/** What the bridge asks the run's folder and Slurm, in one SSH call. RUN is set in front of it; id-safe by isRunId. */
const SCRIPT = `
cd "$RUN" 2>/dev/null || { echo '@@missing'; exit 0; }
echo '@@now'; date +%s
echo '@@status'; cat status.json 2>/dev/null; echo
echo '@@job'; cat job.json 2>/dev/null; echo
echo '@@slurm'; cat slurm.json 2>/dev/null; echo
echo '@@frames'; ls recon/frames 2>/dev/null | grep -c '\\.spz$'
echo '@@peeks'; stat -c '%Y %n' recon/peek-*.jpg 2>/dev/null | sort -rn | head -12
echo '@@squeue'
IDS=$(grep -o '"[0-9][0-9]*"' slurm.json 2>/dev/null | tr -d '"' | paste -sd, -)
[ -n "$IDS" ] && squeue -h -j "$IDS" -o '%i|%j|%T|%P|%b|%N' 2>/dev/null
exit 0
`;

export interface SqueueRow {
  id: string;
  name: string;
  state: string;
  partition: string;
  gres: string;
  nodes: string;
}
export interface Details {
  now: number | null; // HiPerGator's clock, seconds
  stages: Record<string, { state?: string; startedAt?: number; endedAt?: number }>;
  job: { kind?: string; submittedAt?: number; frames?: number; name?: string } | null;
  frames: number; // reconstruction's SPZ frames written so far
  peeks: { at: number; name: string }[];
  squeue: SqueueRow[];
}

function json<T>(s: string | undefined): T | null {
  try {
    return s?.trim() ? (JSON.parse(s) as T) : null;
  } catch {
    return null; // mid-write on HiPerGator: the next read has it
  }
}

/** The script's output as data; null when the run's folder isn't there or nothing came back. */
export function parseDetails(text: string): Details | null {
  if (!text.includes("@@") || /^@@missing$/m.test(text)) return null;
  const sec: Record<string, string> = {};
  let key = "";
  for (const line of text.split("\n")) {
    const m = /^@@(\w+)$/.exec(line);
    if (m) sec[(key = m[1])] = "";
    else if (key) sec[key] += line + "\n";
  }
  const num = (s: string | undefined) => {
    const n = Number(s?.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };
  return {
    now: num(sec.now),
    stages: json<{ stages?: Details["stages"] }>(sec.status)?.stages ?? {},
    job: json<Details["job"]>(sec.job),
    frames: Math.max(0, Math.round(Number(sec.frames?.trim()) || 0)),
    peeks: (sec.peeks ?? "").split("\n").flatMap((l) => {
      const m = /^(\d+)\s+(?:\S*\/)?(peek[-\w]*\.jpg)$/.exec(l.trim());
      return m && PEEK_RE.test(m[2]) ? [{ at: Number(m[1]), name: m[2] }] : [];
    }),
    squeue: (sec.squeue ?? "").split("\n").flatMap((l) => {
      const [id, name, state, partition, gres, nodes] = l.trim().split("|");
      return id && name && state ? [{ id, name, state, partition: partition ?? "", gres: gres ?? "", nodes: nodes ?? "" }] : [];
    }),
  };
}

/** How many tasks a Slurm id stands for: "123_4" is one, "123_[0-11]" twelve, "123_[3-5,8%2]" four. */
function tasks(id: string): number {
  const m = /_\[([^\]]+)\]/.exec(id);
  if (!m) return 1;
  let n = 0;
  for (const part of m[1].replace(/%\d+$/, "").split(",")) {
    const r = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (r) n += r[2] ? Number(r[2]) - Number(r[1]) + 1 : 1;
  }
  return Math.max(n, 1);
}

/** "B200", "RTX PRO 6000", "L4": from the GRES type if it has one, else the partition's name. */
export function gpuType(gres: string, partition: string): string {
  const typed = /gpu:([a-z][\w-]*):\d+/i.exec(gres)?.[1] ?? partition.replace(/^hpg-/i, "");
  if (/b200/i.test(typed)) return "B200";
  if (/rtx|6000|blackwell/i.test(typed)) return "RTX PRO 6000";
  if (/^l4$|\bl4\b|turin/i.test(typed)) return "L4";
  return typed || "GPU";
}

function stageOfJob(name: string): Stage | null {
  if (/views/.test(name)) return "views";
  if (/upscale/.test(name)) return "upscale";
  if (/recon|avatar/.test(name)) return "reconstruct";
  if (/export/.test(name)) return "export";
  return null;
}

/** The GPUs a run holds or waits for, by stage. Other jobs (not lucid's) never appear. */
export function gpusOf(rows: SqueueRow[]): LiveGpus[] {
  const by = new Map<Stage, LiveGpus>();
  for (const r of rows) {
    const stage = /^lucid-/.test(r.name) ? stageOfJob(r.name) : null;
    if (!stage || !/gpu/i.test(r.gres)) continue;
    const per = Number(/(\d+)$/.exec(r.gres)?.[1]) || 1;
    const n = tasks(r.id) * per;
    const g = by.get(stage) ?? { stage, label: STAGE_LABELS[stage], type: gpuType(r.gres, r.partition), running: 0, waiting: 0 };
    if (r.state === "RUNNING") g.running += n;
    else if (r.state === "PENDING") g.waiting += n;
    by.set(stage, g);
  }
  return [...by.values()].sort((a, b) => STAGES.indexOf(a.stage) - STAGES.indexOf(b.stage));
}

/**
 * One run as /live shows it: the job API's status plus, when HiPerGator answered, real timings, GPUs and strips.
 * `at` is the bridge's clock in ms. Pure: tests/live.test.ts feeds it canned output.
 */
export function buildRun(base: { id: string; name: string; kind: JobKind }, status: JobStatus, d: Details | null, at: number): LiveRun {
  const now = d?.now ?? at / 1000;
  const avatar = base.kind === "avatar";
  const shown = STAGES.filter((s) => (s === "views" || s === "upscale" ? !avatar && (s === "views" || !!d?.stages.upscale) : true));
  const failedAt = status.status === "failed" ? status.stage : null;

  const stages: LiveStage[] = shown.map((stage) => {
    const st = d?.stages[stage];
    let state: LiveStage["state"];
    let from = st?.startedAt;
    let to = st?.endedAt;
    if (status.status === "done") state = "done";
    else if (d) {
      const exportStarted = d.stages.export?.startedAt;
      if (stage === "reconstruct" && exportStarted) {
        state = "done"; // reconstruction is never marked done: the export starting is what ends it
        to = exportStarted;
      } else if (st?.state === "failed" || failedAt === stage) state = "failed";
      else if (st?.state === "done") state = "done";
      else if (st?.state === "running") state = "running";
      else state = stage === "upload" || stage === "check" ? "done" : "pending";
    } else {
      const i = STAGES.indexOf(stage);
      const at_ = STAGES.indexOf(status.stage);
      state = failedAt === stage ? "failed" : i < at_ ? "done" : i === at_ ? (status.status === "queued" ? "pending" : "running") : "pending";
    }
    let durationS: number | null = null;
    if (from && state === "done" && (to ?? 0) >= from) durationS = to! - from;
    else if (from && state === "running") durationS = Math.max(0, now - from);
    return { stage, label: STAGE_LABELS[stage], state, durationS: durationS === null ? null : Math.round(durationS) };
  });

  const total = Math.max(1, Math.round(d?.job?.frames ?? 121));
  const recon = stages.find((s) => s.stage === "reconstruct");
  const frames =
    !avatar && d && recon && recon.state !== "pending"
      ? { done: recon.state === "done" ? total : Math.min(d.frames, total), total }
      : null;

  const newest = (kind: LivePeek["kind"]): LivePeek[] => {
    const hit = (d?.peeks ?? []).filter((p) => (PEEK_RE.exec(p.name)?.[1] ? "real" : "imagined") === kind).sort((a, b) => b.at - a.at)[0];
    if (!hit) return [];
    return [{
      kind, name: hit.name, at: hit.at, frame: Number(PEEK_RE.exec(hit.name)![2]),
      url: `/api/live/peek?run=${encodeURIComponent(base.id)}&name=${hit.name}&at=${hit.at}`,
    }];
  };

  const submitted = d?.job?.submittedAt;
  return {
    id: base.id,
    name: base.name,
    kind: base.kind,
    status,
    stages,
    elapsedS: submitted && now >= submitted ? Math.round(now - submitted) : null,
    frames,
    gpus: d ? gpusOf(d.squeue) : [],
    peeks: [...newest("real"), ...newest("imagined")],
    source: d ? "hpg" : "job",
    at,
  };
}

// ---- reading HiPerGator ----

type Cache = { details: Map<string, { at: number; value: Promise<Details | null> }>; peeks: Map<string, Promise<string | null>> };
const g = globalThis as unknown as { __lucidLive?: Cache };
const cache: Cache = (g.__lucidLive ??= { details: new Map(), peeks: new Map() });

/** Python that calls lucid_runner.py's own `remote` / `rsync`, as hpg.ts does for the prepped clip. */
let inflight = 0; // ssh and rsync calls under way: a few at a time, they share one connection with the real jobs
async function viaRunner(body: string[], timeout: number): Promise<string> {
  if (inflight >= 3) throw new Error("busy");
  inflight++;
  try {
    return await runPython(body, timeout);
  } finally {
    inflight--;
  }
}

async function runPython(body: string[], timeout: number): Promise<string> {
  const code = ["import sys, json, shlex", `sys.path.insert(0, ${JSON.stringify(RUNNER_DIR)})`, "import lucid_runner as r", ...body].join("\n");
  const { stdout } = await exec(process.env.PYTHON ?? "python3", ["-c", code], { cwd: REPO, timeout, maxBuffer: 1 << 20 });
  return stdout;
}

export function remoteDetails(id: string): Promise<Details | null> {
  const hit = cache.details.get(id);
  if (hit && Date.now() - hit.at < DETAILS_TTL_MS) return hit.value;
  // id is a run id (isRunId: letters, digits, . _ -), so it is safe inside the Python and the shell path below
  const value = viaRunner(
    [
      `script = "RUN=" + shlex.quote(r.REMOTE + "/runs/${id}") + "\\n" + ${JSON.stringify(SCRIPT)}`,
      'print(r.remote("bash -c " + shlex.quote(script)))',
    ],
    25_000,
  ).then(parseDetails, () => null); // HiPerGator unreachable for a moment: the job API's status still shows
  cache.details.set(id, { at: Date.now(), value });
  return value;
}

/**
 * One truth-vs-render strip, fetched when someone looks at it: a single small JPEG through the runner's rsync, kept under
 * .data/live/<run>/ (its time is in its name, so a newer strip is a new file). Null when it can't be had.
 */
export async function peekFile(id: string, name: string, at: number): Promise<string | null> {
  if (!known(id) || !PEEK_RE.test(name) || !Number.isInteger(at) || at < 1e8 || at > 1e11) return null;
  const dir = join(CACHE, id);
  const dest = join(dir, `${name.replace(/\.jpg$/, "")}@${at}.jpg`);
  if (existsSync(dest)) return dest;
  if (MODE !== "runner" || getJob(id)?.mode === "mock") return null;
  // only a strip the run really has: its listing (read a moment ago for the page) names this file and time
  const listed = (await remoteDetails(id))?.peeks.some((p) => p.name === name && p.at === at);
  if (!listed) return null;
  const key = dest;
  const going = cache.peeks.get(key);
  if (going) return going;
  mkdirSync(dir, { recursive: true });
  const p = viaRunner(
    [`r.rsync(f"{r.HOST}:{r.REMOTE}/runs/${id}/recon/${name}", ${JSON.stringify(dest)}, "--max-size=8m", "--no-links")`],
    90_000,
  )
    .then(() => {
      const head = existsSync(dest) && lstatSync(dest).isFile() ? readFileSync(dest).subarray(0, 2) : null;
      if (!head || head[0] !== 0xff || head[1] !== 0xd8) {
        rmSync(dest, { force: true });
        return null;
      }
      // an older strip of the same kind is no use any more
      const same = name.startsWith("peek-source-") ? /^peek-source-\d{6}@/ : /^peek-\d{6}@/;
      for (const f of readdirSync(dir)) if (same.test(f) && join(dir, f) !== dest) rmSync(join(dir, f), { force: true });
      return dest;
    })
    .catch(() => null)
    .finally(() => cache.peeks.delete(key));
  cache.peeks.set(key, p);
  return p;
}

// ---- which run, and who may see it ----

/** Never a family's run (flag or id) and never one held back: their strips show a person's render. */
export function allowed(id: string): boolean {
  if (!isRunId(id) || isPrivate({ id, private: readDream(id)?.private })) return false;
  // held by name, or a run named from a held dream (a dropped clip is "<name>-<date>-<time>"), in any case
  const me = id.toLowerCase();
  return ![...heldIds()].some((h) => me === h.toLowerCase() || me.startsWith(`${h.toLowerCase()}-`));
}

/** A run this bridge started, lucid_runner.py submitted, or has a bundle for: nothing else is ever asked of HiPerGator. */
function known(id: string): boolean {
  return allowed(id) && (!!getJob(id) || submittedRuns().includes(id) || !!readDream(id));
}

/** What the job API says, without ever starting a fetch: HiPerGator's own answer, else the last one seen. */
async function statusOf(id: string): Promise<JobStatus | null> {
  const job = getJob(id);
  if (job?.mode === "mock") return mockStatus(job);
  if (MODE !== "runner") return null;
  return (await remoteStatus(id)) ?? job?.last ?? null;
}

const RECENT = 8;
/** Runs worth switching to, newest first: the ones this bridge started, then those lucid_runner.py submitted. */
function recentIds(): string[] {
  const ids = [...allJobs().map((j) => j.id), ...submittedRuns().reverse()];
  const stamp = (id: string) => getJob(id)?.createdAt ?? runSubmittedAt(id) ?? 0;
  return [...new Set(ids)].filter(allowed).sort((a, b) => stamp(b) - stamp(a)).slice(0, RECENT);
}

function nameOf(id: string): string {
  return getJob(id)?.name ?? readDream(id)?.name ?? runName(id);
}

/** One run in full, or null when it may not be shown or isn't known. */
export async function liveRun(id: string): Promise<LiveRun | null> {
  if (!known(id)) return null;
  const status = await statusOf(id);
  if (!status) return null;
  const job = getJob(id);
  const real = MODE === "runner" && job?.mode !== "mock";
  const details = real ? await remoteDetails(id) : null;
  const kind = (job?.kind ?? (details?.job?.kind === "avatar" ? "avatar" : null) ?? readDream(id)?.kind ?? "replay") as JobKind;
  return buildRun({ id, name: nameOf(id), kind }, status, details, Date.now());
}

/**
 * What /live shows: `want` if it may be shown; else (or with `auto`, once `want` is over) the run that is working now,
 * else the newest one. `choices` lists the others to switch to.
 */
export async function liveState(want: string | null, auto = false): Promise<LiveState> {
  const recent = recentIds();
  const working = new Set<string>();
  let pick: string | null = want && known(want) ? want : null;
  let run: LiveRun | null = pick ? await liveRun(pick) : null;

  if (!run || (auto && run.status.status !== "running" && run.status.status !== "queued")) {
    for (const j of await activeJobs()) if (allowed(j.id) && (j.status.status === "running" || j.status.status === "queued")) working.add(j.id);
    pick = [...working][0] ?? run?.id ?? recent[0] ?? null;
    if (pick && pick !== run?.id) run = await liveRun(pick);
  }
  if (run && (run.status.status === "running" || run.status.status === "queued")) working.add(run.id);
  const ids = [...new Set([...(run ? [run.id] : []), ...recent])].slice(0, RECENT);
  const choices: LiveChoice[] = ids.map((id) => ({ id, name: nameOf(id), live: working.has(id) }));
  return { run, choices };
}
