// Clone a consenting person's voice for Talk with them (ElevenLabs instant voice cloning) and save its id in .env.
//   node apps/talk/clone-voice.mjs <recording.m4a|.wav|.mp3> [--who vishal]
// The recording: a minute or two of them talking naturally, one voice, no music. Only people who agreed to their voice
// being cloned (AGENTS.md rule 5: Vishal on his own word; Ian's grandma through her family). Keys stay in .env, never
// printed. Writes ELEVENLABS_VOICE_ID_<WHO> (grandma's is ELEVENLABS_VOICE_ID, left alone), then restart server.mjs.
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { basename, extname, join } from "node:path";

const HERE = import.meta.dirname;
const CONSENTED = { vishal: "Vishal (Lucid Dreams)" };
const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith("--"));
const who = (args[args.indexOf("--who") + 1] && args.includes("--who") ? args[args.indexOf("--who") + 1] : "vishal").toLowerCase();
if (!file || !existsSync(file)) {
  console.error("usage: node apps/talk/clone-voice.mjs <recording> [--who vishal]");
  process.exit(1);
}
if (!CONSENTED[who]) {
  console.error(`${who} hasn't agreed to a cloned voice here`);
  process.exit(1);
}
const envPath = join(HERE, ".env");
const envText = readFileSync(envPath, "utf8");
const key = envText.match(/^ELEVENLABS_API_KEY=(.*)$/m)?.[1]?.trim();
if (!key) {
  console.error("no ELEVENLABS_API_KEY in apps/talk/.env");
  process.exit(1);
}
const type = { ".m4a": "audio/mp4", ".mp4": "audio/mp4", ".wav": "audio/wav", ".mp3": "audio/mpeg", ".aac": "audio/aac" }[extname(file).toLowerCase()] ?? "application/octet-stream";
const form = new FormData();
form.append("name", CONSENTED[who]);
form.append("description", "Cloned with his consent for Lucid Dreams (Gator Hack V). Every use is labelled AI voice.");
form.append("remove_background_noise", "true");
form.append("files", new Blob([readFileSync(file)], { type }), basename(file));
const r = await fetch("https://api.elevenlabs.io/v1/voices/add", { method: "POST", headers: { "xi-api-key": key }, body: form });
if (!r.ok) {
  console.error(`ElevenLabs ${r.status}: ${(await r.text()).slice(0, 300)}`);
  process.exit(1);
}
const { voice_id: id } = await r.json();
const name = `ELEVENLABS_VOICE_ID_${who.toUpperCase()}`;
const next = new RegExp(`^${name}=.*$`, "m").test(envText) ? envText.replace(new RegExp(`^${name}=.*$`, "m"), `${name}=${id}`) : `${envText.replace(/\n*$/, "\n")}${name}=${id}\n`;
writeFileSync(envPath, next);
console.log(`VOICE_OK: ${who}'s cloned voice saved as ${name} in apps/talk/.env (restart server.mjs)`);
