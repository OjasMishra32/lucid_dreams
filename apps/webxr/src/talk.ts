import * as THREE from "three";
import type { Skeleton } from "./avatar";

// Talk with them, in the viewer: press Talk (the palm menu in your room, the button on a laptop), say something, press
// again to send. Their reply comes back in their own cloned voice (apps/talk), from where their mouth is, the words
// beside them labelled AI voice, and their jaw moves with the reply's loudness. The viewer's own server relays it
// (vite.config.ts, /talk/<who>): it adds the Talk server's token, so no key or token reaches the page, and it only lets
// through people whose consent covers their talk leaving the Mac (Vishal; Ian's grandma, with her family's agreement). A reply with
// no voice yet (not cloned) shows the words alone; it's never read in anyone else's voice.

export type TalkState = "idle" | "listening" | "thinking" | "speaking";

export const TALK_LABEL: Record<TalkState, string> = { idle: "Talk", listening: "Send", thinking: "Thinking…", speaking: "Stop" };

/** Whether this person can be talked to here (the relay and the Talk server answer), and whether their voice is in. */
export async function talkAvailable(who: string): Promise<{ on: boolean; voice: boolean }> {
  try {
    const r = await fetch(`${import.meta.env.BASE_URL}talk/${encodeURIComponent(who)}/health`, { cache: "no-store" });
    if (!r.ok) return { on: false, voice: false };
    const j = (await r.json()) as { ok?: boolean; voice?: boolean };
    return { on: !!j.ok, voice: !!j.voice };
  } catch {
    return { on: false, voice: false };
  }
}

const MAX_SECONDS = 20;

export class Talk {
  state: TalkState = "idle";
  /** How open the mouth is, 0-1: the reply's loudness, quick to open and a touch slower to close. */
  level = 0;
  /** The words beside them (empty: nothing to show), and whether they're their reply (tagged AI voice) or a hint. */
  text = "";
  /** The reply in English, for someone speaking another language (empty when it's the same words). */
  english = "";
  reply = false;
  onState: (s: TalkState) => void = () => {};
  private rec: MediaRecorder | null = null;
  private stream: MediaStream | null = null;
  private chunks: Blob[] = [];
  private stopTimer = 0;
  private session = Math.random().toString(36).slice(2, 10);
  private sound: THREE.PositionalAudio;
  private analyser: THREE.AudioAnalyser;
  private wave = new Uint8Array(256);
  private voiced = false; // the reply playing now has their voice
  private wordsUntil = 0; // a reply without a voice: how long its words stay
  private textUntil = 0;
  private abort: AbortController | null = null;

  constructor(
    private who: string,
    listener: THREE.AudioListener,
    parent: THREE.Object3D,
    mouth: THREE.Vector3,
  ) {
    this.sound = new THREE.PositionalAudio(listener);
    this.sound.setDistanceModel("inverse");
    this.sound.setRefDistance(1.2);
    this.sound.setRolloffFactor(1.1);
    this.sound.panner.panningModel = "HRTF";
    this.sound.position.copy(mouth);
    parent.add(this.sound);
    this.analyser = new THREE.AudioAnalyser(this.sound, 512);
  }

  /** The one button: start listening, send, or stop them mid-reply. */
  press() {
    if (this.state === "idle") void this.listen();
    else if (this.state === "listening") this.send();
    else this.stop();
  }

  stop() {
    this.abort?.abort();
    this.abort = null;
    if (this.rec && this.rec.state !== "inactive") {
      this.rec.onstop = null;
      this.rec.stop();
    }
    this.release();
    if (this.sound.isPlaying) this.sound.stop();
    this.voiced = false;
    this.wordsUntil = 0;
    this.set("idle");
  }

  /** Once a frame: the mouth follows the reply, the words fade when it's done. */
  update(dt: number) {
    let target = 0;
    const now = performance.now();
    if (this.state === "speaking" && this.voiced && !this.sound.isPlaying) {
      // their reply has ended
      this.voiced = false;
      this.textUntil = now + 2500;
      this.set("idle");
    } else if (this.state === "speaking" && this.voiced) {
      this.analyser.analyser.getByteTimeDomainData(this.wave);
      let sum = 0;
      for (const v of this.wave) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / this.wave.length);
      target = THREE.MathUtils.clamp((rms - 0.015) * 7, 0, 1);
    } else if (this.state === "speaking" && !this.voiced && now > this.wordsUntil) {
      this.textUntil = now + 2500;
      this.set("idle");
    }
    const rate = target > this.level ? 28 : 12;
    this.level += (target - this.level) * Math.min(1, dt * rate);
    if (this.state === "idle" && this.text && now > this.textUntil) this.text = "";
  }

  private set(s: TalkState) {
    this.state = s;
    this.onState(s);
  }

  private release() {
    clearTimeout(this.stopTimer);
    this.stream?.getTracks().forEach((t) => t.stop());
    this.stream = null;
    this.rec = null;
  }

  private async listen() {
    if (this.sound.isPlaying) this.sound.stop();
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new Error("Talk needs the microphone, and the browser only shares it on https.");
      this.stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      const name = (e as DOMException)?.name;
      this.say(name === "NotAllowedError" ? "Talk needs the microphone. Allow it for this page, then press Talk again." : (e as Error).message || "The microphone didn't start.");
      return;
    }
    const type = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"].find((t) => MediaRecorder.isTypeSupported?.(t)) ?? "";
    this.chunks = [];
    this.rec = new MediaRecorder(this.stream, type ? { mimeType: type } : undefined);
    this.rec.ondataavailable = (e) => e.data.size && this.chunks.push(e.data);
    this.rec.start(250);
    this.text = "Listening… press Talk again to send";
    this.reply = false;
    this.textUntil = Infinity;
    this.set("listening");
    this.stopTimer = window.setTimeout(() => this.state === "listening" && this.send(), MAX_SECONDS * 1000);
  }

  private send() {
    const rec = this.rec;
    if (!rec) return this.set("idle");
    this.set("thinking");
    this.text = "…";
    this.reply = false;
    rec.onstop = () => {
      const blob = new Blob(this.chunks, { type: rec.mimeType || "audio/webm" });
      this.release();
      void this.ask(blob);
    };
    rec.stop();
  }

  private async ask(blob: Blob) {
    this.abort = new AbortController();
    const signal = this.abort.signal;
    // never left thinking: a reply that hasn't come back in 30 s is given up on
    let late = false;
    const giveUp = window.setTimeout(() => {
      late = true;
      this.abort?.abort();
    }, 30_000);
    try {
      const r = await fetch(`${import.meta.env.BASE_URL}talk/${encodeURIComponent(this.who)}?session=${this.session}`, { method: "POST", headers: { "Content-Type": blob.type || "audio/webm" }, body: blob, signal });
      const j = (await r.json().catch(() => ({}))) as { heard?: string; reply?: string; english?: string; audio?: string | null; error?: string };
      // the Talk server's limits (each visitor's turns an hour, everyone's for the day, 20 s recordings): said plainly
      if (r.status === 429) return this.say(j.error || "Talk is resting, try again in a few minutes.");
      if (r.status === 413) return this.say(j.error || "That was too long: keep it under 20 seconds.");
      if (!r.ok || j.error) throw new Error(j.error || `Talk ${r.status}`);
      if (!j.reply) return this.say("I didn't catch that. Press Talk and try again.");
      this.text = j.reply;
      this.english = j.english && j.english.trim() !== j.reply.trim() ? j.english.trim() : "";
      this.reply = true;
      if (j.audio) {
        const bytes = await (await fetch(j.audio, { signal })).arrayBuffer();
        const ctx = this.sound.context;
        if (ctx.state !== "running") await ctx.resume().catch(() => {});
        const buffer = await ctx.decodeAudioData(bytes);
        if (signal.aborted) return late ? this.say("Talk took too long. Press Talk to try again.") : undefined;
        this.sound.setBuffer(buffer);
        this.sound.play();
        this.voiced = true;
        this.textUntil = Infinity;
        this.set("speaking");
      } else {
        // their voice isn't cloned yet: the words alone, about as long as they'd take to say
        this.wordsUntil = performance.now() + 900 + j.reply.split(/\s+/).length * 330;
        this.textUntil = this.wordsUntil + 2500;
        this.set("speaking");
      }
    } catch (e) {
      if (late) return this.say("Talk took too long. Press Talk to try again.");
      if ((e as Error).name === "AbortError") return;
      this.say(`Talk didn't work: ${(e as Error).message}`);
    } finally {
      clearTimeout(giveUp);
      this.abort = null;
    }
  }

  private say(text: string) {
    this.text = text;
    this.english = "";
    this.reply = false;
    this.textUntil = performance.now() + 5000;
    this.set("idle");
  }
}

/**
 * Their words beside them, wrapped to four lines, with an AI voice tag (every reply is AI, and says so), and the
 * English under them, smaller, when they speak another language.
 */
export class TalkCaption {
  readonly mesh: THREE.Mesh;
  private canvas = document.createElement("canvas");
  private tex: THREE.CanvasTexture;
  private text = "";
  private static readonly W = 1280;
  private static readonly H = 600;

  constructor() {
    this.canvas.width = TalkCaption.W;
    this.canvas.height = TalkCaption.H;
    this.tex = new THREE.CanvasTexture(this.canvas);
    this.tex.colorSpace = THREE.SRGBColorSpace;
    this.mesh = new THREE.Mesh(
      new THREE.PlaneGeometry(0.8, 0.8 * (TalkCaption.H / TalkCaption.W)),
      new THREE.MeshBasicMaterial({ map: this.tex, transparent: true, opacity: 0, depthWrite: false }),
    );
    this.mesh.renderOrder = 10;
  }

  set(text: string, tag: string, english = "") {
    const key = `${tag}|${text}|${english}`;
    if (key === this.text) return;
    this.text = key;
    const c = this.canvas.getContext("2d")!;
    const { W, H } = TalkCaption;
    c.clearRect(0, 0, W, H);
    if (!text) return void (this.tex.needsUpdate = true);
    const wrap = (s: string, font: string, max: number) => {
      c.font = font;
      const lines: string[] = [];
      for (const word of s.split(/\s+/)) {
        const last = lines[lines.length - 1];
        if (last !== undefined && c.measureText(`${last} ${word}`).width < W - 140) lines[lines.length - 1] = `${last} ${word}`;
        else lines.push(word);
      }
      if (lines.length > max) {
        lines.length = max;
        lines[max - 1] = `${lines[max - 1].replace(/\s+\S*$/, "")}…`;
      }
      return lines;
    };
    const MAIN = '500 50px -apple-system, "SF Pro Text", "Inter", sans-serif';
    const SUB = '400 36px -apple-system, "SF Pro Text", "Inter", sans-serif';
    const lines = wrap(text, MAIN, 4);
    const sub = english ? wrap(english, SUB, 3) : [];
    const lineH = 64;
    const subH = 46;
    const h = 92 + lines.length * lineH + (tag ? 18 : 0) + (sub.length ? 22 + sub.length * subH : 0);
    c.font = MAIN;
    const wMain = Math.max(...lines.map((l) => c.measureText(l).width));
    c.font = SUB;
    const wSub = sub.length ? Math.max(...sub.map((l) => c.measureText(l).width)) : 0;
    const w = Math.min(W - 16, Math.max(wMain, wSub) + 110);
    const top = (H - h) / 2;
    c.fillStyle = "rgba(29,29,31,0.82)";
    c.beginPath();
    c.roundRect((W - w) / 2, top, w, h, 40);
    c.fill();
    if (tag) {
      c.font = '600 30px -apple-system, "SF Pro Text", "Inter", sans-serif';
      c.fillStyle = "#2997ff";
      c.textAlign = "center";
      c.fillText(tag.toUpperCase(), W / 2, top + 50);
    }
    c.font = MAIN;
    c.fillStyle = "#f5f5f7";
    c.textAlign = "center";
    c.textBaseline = "middle";
    const y0 = top + (tag ? 96 : 60);
    lines.forEach((l, i) => c.fillText(l, W / 2, y0 + i * lineH + lineH / 2 - 14, W - 64));
    if (sub.length) {
      c.font = SUB;
      c.fillStyle = "#a1a1a6";
      const y1 = y0 + lines.length * lineH + 22;
      sub.forEach((l, i) => c.fillText(l, W / 2, y1 + i * subH + subH / 2 - 14, W - 64));
    }
    this.tex.needsUpdate = true;
  }

  fade(visible: boolean, dt: number) {
    const m = this.mesh.material as THREE.MeshBasicMaterial;
    m.opacity += ((visible ? 1 : 0) - m.opacity) * Math.min(1, dt * 8);
  }
}

/**
 * Their mouth open by `level` (0-1, the reply's loudness): SMPL-X's jaw (joint 22) turned down about its own x, at
 * most 8.6 degrees (past that a Gaussian mouth smears: it has no teeth), whichever way the rig faces (the eyes, 23
 * and 24, are in front of the head).
 */
const JAW = 22;
const _jawQ = new THREE.Quaternion();
const _jawX = new THREE.Vector3(1, 0, 0);
export function openJaw(local: THREE.Quaternion[], skeleton: Skeleton, level: number) {
  if (level < 0.002 || !local[JAW] || skeleton.rest.length <= 24) return;
  const facing = Math.sign(skeleton.rest[23][2] + skeleton.rest[24][2] - 2 * skeleton.rest[15][2]) || 1;
  local[JAW].multiply(_jawQ.setFromAxisAngle(_jawX, facing * 0.15 * Math.min(1, level)));
}
