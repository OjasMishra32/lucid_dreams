"use client";

import { ViewerLink } from "./ViewInRoom";

// The viewer's places (apps/webxr/src/places.ts): a full 360-degree surround with its floor on yours. "room" keeps
// your own room in passthrough. Thumbnails are crops of the same CC0 Poly Haven panoramas (public/places/CREDITS.md).
const PLACES = [
  { id: "room", name: "Your room" },
  { id: "concert-hall", name: "Concert hall" },
  { id: "court", name: "Court" },
  { id: "gym", name: "Gym" },
  { id: "ring", name: "Ring" },
  { id: "studio", name: "Studio" },
  { id: "mountains", name: "Mountains" },
];

/** Where they stand: each tile opens the viewer with ?place=<id>. The plan's own place, if it has one, is marked. */
export default function PlacesRow({ id, planned }: { id: string; planned?: string | null }) {
  return (
    <section className="places" aria-labelledby="places-title">
      <h2 id="places-title">Places</h2>
      <ul className="places-row">
        {PLACES.map((p) => (
          <li key={p.id}>
            <ViewerLink query={`dream=${encodeURIComponent(id)}&place=${p.id}`} className={p.id === planned ? "place-tile on" : "place-tile"}>
              <span className="place-img">
                {p.id === "room" ? <RoomArt /> : <img src={`/places/${p.id}.jpg`} alt="" loading="lazy" width={400} height={250} />}
              </span>
              <span className="place-name">
                {p.name}
                {p.id === planned && <span className="place-tag">Planned</span>}
              </span>
            </ViewerLink>
          </li>
        ))}
      </ul>
      <p className="note">Your own room in passthrough, or a whole place around them with its floor on yours.</p>
    </section>
  );
}

/** Your room needs no picture of a place: just a room, in outline. */
function RoomArt() {
  return (
    <svg viewBox="0 0 160 100" aria-hidden="true">
      <rect x="50" y="22" width="60" height="40" fill="currentColor" fillOpacity="0.06" />
      <g fill="none" stroke="currentColor" strokeWidth="1" vectorEffect="non-scaling-stroke">
        <path d="M50 22h60v40H50zM0 0l50 22M160 0l-50 22M0 100l50-38M160 100l-50-38" strokeOpacity="0.55" />
        <path d="M65 62 36.5 100M80 62v38M95 62l28.5 38M36.8 72h86.4M21 84h118" strokeOpacity="0.22" />
      </g>
    </svg>
  );
}
