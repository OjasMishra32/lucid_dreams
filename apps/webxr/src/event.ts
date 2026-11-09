// Competition mode (?event=meta, for Meta's VR Start competition): its rules allow no identifiable person but the
// entrants (Ojasva, Vishal, Ian), so the app shows only their own bundles. The flag is remembered for the tab's session
// (sessionStorage), so every link inside the app keeps it; ?event=off ends it. Nothing changes without it. A build made
// with VITE_EVENT=meta (a deploy for the judges) is always in it, whatever the URL says.

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

/** An entrant's own bundle: Vishal's avatar, anything of Ojasva's or Ian's (never Ian's grandma: not an entrant). */
export function isEntrant(id: string): boolean {
  return id === "vishal" || id.startsWith("ojasva") || (id.startsWith("ian-") && !id.startsWith("ian-grandma"));
}

/** Whether a bundle may be shown: always, outside the event. */
export function showable(id: string): boolean {
  return !META || isEntrant(id);
}

/** Where "back to the dreams" goes: the library (in the competition the app's own front door is the chess table). */
export const LIBRARY = META ? "./?library" : "./";
