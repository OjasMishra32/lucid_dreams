// The demo (`?mode=court`, on unless `?demo=0`): the watch is one short clip on the big screen, looping until Step into
// the court, which replays it once into the ease, F and the hand-off (clock.ts loop); and nothing depends on the room's
// bounds: no edge fade, no walk back through the room, no bounded floor, no seat-distance gate, no stand-up jump, so
// the arena, its floor and the surround stay fully on wherever the head goes. `?demo=0` is the full show as before.
// DOM-free: under node (the tests) there is no URL, so the full show.

/** True for the demo (every court page unless `?demo=0`). */
export const demoMode: boolean = typeof location === "undefined" ? false : new URLSearchParams(location.search).get("demo") !== "0";
