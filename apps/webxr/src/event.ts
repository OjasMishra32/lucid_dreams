// Competition mode (?event=meta, for Meta's VR Start competition): everything the app has, opened the way a judge
// should meet it. The front door is Vishal standing in your room (Talk, Reality check, then Play chess from his palm
// menu), the library is ?library, chess plays a 5 + 0 game and keeps your record against each opponent, and the headset
// asks for 72 Hz. The flag is remembered for the tab's session (sessionStorage), so every link inside the app keeps it;
// ?event=off ends it. Nothing changes without it. A build made with VITE_EVENT=meta is always in it.

const KEY = "lucid.event";
const BUILT = (import.meta.env?.VITE_EVENT as string | undefined) || null;

function read(): string | null {
  if (BUILT) return BUILT;
  const asked = new URLSearchParams(typeof location === "undefined" ? "" : location.search).get("event");
  try {
    if (asked === "off" || asked === "") sessionStorage.removeItem(KEY);
    else if (asked) sessionStorage.setItem(KEY, asked);
    return asked === "off" || asked === "" ? null : (asked ?? sessionStorage.getItem(KEY));
  } catch {
    // no storage (a private window, blocked site data): the flag lasts as long as it's in the URL
    return asked === "off" || asked === "" ? null : asked;
  }
}

export const EVENT = read();
export const META = EVENT === "meta";

/** Whether a bundle may be shown: every public one, in the competition too. */
export function showable(_id: string): boolean {
  return true;
}

/** Where "back to the dreams" goes: the library (in the competition the app's own front door is Vishal). */
export const LIBRARY = META ? "./?library" : "./";
