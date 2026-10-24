// P34's bounds case for the room scenario, from court.json alone (never the order the splats finished loading in): the
// first extra in court.json, a 2 m room round its feet (it stays), and the same room 3 m along +x (it goes: its feet
// are 2 m beyond the nearest wall whatever stands near them).

const square = (x, z, r) => [[x - r, z - r], [x + r, z - r], [x + r, z + r], [x - r, z + r]];

/** { id, inside, beyond }: the extra's id and two court-space bounds polygons, or null with no extras. */
export function boundsCase(court) {
  const extra = court.freeze.others[0];
  if (!extra) return null;
  const [x, , z] = extra.foot;
  return { id: extra.id, inside: square(x, z, 1), beyond: square(x + 3, z, 1) };
}
