// The live pipeline page (/live): one run's stages with real timings, the GPUs on it and its latest fitted frame.
// Safe to import on server and client. Built on the bridge by lib/bridge/live.ts, served at GET /api/live.

import type { JobKind, JobState, Stage } from "./dream";

/** waiting: not reached yet. queued: next up, waiting for its GPUs (startedAt = when the wait began). */
export type LiveStageState = "done" | "running" | "queued" | "failed" | "waiting";

export interface LiveStage {
  stage: Stage;
  state: LiveStageState;
  startedAt: number | null; // ms since the epoch, on the bridge's clock
  endedAt: number | null;
  views?: number; // views: how many synced views 4DAnyone makes
  frames?: { done: number; total: number }; // reconstruct, replays
  gpus?: number; // GPUs on this stage right now (running), or the GPUs it ran on in parallel (done)
  waitedS?: number; // how long it waited in the queue for its GPUs before it started
}

export interface LiveGpus {
  run: { model: string; count: number }[]; // GPUs working on this run right now, by model
  waiting: number; // this run's GPU jobs still in the queue
  lab: number; // GPUs running across the lab's account right now
}

/** recon.py --peek: one JPEG of `pairs` pairs side by side, each 4DAnyone's view then our render from that camera. */
export interface LivePeek {
  url: string;
  frame: number;
  width: number;
  height: number;
  pairs: number;
  of: number | null; // views the run has, when known
}

export interface LiveRun {
  id: string;
  name: string;
  kind: JobKind;
  demo: boolean; // a mock run on the Mac: the real stages and timeline, no GPUs
  state: JobState;
  message: string;
  startedAt: number | null;
  endedAt: number | null;
  stages: LiveStage[];
  gpus: LiveGpus | null; // null: not known (a demo run, or HiPerGator not answering)
  idle: boolean; // HiPerGator answered: unfinished, yet nothing of it is on the GPUs or in the queue
  peek: LivePeek | null;
  thumb: string | null; // a demo run: the sample bundle's thumb; a finished run without a peek: its own
  ready: boolean; // the dream is in the library
  heardAt: number | null; // when HiPerGator last answered about this run
  stale: boolean; // it didn't answer this time: what it said last
}

export interface LiveReply {
  now: number;
  refreshS: number;
  run: LiveRun | null;
  // none: no run yet. unknown: no run by that id. offline: a real run, and this bridge is in mock mode.
  // connecting: HiPerGator is slow to answer the first time; the page asks again.
  reason?: "none" | "unknown" | "offline" | "connecting";
}

/** 75 s -> "1:15", 3725 s -> "1:02:05". */
export function clock(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = String(s % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${ss}` : `${m}:${ss}`;
}

/** For waits: "40 s", "3 min", "1 h 5 min". */
export function span(s: number): string {
  if (s < 60) return `${Math.round(s)} s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min`;
  return `${Math.floor(m / 60)} h ${m % 60} min`;
}
