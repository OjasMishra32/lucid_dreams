import { createHash } from "node:crypto";

// Talk with them, for the headset app at /xr/ (apps/webxr/src/talk.ts), served by the website itself so it works when
// no Mac is on: you speak, OpenAI hears it and writes the reply as the person, ElevenLabs speaks it in their cloned
// voice. The same people, rules and limits as apps/talk/server.mjs, with the keys and private notes in the host's
// environment (OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, ELEVENLABS_VOICE_ID_VISHAL, PERSONA_GRANDMA,
// PERSONA_VISHAL). The reply's audio comes back in the answer itself (a data: URL), since a serverless host can't keep
// it for a second request. Without the keys (the website on the Mac), this passes Talk through to the headset app's
// own server, which relays to apps/talk as before.
//   GET  /xr/talk/<who>/health          { ok, voice }
//   POST /xr/talk/<who>?session=<id>    the recording -> { heard, reply, english, audio, ms }
//   POST /xr/talk/<who>/reset           forget the conversation

export const runtime = "nodejs";
export const maxDuration = 30;

const env = process.env;
const XR = env.LUCID_XR ?? "http://localhost:5182";
const TRANSCRIBE = "whisper-1";
const WRITER = env.TALK_MODEL || "gpt-4o-mini";
const VOICE_MODEL = "eleven_flash_v2_5";
const RATE = 22050; // ElevenLabs pcm_22050: 16-bit mono, wrapped in a WAV header

const GRANDMA = `You are the voice of the user's grandmother, an elderly Vietnamese woman from the South, made from her own
recordings with her and her family's consent. The app labels you as an AI voice.
- Speak natural, warm Southern Vietnamese, the way she talks to her grandchild: call yourself "bà" (never "tao"),
  call the user "con". Short and spoken: one or two sentences, under 30 words, no lists, no emoji, nothing that
  can't be read aloud.
- Reply in Vietnamese even when the user speaks English, unless they ask for English.
- Never invent specific memories, names, places or events that are not in the notes below. If asked about something
  you don't know, answer warmly without making it up (ask them to tell bà about it).
- If asked whether you are real, say gently that you are an AI voice made from bà's recordings, with love.
- No medical, legal or money advice; just be loving, curious about their day, and encouraging.
Return JSON only: {"reply": "<what bà says, in Vietnamese>", "english": "<a natural English translation>"}.`;
const VISHAL = `You are an AI voice of Vishal, a University of Florida student and one of the four people who built Lucid
Dreams at Gator Hack, made from his own recordings with his permission. The app labels you as an AI voice. The user
is standing in a room with a life-size 3D Vishal (rebuilt from two phone videos) and talking to him.
- Speak like Vishal would to a friend or a judge at the demo: relaxed, upbeat, casual American English. Short and
  spoken: one or two sentences, under 35 words, no lists, no emoji, nothing that can't be read aloud.
- Never invent specific memories, people, grades, plans or events that are not in the notes below. If asked something
  you don't know, say so lightly and turn it back to them.
- You can talk about Lucid Dreams: one phone video or a few photos become a photoreal, life-size 3D person in Quest
  passthrough (4DAnyone's generated views, Gaussian splats, LHM++ avatars, Gemini lesson plans), from what the notes say.
- If asked whether you are real, say you're an AI voice of Vishal, made with his permission, and the body is a 3D
  reconstruction from his videos.
- No medical, legal or money advice.
Return JSON only: {"reply": "<what Vishal says>", "english": "<the same sentence>"}.`;

type Person = { rules: string; notes: string; voice?: string; language: string; hint: string; fix: (t: string) => string };
const PEOPLE: Record<string, Person> = {
  grandma: { rules: GRANDMA, notes: env.PERSONA_GRANDMA ?? "", voice: env.ELEVENLABS_VOICE_ID, language: "vi", hint: "Con chào bà. Hello grandma.", fix: (t) => t.replace(/\b[Tt]ao\b/g, (m) => (m[0] === "T" ? "Bà" : "bà")) },
  vishal: { rules: VISHAL, notes: env.PERSONA_VISHAL ?? "", voice: env.ELEVENLABS_VOICE_ID_VISHAL, language: "en", hint: "Hey Vishal, what's up?", fix: (t) => t },
};

// Limits, as on the Mac: every turn spends credits and anyone with the link can talk. Kept per server instance.
const setting = (k: string, d: number) => Number(env[k] ?? d);
const PER_VISITOR_HOUR = setting("TALK_PER_VISITOR_HOUR", 20);
const PER_DAY = setting("TALK_PER_DAY", 300);
const MAX_SECONDS = setting("TALK_MAX_SECONDS", 20);
const MAX_REPLY_CHARS = 320;
const RESTING = "Talk is resting, try again in a few minutes.";
const turns = new Map<string, number[]>();
const busy = new Set<string>();
const sessions = new Map<string, { role: string; content: string }[]>();
let today = { date: "", count: 0 };

const json = (code: number, data: unknown, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(data), { status: code, headers: { "Content-Type": "application/json", "Cache-Control": "no-store", ...extra } });
const visitorOf = (req: Request) =>
  (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || req.headers.get("x-real-ip") || "?";
const tagOf = (v: string) => createHash("sha256").update(v).digest("hex").slice(0, 8);

function admit(visitor: string): { error: string; retryAfter: number } | null {
  const now = Date.now();
  const date = new Date().toDateString();
  if (today.date !== date) today = { date, count: 0 };
  if (today.count >= PER_DAY) return { error: "Talk is resting for today. Try again tomorrow.", retryAfter: 3600 };
  const recent = (turns.get(visitor) ?? []).filter((t) => now - t < 3600e3);
  if (recent.length >= PER_VISITOR_HOUR) {
    turns.set(visitor, recent);
    return { error: RESTING, retryAfter: Math.ceil((recent[0] + 3600e3 - now) / 1000) };
  }
  if (busy.has(visitor)) return { error: "One at a time: wait for the reply, then talk again.", retryAfter: 5 };
  turns.set(visitor, [...recent, now]);
  today.count++;
  busy.add(visitor);
  return null;
}

/** How long a recording is: exact for WAV (the Quest app), from its size for a browser's compressed audio. */
function seconds(audio: Buffer, type: string): number {
  if (type.includes("wav") && audio.length > 44 && audio.toString("ascii", 0, 4) === "RIFF") {
    let byteRate = 0;
    for (let i = 12; i + 8 <= audio.length; ) {
      const id = audio.toString("ascii", i, i + 4);
      const size = audio.readUInt32LE(i + 4);
      if (id === "fmt ") byteRate = audio.readUInt32LE(i + 16);
      if (id === "data") return byteRate ? Math.min(size, audio.length - i - 8) / byteRate : 0;
      i += 8 + size + (size % 2);
    }
    return 0;
  }
  return audio.length / 32000;
}

function wav(pcm: Buffer): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(RATE, 24);
  h.writeUInt32LE(RATE * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function transcribe(audio: Buffer, type: string, person: Person): Promise<string> {
  const ext = type.includes("wav") ? "wav" : type.includes("mp4") || type.includes("m4a") ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(audio)], { type }), `speech.${ext}`);
  form.append("model", TRANSCRIBE);
  form.append("prompt", person.hint);
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (((await r.json()) as { text?: string }).text ?? "").trim();
}

async function write(person: Person, history: { role: string; content: string }[], said: string) {
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: WRITER,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: person.rules + (person.notes ? `\n\nNotes (true, from the person or their family):\n${person.notes}` : "") },
        ...history,
        { role: "user", content: said },
      ],
    }),
  });
  if (!r.ok) throw new Error(`reply ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const out = JSON.parse(((await r.json()) as { choices: { message: { content: string } }[] }).choices[0].message.content);
  const reply = person.fix(String(out.reply ?? "")).trim();
  return { reply, english: String(out.english ?? reply).trim() };
}

async function speak(person: Person, text: string): Promise<Buffer> {
  const r = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${person.voice}?output_format=pcm_${RATE}`, {
    method: "POST",
    headers: { "xi-api-key": env.ELEVENLABS_API_KEY ?? "", "Content-Type": "application/json" },
    body: JSON.stringify({ text: text.slice(0, MAX_REPLY_CHARS), model_id: VOICE_MODEL, language_code: person.language }),
  });
  if (!r.ok) throw new Error(`voice ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return wav(Buffer.from(await r.arrayBuffer()));
}

/** No keys here: hand the request to the headset app's own server, as the /xr/ rewrite would. */
async function passThrough(req: Request, path: string[]): Promise<Response> {
  const url = new URL(req.url);
  try {
    const r = await fetch(`${XR}/xr/talk/${path.map(encodeURIComponent).join("/")}${url.search}`, {
      method: req.method,
      headers: { "Content-Type": req.headers.get("content-type") ?? "application/octet-stream", "x-forwarded-for": visitorOf(req) },
      body: req.method === "POST" ? Buffer.from(await req.arrayBuffer()) : undefined,
    });
    return new Response(r.body, { status: r.status, headers: { "Content-Type": r.headers.get("content-type") ?? "application/json", "Cache-Control": "no-store" } });
  } catch {
    return json(502, { error: "the Talk server isn't answering" });
  }
}

const here = () => !!(env.OPENAI_API_KEY && env.ELEVENLABS_API_KEY);

export async function GET(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!here()) return passThrough(req, path);
  const person = PEOPLE[path[0]?.toLowerCase() ?? ""];
  if (path.length === 2 && path[1] === "health") return json(200, { ok: !!person, voice: !!person?.voice });
  return json(404, { error: "not found" });
}

export async function POST(req: Request, ctx: { params: Promise<{ path: string[] }> }) {
  const { path } = await ctx.params;
  if (!here()) return passThrough(req, path);
  const who = path[0]?.toLowerCase() ?? "";
  const person = PEOPLE[who];
  if (!person) return json(404, { error: "nobody to talk to by that name here" });
  const url = new URL(req.url);
  const session = `${who}:${(url.searchParams.get("session") ?? "default").slice(0, 64)}`;
  if (path[1] === "reset") {
    sessions.delete(session);
    return json(200, { ok: true });
  }
  if (path.length !== 1) return json(404, { error: "not found" });

  const t0 = Date.now();
  const ms: Record<string, number> = {};
  const visitor = visitorOf(req);
  const tag = tagOf(visitor);
  let admitted = false;
  try {
    const type = req.headers.get("content-type") ?? "audio/wav";
    const audio = Buffer.from(await req.arrayBuffer());
    if (audio.length > 6 * 1024 * 1024) return json(413, { error: `That was too long: keep it under ${MAX_SECONDS} seconds.` });
    const length = seconds(audio, type);
    if (length > MAX_SECONDS * 1.25) return json(413, { error: `That was too long: keep it under ${MAX_SECONDS} seconds.` });
    if (length < 0.3) return json(200, { heard: "", reply: "", english: "", audio: null, ms });
    const no = admit(visitor);
    if (no) return json(429, { error: no.error, resting: true, retryAfter: no.retryAfter }, { "Retry-After": String(no.retryAfter) });
    admitted = true;
    const said = await transcribe(audio, type, person);
    ms.heard = Date.now() - t0;
    if (!said) return json(200, { heard: "", reply: "", english: "", audio: null, ms });
    const history = sessions.get(session) ?? [];
    const { reply, english } = await write(person, history, said);
    ms.wrote = Date.now() - t0;
    // no cloned voice: the words alone, never someone else's voice
    const wavBytes = person.voice ? await speak(person, reply) : null;
    ms.spoke = Date.now() - t0;
    sessions.set(session, [...history, { role: "user", content: said }, { role: "assistant", content: JSON.stringify({ reply, english }) }].slice(-12));
    console.log(`[talk] ${who} ${tag} ${ms.spoke} ms (heard ${ms.heard}, wrote ${ms.wrote - ms.heard}, spoke ${ms.spoke - ms.wrote})`);
    return json(200, { heard: said, reply, english, audio: wavBytes ? `data:audio/wav;base64,${wavBytes.toString("base64")}` : null, ms });
  } catch (e) {
    console.error(`[talk] ${who} ${tag} failed:`, (e as Error).message);
    return json(502, { error: (e as Error).message, ms });
  } finally {
    if (admitted) busy.delete(visitor);
  }
}
