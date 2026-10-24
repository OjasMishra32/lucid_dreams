import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { CASES_FILE, MODES, compare, fromExperience, fromRaw, loadCases, type IntentCase } from "../tests/intents";

// The intent box against Gemini: each of the forty sentences in tests/intents.json goes through the bridge's own
// writeExperience (lib/bridge/gemini.ts) as a sentence-only plan, and anything that doesn't come out as expected is
// reported. Without GEMINI_API_KEY it checks the file and says so.
//
//   npm run test:intents                  all forty
//   npm run test:intents -- play          one mode (teach, companion, watch, play)
//   npm run test:intents -- jump-shot     any case whose id contains the words

const DURATION_S = 121 / 25; // the pipeline's 5-second window
const FATAL = /API_KEY_INVALID|API key not valid|UNAUTHENTICATED|PERMISSION_DENIED|\b40[13]\b|NOT_FOUND|\b404\b/i;
const QUOTA = /RESOURCE_EXHAUSTED|\b429\b|quota/i;

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

  const args = process.argv.slice(2).map((a) => a.toLowerCase());
  const modes = args.filter((a) => (MODES as string[]).includes(a));
  const words = args.filter((a) => !(MODES as string[]).includes(a));
  const chosen = cases.filter((c) => (!modes.length || modes.includes(c.expect.mode)) && words.every((w) => c.id.includes(w)));
  if (!chosen.length) {
    console.error(`No sentence matches ${args.join(" ")}.`);
    return 1;
  }

  if (!process.env.GEMINI_API_KEY) {
    console.log(
      "Gemini wasn't asked: this needs GEMINI_API_KEY (from https://aistudio.google.com/apikey) in apps/web/.env.local " +
        "or the environment. With it, every sentence is planned and checked.",
    );
    return 0;
  }

  const { writeExperience, humanError } = await import("../lib/bridge/gemini");
  console.log(`Asking Gemini for ${chosen.length} sentence-only plan${chosen.length === 1 ? "" : "s"}, one at a time.\n`);
  let right = 0;
  let modelRight = 0;
  const models = new Set<string>();
  const wrong: string[] = [];
  for (const c of chosen) {
    let raw: Record<string, unknown> = {};
    let result: Awaited<ReturnType<typeof writeExperience>> | null = null;
    let error = "";
    for (let attempt = 1; attempt <= 4 && !result; attempt++) {
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
        if (!QUOTA.test(msg) || attempt === 4) break;
        console.log(`        (quota: waiting ${30 * attempt} s)`);
        await new Promise((r) => setTimeout(r, 30_000 * attempt));
      }
    }
    const label = `${c.expect.mode.padEnd(9)} ${c.sentence}`;
    if (!result) {
      console.log(`  FAIL  ${label}\n        ${error}`);
      wrong.push(c.id);
      continue;
    }
    if (result.model) models.add(result.model);
    const misses = compare(c.expect, fromExperience(result));
    const modelMisses = compare(c.expect, fromRaw(raw));
    if (!modelMisses.length) modelRight++;
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
