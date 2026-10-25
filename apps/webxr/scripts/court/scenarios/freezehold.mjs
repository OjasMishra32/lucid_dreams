// Stream D's asks of court.ts (the Codex review of court-d): the textures follow the clock's frame every display frame
// in the hand-off, the open world, the walk and the walk back too, not only while the show plays (a held F still goes up
// once it decodes, and See my room's jump to F mid-ease can't leave a pre-F frame on the video or the proxies), and a
// head rise that rushes the hand-off's fade never rushes the light (handoff's lightT, P44): the light keeps its own time
// from F through the end of its beat, past the open world's start. Owner: the integrator.
export const owner = "integrator";
export const needs = ["clock", "video", "proxies", "handoff", "light", "seat", "seatmath"];

const HZ = 72;
/** handoff.ts HANDOFF_END: the light's hand-off beat has landed by then (lightfield.ts). */
const HANDOFF_END = 5.0;
/** Up from the seated eye: over court.ts's RISE_FINISH (0.1 m), so the fade rushes. */
const RISE = 0.2;

export default async function freezehold(ctx) {
  const F = ctx.court.video.freezeSource;
  const src = (i) => ctx.showFrames[i]?.src;
  const toPass2 = async () => {
    let f = await ctx.nextFrame();
    while (f.segment !== "pass2") f = await ctx.nextFrame();
  };
  const list = (xs) => xs.slice(0, 4).map((x) => `n${x.n} ${x.phase} fed ${x.fed} clock ${x.frame} screen ${x.onScreen} (source ${src(x.onScreen)})`).join("; ");

  await ctx.seatHere();
  await ctx.handOver();
  await ctx.until("watching", HZ * 8);
  await toPass2();

  // the hand-off and the open world, untouched, then Walk closer and Back to my seat
  await ctx.press("step");
  await ctx.until("handoff", HZ * 30);
  const fade = await ctx.until("open", HZ * 8);
  const open = await ctx.frames(HZ);
  const walking = await ctx.pressFrames("closer", HZ);
  const back = await ctx.pressFrames("back", HZ / 2);
  const after = [...fade, ...open, ...walking, ...back].filter((x) => ["handoff", "open", "walking", "returning"].includes(x.phase));
  const phases = [...new Set(after.map((x) => x.phase))];
  ctx.check("D: the run reaches the hand-off, the open world, the walk and the walk back", phases.length === 4, phases.join(", "));
  const unfed = after.filter((x) => x.fed !== x.frame);
  ctx.check("D: every display frame after F hands the clock's frame to the video and the proxies", unfed.length === 0, unfed.length ? `${unfed.length}/${after.length} not: ${list(unfed)}` : `${after.length} frames`);
  const off = after.filter((x) => src(x.onScreen) !== F);
  ctx.check("D: F stays on screen from the hand-off on", off.length === 0, off.length ? `${off.length}/${after.length} not: ${list(off)}` : `${after.length} frames on F`);

  // Replay from the walk back: the watch again, with the cinema mask down (mask 0 is the watch's edge, 1 lifted)
  await ctx.press("replay");
  await ctx.until("watching", HZ * 4);
  const replayed = await ctx.snapshot();
  ctx.check("Replay: the watch with the cinema mask down", replayed.phase === "watching" && replayed.mask === 0, `${replayed.phase}, mask ${replayed.mask}`);

  // See my room mid-ease: the clock jumps to F, and the picture must follow it there
  await toPass2();
  await ctx.press("step");
  // in one page call (frames run freely): a few frames into the ease, See my room
  const [mid, jump] = await ctx.page.evaluate(async (n) => {
    await window.__court.until("easing", 72 * 30);
    const before = (await window.__court.frames(6)).at(-1);
    window.__court.press("room");
    return [before, await window.__court.frames(n)];
  }, Math.round(HZ / 2));
  ctx.check("D: mid-ease a frame before F is on screen (the jump's starting point)", mid.phase === "easing" && src(mid.onScreen) !== F, `${mid.phase}, source ${src(mid.onScreen)} on screen (F ${F})`);
  const landed = jump.slice(-6);
  ctx.check("D: See my room mid-ease lands the picture on F within 0.4 s", landed.every((x) => x.phase === "open" && src(x.onScreen) === F && x.fed === x.frame), list(landed));
  await ctx.pressFrames("room", HZ);

  // a head rise just after F rushes the fade; the light keeps the unrushed time from F, on past the open world's start
  await ctx.press("replay");
  await ctx.until("watching", HZ * 4);
  await toPass2();
  await ctx.press("step");
  const run = await ctx.page.evaluate(async ([rise, n]) => {
    const to = await window.__court.until("handoff", 72 * 30);
    const d = window.__xrDevice;
    d.position.set(d.position.x, d.position.y + rise, d.position.z);
    return [to.at(-1), ...(await window.__court.frames(n))];
  }, [RISE, Math.round((HANDOFF_END + 0.5) * HZ)]);
  const n0 = run[0].n; // the first hand-off frame: tF = 0
  const ahead = Math.max(...run.filter((x) => x.phase === "handoff").map((x) => x.tF - (x.n - n0) / HZ));
  ctx.check("P10: the rise rushes the fade (the hand-off's clock runs ahead)", ahead > 0.2, `${ahead.toFixed(3)} s ahead at most`);
  const lit = run.slice(1).filter((x) => x.lightBeat === "handoff" || x.lightBeat === "open");
  const slip = lit.map((x) => Math.abs(Math.min(HANDOFF_END, (x.n - n0) / HZ) - x.lightT));
  const worst = slip.length ? Math.max(...slip) : Infinity;
  ctx.check("P44: the light keeps the unrushed time from F through the rush", worst <= 1.5 / HZ, `${lit.length} frames, largest slip ${worst.toFixed(4)} s`);
  const last = run.at(-1);
  ctx.check("P44: the light's hand-off beat still lands (to HANDOFF_END) after the rushed fade opened the world", last.lightT >= HANDOFF_END - 1e-6 && run.some((x) => x.phase !== "handoff" && (x.n - n0) / HZ < HANDOFF_END - 0.2), `light ${last.lightBeat} ${last.lightT?.toFixed(3)} at ${((last.n - n0) / HZ).toFixed(3)} s, ${last.phase}`);
  ctx.report.frames = run.map(({ thumb, view, ...x }) => x);
}
