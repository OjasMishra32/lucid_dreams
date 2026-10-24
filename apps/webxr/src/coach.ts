import { sayNext } from "./experience";

// Ask: the coach in a lesson. While a step is on screen you ask out loud ("how should my wrist be here?") and Gemini
// Live answers about that step. The bridge (apps/web, /api/live/token, reached through this viewer's own server)
// mints a single-use token with the step written into the session's instructions, so the key never leaves the Mac.
// Your voice goes up as 16 kHz PCM; the answer comes back as text and is read in the device's own voice (the same
// one that reads the tips), never the person's. A model that only speaks sends its transcript too: the viewer reads
// that and never plays the model's audio.

export type CoachState = "idle" | "starting" | "listening" | "thinking" | "answering";

/** The step on screen and the lesson around it: what the question is about. */
export interface CoachAsk {
  dream: string;
  index: number;
  count: number;
  title: string;
  tip?: string;
  start: number;
  end: number;
  speed?: number;
  at?: number; // where in the clip the teacher was paused to ask
  plan: { title?: string; intent?: string };
}

export interface CoachEvents {
  state?: (s: CoachState) => void;
  heard?: (question: string) => void; // what Gemini heard you ask, so far
  answer?: (text: string) => void; // the answer, so far
  error?: (message: string) => void; // one sentence for the screen; the coach is idle again
  end?: () => void; // the session is over (stopped, finished or failed): the mic is released
}

const TOKEN = "/api/live/token"; // same origin: vite.config.ts passes it to the bridge on :5170
const LIVE = "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1alpha.GenerativeService.BidiGenerateContentConstrained";
const RATE = 16000; // Hz, 16-bit little-endian mono: the Live API's native input
const CHUNK = RATE / 10; // 100 ms of audio per message
const FIRST_QUESTION_MS = 15_000; // nothing asked in this long: the session ends by itself
const FOLLOW_UP_MS = 10_000; // after an answer, this long for another question
const ANSWER_MS = 15_000; // no answer this long after you stopped talking: listen again
const SESSION_MS = 3 * 60_000;
const VOICE_MS = 300; // this much voice is a question, not a cough
const PAUSE_MS = 800; // this much quiet after it and you've finished asking
const RETRY = /not found|not supported|unsupported|modalit|invalid argument/i; // this model can't do it: try the next

let ladder = 0; // the token attempt (model x reply mode) that last opened a session: the next one starts there

/** Whether the bridge has a Gemini key (and is reachable): without one the viewer offers no Ask at all. */
export async function coachAvailable(): Promise<boolean> {
  try {
    const r = await fetch(TOKEN, { cache: "no-store" });
    return r.ok && (await r.json())?.state === "on";
  } catch {
    return false;
  }
}

interface Session {
  ws: WebSocket | null;
  mic: Mic | null;
  attempt: number;
  ready: boolean; // Gemini accepted the setup
  reply: "text" | "audio";
  sending: boolean; // the mic goes up only while listening, never while the device is talking
  heard: string;
  answer: string;
  unsaid: string; // the end of the answer that isn't a whole sentence yet
  lines: string[]; // sentences waiting for the device's voice
  talking: boolean; // the device is saying one now
  turnDone: boolean;
  leaving: boolean; // Gemini said it's closing soon: finish this answer, then stop
  talk: number; // ms of voice in what you're saying now
  quiet: number; // ms of quiet since
  floor: number; // the room's own noise level
  timer: number;
  cap: number;
}

export class Coach {
  state: CoachState = "idle";
  level = 0; // the mic, 0-1, for a meter
  private s: Session | null = null;

  constructor(private on: CoachEvents) {}

  get active(): boolean {
    return this.s !== null;
  }

  /** Opens the mic and a Live session about this step. Does nothing while one is open. */
  async start(ask: CoachAsk) {
    if (this.s) return;
    const s: Session = {
      ws: null, mic: null, attempt: ladder, ready: false, reply: "text", sending: false, heard: "", answer: "", unsaid: "",
      lines: [], talking: false, turnDone: false, leaving: false, talk: 0, quiet: 0, floor: 0, timer: 0, cap: 0,
    };
    this.s = s;
    if ("speechSynthesis" in window) speechSynthesis.cancel(); // the device stops talking so it can listen
    this.set("starting");
    s.cap = window.setTimeout(() => this.s === s && this.stop(), SESSION_MS);
    const token = mint(ask, ladder); // while the mic opens
    token.catch(() => {}); // a mic that fails first says so instead
    try {
      const mic = await openMic((pcm, rms) => this.audio(s, pcm, rms));
      if (this.s !== s) return mic.close(); // stopped while the mic was opening
      s.mic = mic;
      await this.connect(s, ask, token);
    } catch (e) {
      if (this.s === s) this.fail(String((e as Error)?.message ?? e));
    }
  }

  /** Ends the session: closes the socket, releases the mic, stops the device talking. Safe to call any time. */
  stop() {
    const s = this.s;
    if (!s) return;
    this.s = null;
    clearTimeout(s.timer);
    clearTimeout(s.cap);
    if (s.ws) {
      s.ws.onclose = s.ws.onmessage = null;
      s.ws.close(1000);
    }
    s.mic?.close();
    if (s.talking && "speechSynthesis" in window) speechSynthesis.cancel();
    this.level = 0;
    this.set("idle");
    this.on.end?.();
  }

  private fail(message: string) {
    this.stop();
    this.on.error?.(message);
  }

  private set(state: CoachState) {
    if (state === this.state) return;
    this.state = state;
    this.on.state?.(state);
  }

  /** The socket, with this attempt's token; a model that refuses the setup hands over to the next attempt. */
  private async connect(s: Session, ask: CoachAsk, token: Promise<Token>) {
    const t = await token;
    if (this.s !== s) return;
    s.attempt = t.attempt;
    s.ready = false;
    s.reply = t.reply === "audio" ? "audio" : "text";
    const ws = new WebSocket(`${LIVE}?access_token=${t.token}`);
    ws.binaryType = "arraybuffer";
    s.ws = ws;
    ws.onopen = () => {
      // the token fixes the model and every setting; this just names them, as the SDK does
      const model = t.model.startsWith("models/") ? t.model : `models/${t.model}`;
      ws.send(JSON.stringify({ setup: { model, generationConfig: { responseModalities: [s.reply.toUpperCase()] } } }));
    };
    ws.onmessage = (e) => this.s === s && this.message(s, e.data);
    ws.onclose = (e) => {
      if (this.s !== s || s.ws !== ws) return;
      s.ws = null;
      if (RETRY.test(e.reason) && t.attempt + 1 < t.attempts) {
        ladder = t.attempt + 1; // remembered for the next question too
        if (!s.ready) {
          this.set("starting");
          void this.connect(s, ask, mint(ask, ladder)).catch((err) => this.s === s && this.fail(String(err?.message ?? err)));
          return;
        }
      }
      if (this.state === "answering") {
        // the socket went while the device is still reading what it sent: finish the answer, then end
        s.leaving = true;
        if (s.turnDone) this.answered(s);
        else this.finishTurn(s);
        return;
      }
      if (e.code === 1000 && s.ready) return this.stop(); // the session ran its course
      this.fail(closed(e));
    };
  }

  private message(s: Session, data: unknown) {
    let m: LiveMessage;
    try {
      m = JSON.parse(typeof data === "string" ? data : new TextDecoder().decode(data as ArrayBuffer));
    } catch {
      return;
    }
    if (m.setupComplete && !s.ready) {
      s.ready = true;
      ladder = s.attempt;
      this.listen(s, FIRST_QUESTION_MS);
    }
    if (m.goAway) s.leaving = true;
    const c = m.serverContent;
    if (!c) return;
    const asked = c.inputTranscription?.text;
    if (asked) {
      // the transcript runs on its own clock: its last words can land just after the answer has begun
      if (!s.heard && this.state !== "answering") {
        s.answer = "";
        this.on.answer?.(""); // a new question: the last answer goes
      }
      s.heard += asked;
      this.on.heard?.(s.heard.trim());
      if (this.state === "listening") clearTimeout(s.timer); // they're asking
    }
    if (c.interrupted) {
      s.lines = [];
      s.unsaid = "";
      if (s.talking && "speechSynthesis" in window) speechSynthesis.cancel();
    }
    const words =
      s.reply === "text"
        ? (c.modelTurn?.parts ?? []).filter((p) => typeof p.text === "string" && !p.thought).map((p) => p.text).join("")
        : (c.outputTranscription?.text ?? ""); // a speaking model's own words; its audio is never played
    if (words) this.hear(s, words);
    if (c.turnComplete || (s.reply === "text" && c.generationComplete)) this.finishTurn(s);
  }

  /** The answer arriving: shown as it comes, each finished sentence read out right away. */
  private hear(s: Session, words: string) {
    if (this.state !== "answering") {
      clearTimeout(s.timer);
      s.answer = s.unsaid = "";
      s.turnDone = false;
      this.mute(s);
      this.set("answering");
    }
    s.answer += words;
    this.on.answer?.(s.answer.trim());
    s.unsaid += words;
    let cut = 0;
    for (const m of s.unsaid.matchAll(/[.!?…]+["')\]]*\s+/g)) cut = m.index! + m[0].length;
    if (cut) {
      this.say(s, s.unsaid.slice(0, cut));
      s.unsaid = s.unsaid.slice(cut);
    }
  }

  private finishTurn(s: Session) {
    if (this.state !== "answering" || s.turnDone) return;
    s.turnDone = true;
    this.say(s, s.unsaid);
    s.unsaid = "";
    this.answered(s);
  }

  /** Queues a sentence; they're said one after another, each started only once the last is done. */
  private say(s: Session, line: string) {
    if (line.trim()) s.lines.push(line.trim());
    if (!s.talking) this.sayLine(s);
  }

  private sayLine(s: Session) {
    const line = s.lines.shift();
    s.talking = line !== undefined;
    if (line === undefined) return this.answered(s);
    void sayNext(line).then(() => this.s === s && this.sayLine(s));
  }

  /** Once the whole answer has been said: listen for a follow-up (or close, when Gemini is leaving). */
  private answered(s: Session) {
    if (!s.turnDone || s.talking || s.lines.length || this.state !== "answering") return;
    if (s.leaving) return this.stop();
    s.heard = "";
    this.listen(s, FOLLOW_UP_MS);
  }

  private listen(s: Session, ms: number) {
    s.sending = true;
    s.talk = s.quiet = 0;
    this.set("listening");
    this.wait(s, ms, () => this.stop()); // nothing asked: done
  }

  private mute(s: Session) {
    if (!s.sending) return;
    s.sending = false;
    if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  private wait(s: Session, ms: number, then: () => void) {
    clearTimeout(s.timer);
    s.timer = window.setTimeout(() => this.s === s && then(), ms);
  }

  /** 100 ms of mic: a meter, a simple voice detector for "thinking", and (while listening) up to Gemini. */
  private audio(s: Session, pcm: ArrayBuffer, rms: number) {
    if (this.s !== s) return;
    this.level += (Math.min(1, rms * 8) - this.level) * 0.5;
    const loud = rms > Math.max(0.012, s.floor * 3);
    if (!loud) s.floor = s.floor ? s.floor * 0.95 + rms * 0.05 : rms;
    if (loud) {
      s.talk += 100;
      s.quiet = 0;
    } else s.quiet += 100;
    const asking = s.talk >= VOICE_MS;
    if (this.state === "listening") {
      if (asking) clearTimeout(s.timer);
      if (asking && s.quiet >= PAUSE_MS) {
        s.talk = 0;
        this.set("thinking");
        this.wait(s, ANSWER_MS, () => this.listen(s, FOLLOW_UP_MS));
      } else if (!asking && s.quiet >= PAUSE_MS) s.talk = 0;
    } else if (this.state === "thinking") {
      if (asking) {
        clearTimeout(s.timer);
        this.set("listening"); // still talking
      } else if (s.quiet >= PAUSE_MS) s.talk = 0;
    }
    if (!s.sending || !s.ready || s.ws?.readyState !== WebSocket.OPEN) return;
    s.ws.send(JSON.stringify({ realtimeInput: { audio: { data: base64(pcm), mimeType: `audio/pcm;rate=${RATE}` } } }));
  }
}

/** POST /api/live/token on the bridge: { token, model, reply, attempt, attempts }, or { error } in a sentence. */
interface Token {
  token: string;
  model: string;
  reply: "text" | "audio";
  attempt: number;
  attempts: number;
}

async function mint(ask: CoachAsk, attempt: number): Promise<Token> {
  const r = await fetch(TOKEN, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ...ask, attempt }),
  }).catch(() => null);
  if (!r) throw new Error("The coach can't reach the bridge on this Mac. Is the web app running?");
  const t = (await r.json().catch(() => ({}))) as Partial<Token> & { error?: string };
  if (!r.ok || !t.token || !t.model) throw new Error(t.error ?? "The coach isn't available right now. Ask again in a moment.");
  return { token: t.token, model: t.model, reply: t.reply === "audio" ? "audio" : "text", attempt: t.attempt ?? attempt, attempts: t.attempts ?? 1 };
}

/** The parts of a Live server message the coach reads (field names as in @google/genai's LiveServerMessage). */
interface LiveMessage {
  setupComplete?: object;
  goAway?: { timeLeft?: string };
  serverContent?: {
    modelTurn?: { parts?: { text?: string; thought?: boolean }[] };
    turnComplete?: boolean;
    generationComplete?: boolean;
    interrupted?: boolean;
    inputTranscription?: { text?: string };
    outputTranscription?: { text?: string };
  };
}

/** Why Gemini closed the session, in a sentence. */
function closed(e: CloseEvent): string {
  const r = e.reason ?? "";
  if (/quota|exhausted|rate limit|\b429\b/i.test(r)) return "Gemini's quota is used up for now. Ask again in a few minutes.";
  if (/token|expired|auth/i.test(r)) return "The coach's pass ran out. Ask again.";
  if (RETRY.test(r)) return "This Gemini Live model couldn't coach. Ask again to try another.";
  if (e.code === 1006 || !r) return "Lost the connection to Gemini. Ask again.";
  return `The coach stopped: ${r.length > 120 ? `${r.slice(0, 117)}...` : r}`;
}

function base64(buf: ArrayBuffer): string {
  const b = new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  return btoa(s);
}

// ---------------- the mic: 16 kHz, 16-bit PCM in 100 ms chunks ----------------

interface Mic {
  close(): void;
}

// Averages input samples down to 16 kHz (a no-op when the context already runs at 16 kHz) and posts 100 ms of
// 16-bit PCM at a time, with its loudness.
const WORKLET = `
class LucidMic extends AudioWorkletProcessor {
  constructor(o) {
    super();
    this.ratio = o.processorOptions.ratio;
    this.size = o.processorOptions.chunk;
    this.out = new Int16Array(this.size);
    this.n = 0; this.sq = 0; this.acc = 0; this.k = 0; this.pos = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      this.acc += ch[i]; this.k++; this.pos += 1;
      if (this.pos < this.ratio) continue;
      this.pos -= this.ratio;
      const v = Math.max(-1, Math.min(1, this.acc / this.k));
      this.acc = 0; this.k = 0;
      this.sq += v * v;
      this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;
      if (this.n === this.size) {
        this.port.postMessage({ pcm: this.out.buffer, rms: Math.sqrt(this.sq / this.size) }, [this.out.buffer]);
        this.out = new Int16Array(this.size); this.n = 0; this.sq = 0;
      }
    }
    return true;
  }
}
registerProcessor("lucid-mic", LucidMic);
`;
let workletUrl: string | null = null;

async function openMic(onChunk: (pcm: ArrayBuffer, rms: number) => void): Promise<Mic> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Ask needs the microphone, and the browser only shares it on https.");
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
  } catch (e) {
    const name = (e as DOMException)?.name;
    if (name === "NotAllowedError" || name === "SecurityError") throw new Error("Ask needs the microphone. Allow it for this page, then ask again.");
    if (name === "NotFoundError") throw new Error("There's no microphone on this device.");
    throw new Error("The microphone didn't start. Ask again.");
  }
  let ctx: AudioContext | null = null;
  try {
    // Chromium (the Quest's browser too) resamples the mic to 16 kHz itself; elsewhere the worklet averages down
    ctx = new AudioContext({ sampleRate: RATE });
    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(stream);
    } catch {
      void ctx.close();
      ctx = new AudioContext();
      source = ctx.createMediaStreamSource(stream);
    }
    workletUrl ??= URL.createObjectURL(new Blob([WORKLET], { type: "text/javascript" }));
    await ctx.audioWorklet.addModule(workletUrl);
    const node = new AudioWorkletNode(ctx, "lucid-mic", {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [1],
      processorOptions: { ratio: ctx.sampleRate / RATE, chunk: CHUNK },
    });
    node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => onChunk(e.data.pcm, e.data.rms);
    source.connect(node);
    node.connect(ctx.destination); // silent; keeps the graph pulling the mic
    if (ctx.state === "suspended") await ctx.resume().catch(() => {});
    const c = ctx;
    return {
      close() {
        node.port.onmessage = null;
        source.disconnect();
        node.disconnect();
        stream.getTracks().forEach((tr) => tr.stop());
        void c.close().catch(() => {});
      },
    };
  } catch {
    stream.getTracks().forEach((tr) => tr.stop());
    void ctx?.close().catch(() => {});
    throw new Error("The microphone didn't start. Ask again.");
  }
}
