// Talk with someone you love: you speak, they answer in their own cloned voice. A small server on your Mac that holds
// the API keys (they never go into the Quest app), so the headset only sends what you said and plays what comes back.
//   1. OpenAI transcribes what you said (Vietnamese or English)
//   2. OpenAI writes the reply as the person, from persona.md (private notes about them) and the conversation so far,
//      in Vietnamese with an English line for the captions
//   3. ElevenLabs speaks it in their cloned voice (Flash v2.5, the fastest model that speaks Vietnamese)
// Every reply is AI: the players label it "AI voice", and it never claims memories it wasn't given.
//   node apps/talk/server.mjs        then open http://localhost:5175 on this Mac to try it (elsewhere: ?token=<TALK_TOKEN>)
// Needs apps/talk/.env (git-ignored): OPENAI_API_KEY, ELEVENLABS_API_KEY, ELEVENLABS_VOICE_ID, TALK_TOKEN.
import { createServer } from "node:http";
import { readFileSync, existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { join } from "node:path";

const HERE = import.meta.dirname;
const env = Object.fromEntries(
  (existsSync(join(HERE, ".env")) ? readFileSync(join(HERE, ".env"), "utf8") : "")
    .split("\n")
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1).trim()]),
);
const PORT = Number(process.env.TALK_PORT ?? 5175);
const TOKEN = env.TALK_TOKEN ?? "";
const TRANSCRIBE = "whisper-1";
const WRITER = env.TALK_MODEL || "gpt-4o-mini";
const VOICE_MODEL = "eleven_flash_v2_5";
const RATE = 22050; // ElevenLabs pcm_22050: 16-bit mono, wrapped in a WAV header so every player can read it
const missing = ["OPENAI_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID"].filter((k) => !env[k]);
if (missing.length) {
  console.error(`apps/talk/.env is missing ${missing.join(", ")}`);
  process.exit(1);
}

const persona = () => {
  const notes = join(HERE, "persona.md"); // private notes about them, git-ignored; edit any time, read on every turn
  if (!existsSync(notes)) return "";
  return readFileSync(notes, "utf8").split("\n").filter((l) => !l.trim().startsWith("#")).join("\n").trim(); // # lines are instructions
};
const RULES = `You are the voice of the user's grandmother, an elderly Vietnamese woman from the South, made from her own
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

const sessions = new Map(); // session id -> the last turns, so she remembers the conversation
const replies = new Map(); // reply id -> WAV bytes, kept for a few minutes

function wav(pcm) {
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

async function transcribe(audio, type) {
  const ext = type.includes("wav") ? "wav" : type.includes("mp4") || type.includes("m4a") ? "m4a" : "webm";
  const form = new FormData();
  form.append("file", new Blob([audio], { type }), `speech.${ext}`);
  form.append("model", TRANSCRIBE);
  form.append("prompt", "Con chào bà. Hello grandma."); // nudges it toward Vietnamese or English
  const r = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!r.ok) throw new Error(`transcription ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return ((await r.json()).text ?? "").trim();
}

async function write(history, said) {
  const notes = persona();
  const r = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENAI_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: WRITER,
      temperature: 0.7,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: RULES + (notes ? `\n\nNotes about bà (true, from the family):\n${notes}` : "") },
        ...history,
        { role: "user", content: said },
      ],
    }),
  });
  if (!r.ok) throw new Error(`reply ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const out = JSON.parse((await r.json()).choices[0].message.content);
  // she calls herself bà, whatever the model slipped into
  const reply = String(out.reply ?? "").replace(/\b[Tt]ao\b/g, (m) => (m[0] === "T" ? "Bà" : "bà")).trim();
  return { reply, english: String(out.english ?? "").trim() };
}

async function speak(text) {
  const r = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${env.ELEVENLABS_VOICE_ID}?output_format=pcm_${RATE}`,
    {
      method: "POST",
      headers: { "xi-api-key": env.ELEVENLABS_API_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ text, model_id: VOICE_MODEL, language_code: "vi" }),
    },
  );
  if (!r.ok) throw new Error(`voice ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return wav(Buffer.from(await r.arrayBuffer()));
}

const body = (req) =>
  new Promise((resolve, reject) => {
    const parts = [];
    let size = 0;
    req.on("data", (c) => {
      size += c.length;
      if (size > 10 * 1024 * 1024) reject(new Error("too long: keep it under a minute"));
      else parts.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(parts)));
    req.on("error", reject);
  });

const json = (res, code, data) => {
  res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" });
  res.end(JSON.stringify(data));
};

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://talk");
  if (req.method === "OPTIONS") {
    res.writeHead(204, { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "content-type, x-talk-token" });
    return res.end();
  }
  if (url.pathname === "/" && req.method === "GET") {
    // opened on this Mac itself: the page gets the token, so it just works; from anywhere else it needs ?token=
    const local = ["127.0.0.1", "::1", "::ffff:127.0.0.1"].includes(req.socket.remoteAddress);
    const page = readFileSync(join(HERE, "index.html"), "utf8").replace("__LOCAL_TOKEN__", local ? TOKEN : "");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(page);
  }
  // everything else needs the token: on a hackathon Wi-Fi anyone could otherwise spend the credits or hear her voice
  const token = url.searchParams.get("token") ?? req.headers["x-talk-token"];
  if (TOKEN && token !== TOKEN) return json(res, 401, { error: "wrong or missing token" });

  if (url.pathname === "/api/health") return json(res, 200, { ok: true, voice: VOICE_MODEL, writer: WRITER });

  const audio = url.pathname.match(/^\/api\/talk\/audio\/([\w-]+)\.wav$/);
  if (audio && req.method === "GET") {
    const wavBytes = replies.get(audio[1]);
    if (!wavBytes) return json(res, 404, { error: "that reply has expired" });
    res.writeHead(200, { "Content-Type": "audio/wav", "Content-Length": wavBytes.length, "Access-Control-Allow-Origin": "*" });
    return res.end(wavBytes);
  }

  if (url.pathname === "/api/talk" && req.method === "POST") {
    const t0 = Date.now();
    const ms = {};
    try {
      const session = (url.searchParams.get("session") ?? "default").slice(0, 64);
      const said = await transcribe(await body(req), req.headers["content-type"] ?? "audio/wav");
      ms.heard = Date.now() - t0;
      if (!said) return json(res, 200, { heard: "", reply: "", english: "", audio: null, ms });
      const history = sessions.get(session) ?? [];
      const { reply, english } = await write(history, said);
      ms.wrote = Date.now() - t0;
      const wavBytes = await speak(reply);
      ms.spoke = Date.now() - t0;
      const id = randomUUID();
      replies.set(id, wavBytes);
      setTimeout(() => replies.delete(id), 10 * 60 * 1000);
      sessions.set(session, [...history, { role: "user", content: said }, { role: "assistant", content: JSON.stringify({ reply, english }) }].slice(-12));
      console.log(`[talk] ${ms.spoke} ms (heard ${ms.heard}, wrote ${ms.wrote - ms.heard}, spoke ${ms.spoke - ms.wrote})`);
      return json(res, 200, { heard: said, reply, english, audio: `/api/talk/audio/${id}.wav`, ms });
    } catch (e) {
      console.error("[talk]", e.message);
      return json(res, 502, { error: e.message, ms });
    }
  }

  if (url.pathname === "/api/talk/reset" && req.method === "POST") {
    sessions.delete((url.searchParams.get("session") ?? "default").slice(0, 64));
    return json(res, 200, { ok: true });
  }
  json(res, 404, { error: "not found" });
});

server.listen(PORT, "0.0.0.0", () => console.log(`Talk server on :${PORT} (${TOKEN ? "token required" : "NO TOKEN SET"})`));
