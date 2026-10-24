// serve.mjs --dev's end of `?probe=headset` (headset.ts): POST /__court/headset appends each record, as one JSON line,
// to <dir>/<session>.jsonl. <dir> is serve.mjs's --headset-dir, else $COURT_DATA/qa/headset; the repo names no data
// folder. Plain JS beside serve.mjs. Stream C (`core`).
import { appendFileSync, existsSync, mkdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const HEADSET_PATH = "/__court/headset";
/** The largest record taken, bytes (one is a few KB). */
export const MAX_RECORD = 256 * 1024;
/** A session file stops growing here, bytes (about 6 hours of records). */
export const MAX_FILE = 64 * 1024 * 1024;
const SESSION = /^[A-Za-z0-9-]{1,48}$/;

/** The folder records go to: the flag's, else $COURT_DATA/qa/headset, else null (the endpoint then answers 503). */
export function headsetDir(flag, env = process.env) {
  if (flag) return resolve(flag);
  return env.COURT_DATA ? join(resolve(env.COURT_DATA), "qa", "headset") : null;
}

/**
 * Take one record: { status, file? }. Refuses a body over MAX_RECORD (413), anything but a JSON object with a
 * `session` id of letters, digits and dashes (400), no folder (503) and a full session file (507).
 */
export function takeRecord(dir, body, now = new Date()) {
  if (!dir) return { status: 503 };
  if (body.length > MAX_RECORD) return { status: 413 };
  let rec;
  try {
    rec = JSON.parse(body.toString("utf8"));
  } catch {
    return { status: 400 };
  }
  if (!rec || typeof rec !== "object" || Array.isArray(rec) || typeof rec.session !== "string" || !SESSION.test(rec.session)) return { status: 400 };
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = join(dir, `${rec.session}.jsonl`);
  if (existsSync(file) && statSync(file).size > MAX_FILE) return { status: 507 };
  appendFileSync(file, `${JSON.stringify({ ...rec, receivedAt: now.toISOString() })}\n`);
  return { status: 204, file };
}

/** The request handler serve.mjs hands POST /__court/headset to. */
export function headsetSink(req, res, dir) {
  const chunks = [];
  let size = 0;
  req.on("data", (c) => {
    size += c.length;
    if (size <= MAX_RECORD) chunks.push(c);
  });
  req.on("end", () => {
    let out;
    try {
      out = size > MAX_RECORD ? { status: 413 } : takeRecord(dir, Buffer.concat(chunks));
    } catch {
      out = { status: 500 };
    }
    res.statusCode = out.status;
    res.end();
  });
  req.on("error", () => res.destroy());
}
