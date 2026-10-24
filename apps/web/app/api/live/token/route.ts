import { GEMINI_ON } from "@/lib/bridge/experience";
import { CORS, json, preflight } from "@/lib/bridge/http";
import { allow, coachError, mintToken, readContext } from "@/lib/bridge/live";

// The coach in the lesson (Gemini Live): the WebXR viewer asks here (through its own server, same origin) for a
// short-lived, single-use token, then talks to Gemini directly. The key never leaves this Mac.

export const dynamic = "force-dynamic"; // on or off is the running bridge's answer, never baked in at build time

/** GET /api/live/token -> { state: "on" | "off" }: whether the viewer should offer Ask at all. */
export async function GET() {
  return json({ state: GEMINI_ON ? "on" : "off" });
}

/**
 * POST /api/live/token, JSON { dream?, index, count, title, tip?, start, end, speed?, at?, plan?: { title?, intent? },
 * attempt? } -> 201 { token, model, reply: "text" | "audio", attempt, attempts, expiresAt }, or { error } in a sentence.
 */
export async function POST(req: Request) {
  if (!GEMINI_ON) return json({ state: "off", error: "The coach is off: this Mac has no Gemini key." }, 503);
  // the viewer's server forwards the headset's address; on the same Mac it's just this machine
  const who = (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "local";
  const gate = allow(who);
  if (!gate.ok)
    return Response.json(
      { error: "That's a lot of questions at once. Ask again in a moment." },
      { status: 429, headers: { ...CORS, "Cache-Control": "no-store", "Retry-After": String(gate.retryS) } },
    );
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const ctx = readContext(body);
  if (!ctx) return json({ error: "Say which lesson step the question is about." }, 400);
  const attempt = typeof body?.attempt === "number" && Number.isInteger(body.attempt) ? body.attempt : 0;
  try {
    return json(await mintToken(ctx, attempt), 201);
  } catch (e) {
    const message = coachError(e);
    console.error(`[live] token: ${message}`, String((e as Error)?.message ?? e).slice(0, 300));
    return json({ error: message }, 502);
  }
}

export const OPTIONS = preflight;
