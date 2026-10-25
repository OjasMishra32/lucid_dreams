import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { CASES_FILE, MODES, compare, fromExperience, fromRaw, loadCases, type IntentCase } from "../tests/intents";

// The intent box against Gemma: each of the forty sentences in tests/intents.json goes through the bridge's own
// writeExperience (lib/bridge/gemini.ts) as a sentence-only plan, and anything that doesn't come out as expected is
// reported. Without GEMINI_API_KEY it checks the file and says so.
//
//   npm run test:intents                  all forty (uses the newest listed gemma-...-it unless GEMINI_MODEL is set)
//   npm run test:intents -- play          one mode (teach, companion, watch, play)
//   npm run test:intents -- jump-shot     any case whose id contains the words

const DURATION_S = 121 / 25; // the pipeline's 5-second window
const FATAL = /API_KEY_INVALID|API key not valid|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|NOT_FOUND|\b404\b/i;
const TRANSIENT = /RESOURCE_EXHAUSTED|\b429\b|quota|\b500\b|\b503\b|UNAVAILABLE|ETIMEDOUT|timeout|timed out|AbortError|fetch failed/i;

type Stored = {
  id: string;
  sentence: string;
  expected: IntentCase["expect"];
  status: "pass" | "miss" | "error";
  model?: string;
  latencyMs: number;
  attempts: number;
  modelMisses?: string[];
  misses?: string[];
  error?: string;
  completedAt: string;
};
type Checkpoint = { version: 1; model: string; results: Record<string, Stored> };

function checkpoint(path: string, model: string): Checkpoint {
  try {
    const saved = JSON.parse(readFileSync(path, "utf8")) as Checkpoint;
    if (saved?.version === 1 && saved.model === model && saved.results && typeof saved.results === "object") return saved;
  } catch {
    // A first run has no saved checkpoint; an unreadable file is replaced only after the first completed case.
  }
  return { version: 1, model, results: {} };
}

/** Atomic writes let an interrupted terminal resume completed cases without re-spending their requests. */
function saveCheckpoint(path: string, value: Checkpoint) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(value, null, 2) + "\n");
  renameSync(temporary, path);
}

function retryAfterMs(error: unknown, attempt: number): number {
  const headers = (error as { response?: { headers?: Headers | Record<string, string | undefined> } })?.response?.headers;
  const value = headers instanceof Headers ? headers.get("retry-after") : headers?.["retry-after"];
  if (value) {
    const seconds = Number(value);
    if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 120_000);
    const at = Date.parse(value);
    if (Number.isFinite(at)) return Math.min(Math.max(at - Date.now(), 0), 120_000);
  }
  return Math.min(2_000 * 2 ** (attempt - 1), 30_000);
}

async function main() {
  const env = join(__dirname, "..", ".env.local");
  if (existsSync(env)) process.loadEnvFile(env); // like Next: the environment wins over the file

  const file = relative(process.cwd(), CASES_FILE) || CASES_FILE;
  let cases: IntentCase[];
  try {
    cases = loadCases();
  } catch (e) {
    console.error((e as Error).message);
    return 1;
  }
  const count = (m: string) => cases.filter((c) => c.expect.mode === m).length;
  console.log(`${file}: ${cases.length} sentences (${MODES.map((m) => `${count(m)} ${m}`).join(", ")}), all well-formed.`);

  const cli = process.argv.slice(2);
  const resultAt = cli.indexOf("--results");
  const resultPath = resultAt >= 0 ? cli[resultAt + 1] : (process.env.GEMMA_QA_RESULTS ?? "/private/tmp/lucid-gemma-intents.json");
  if (!resultPath || resultAt >= 0 && !cli[resultAt + 1]) {
    console.error("--results needs a path outside the repository.");
    return 1;
  }
  const args = cli.filter((_, i) => i !== resultAt && i !== resultAt + 1).map((a) => a.toLowerCase());
  const modes = args.filter((a) => (MODES as string[]).includes(a));
  const words = args.filter((a) => !(MODES as string[]).includes(a));
  const chosen = cases.filter((c) => (!modes.length || modes.includes(c.expect.mode)) && words.every((w) => c.id.includes(w)));
  if (!chosen.length) {
    console.error(`No sentence matches ${args.join(" ")}.`);
    return 1;
  }

  if (!process.env.GEMINI_API_KEY && !process.env.GEMMA_MODEL) {
    console.log(
      "A planner wasn't asked: set GEMMA_MODEL for local Ollama Gemma, or GEMINI_API_KEY for the bridge Gemini path.",
    );
    return 0;
  }

  const model = process.env.GEMINI_MODEL ?? "auto";
  const saved = checkpoint(resultPath, model);
  const { writeExperience, humanError } = await import("../lib/bridge/gemini");
  console.log(`Asking Gemma for ${chosen.length} sentence-only plan${chosen.length === 1 ? "" : "s"}, one at a time. Checkpoint: ${resultPath}\n`);
  let right = 0;
  let modelRight = 0;
  const models = new Set<string>();
  const wrong: string[] = [];
  for (const c of chosen) {
    const prior = saved.results[c.id];
    if (prior && prior.status !== "error") {
      const ok = prior.status === "pass";
      if (ok) right++;
      if (!prior.modelMisses?.length) modelRight++;
      if (prior.model) models.add(prior.model);
      if (!ok) wrong.push(c.id);
      console.log(`  ${ok ? "ok" : prior.status.toUpperCase().padEnd(4)}  ${c.expect.mode.padEnd(9)} ${c.sentence}   (resumed)`);
      continue;
    }
    if (prior) console.log(`  retry ${c.expect.mode.padEnd(9)} ${c.sentence}   (previous provider error)`);
    let raw: Record<string, unknown> = {};
    let result: Awaited<ReturnType<typeof writeExperience>> | null = null;
    let error = "";
    let attempts = 0;
    const started = Date.now();
    for (let attempt = 1; attempt <= 2 && !result; attempt++) {
      attempts = attempt;
      try {
        result = await writeExperience(
          { name: c.name, intent: c.sentence, kind: c.kind, durationS: DURATION_S, intentOnly: true },
          { raw: (r) => (raw = r) },
        );
      } catch (e) {
        const msg = String((e as Error)?.message ?? e);
        if (FATAL.test(msg)) {
          console.error(`  Stopped: ${humanError(e)}`);
          return 1;
        }
        error = humanError(e);
        if (!TRANSIENT.test(msg) || attempt === 2) break;
        const wait = retryAfterMs(e, attempt);
        console.log(`        (transient provider error: waiting ${(wait / 1000).toFixed(0)} s before retry ${attempt + 1}/2)`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    const label = `${c.expect.mode.padEnd(9)} ${c.sentence}`;
    if (!result) {
      console.log(`  FAIL  ${label}\n        ${error}`);
      wrong.push(c.id);
      saved.results[c.id] = { id: c.id, sentence: c.sentence, expected: c.expect, status: "error", latencyMs: Date.now() - started, attempts, error, completedAt: new Date().toISOString() };
      saveCheckpoint(resultPath, saved);
      continue;
    }
    if (result.model) models.add(result.model);
    const misses = compare(c.expect, fromExperience(result));
    const modelMisses = compare(c.expect, fromRaw(raw));
    if (!modelMisses.length) modelRight++;
    const status: Stored["status"] = misses.length ? "miss" : "pass";
    saved.results[c.id] = {
      id: c.id, sentence: c.sentence, expected: c.expect, status, model: result.model,
      latencyMs: Date.now() - started, attempts, modelMisses, misses, completedAt: new Date().toISOString(),
    };
    saveCheckpoint(resultPath, saved);
    if (!misses.length) {
      right++;
      console.log(`  ok    ${label}${modelMisses.length ? `   (rules fixed: ${modelMisses.map((m) => m.split(":")[0]).join(", ")})` : ""}`);
    } else {
      wrong.push(c.id);
      console.log(`  MISS  ${label}`);
      for (const m of misses) console.log(`        ${m}`);
    }
  }

  console.log(
    `\n${right} of ${chosen.length} right after clean(); the model alone had ${modelRight}.` +
      (models.size ? ` Model: ${[...models].join(", ")}.` : ""),
  );
  if (wrong.length) console.log(`Not right: ${wrong.join(", ")}.`);
  return wrong.length ? 1 : 0;
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(e);
    process.exit(1);
  },
);
