import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import DreamCard, { type CardDream } from "@/components/DreamCard";
import JobTile from "@/components/JobTile";
import LibraryHero, { type HeroItem } from "@/components/LibraryHero";
import { activeJobs, tend } from "@/lib/bridge";
import { listDreams, listReady } from "@/lib/bridge/dreams";
import { intentOf } from "@/lib/bridge/experience";
import { onThisMac } from "@/lib/bridge/http";
import { isPrivate, type Dream, type ExperienceMode } from "@/lib/dream";
import {
  MODE_ACTION,
  MODE_LABEL,
  displayName,
  heroOrder,
  legendNote,
  lineOf,
  mediaUrl,
  modeOf,
  publicFigure,
  creditOf,
  viewerQuery,
} from "@/lib/present";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Library" };

/** The library, grouped by what you do with each person. */
const GROUPS: { mode: ExperienceMode; title: string; blurb: string }[] = [
  { mode: "teach", title: "Lessons", blurb: "They show you the move, slowed down, then wait while you try." },
  { mode: "play", title: "Across the board", blurb: "Seated at a real-size board on your table, moving their own pieces. They never speak." },
  { mode: "companion", title: "Company", blurb: "Someone you miss, simply sitting with you." },
  { mode: "watch", title: "Replays", blurb: "The moment itself, life size on your floor. Walk all the way around it." },
];

export default async function Library() {
  const jobs = await activeJobs(); // first: a job that just finished turns into a dream here
  const all = listDreams();
  tend(all);
  const dreams = listReady(all, { withPrivate: onThisMac(await headers()) }); // a family's dream: on this Mac only

  const hero: HeroItem[] = heroOrder(dreams.filter((d) => !isPrivate(d)))
    .slice(0, 4)
    .map((d) => {
      const intent = intentOf(d);
      const mode = modeOf(d, intent);
      return {
        id: d.id,
        name: displayName(d),
        mode: MODE_LABEL[mode],
        line: lineOf(d, intent),
        action: MODE_ACTION[mode],
        query: viewerQuery(d, mode),
        credit: publicFigure(d.id) ? creditOf(d) : null,
        poster: mediaUrl(d, d.thumb),
        preview: mediaUrl(d, d.preview),
      };
    });

  const byMode = new Map<ExperienceMode, CardDream[]>();
  for (const d of dreams) {
    const intent = intentOf(d);
    const mode = modeOf(d, intent);
    byMode.set(mode, [...(byMode.get(mode) ?? []), card(d, intent)]);
  }
  const people = dreams.length;

  return (
    <>
      <h1 className="sr-only">Library</h1>
      {hero.length > 0 && <LibraryHero items={hero} />}

      <div className="wrap">
        <div className="lib-head">
          <p>
            {people === 0
              ? "Every dream you make lives here."
              : `${people} ${people === 1 ? "person" : "people"}, ready to stand in your room.`}
          </p>
          <Link href="/new" className="btn secondary">Make a dream</Link>
        </div>

        {jobs.length > 0 && (
          <section className="lib-group" aria-labelledby="g-progress">
            <h2 className="lib-title" id="g-progress">In progress</h2>
            <div className="in-progress">
              {jobs.map(({ id, name, status }) => (
                <JobTile key={id} id={id} name={name} initial={status} />
              ))}
            </div>
          </section>
        )}

        {GROUPS.filter((g) => byMode.get(g.mode)?.length).map((g) => (
          <section key={g.mode} className="lib-group" aria-labelledby={`g-${g.mode}`}>
            <div className="lib-group-head">
              <h2 className="lib-title" id={`g-${g.mode}`}>{g.title}</h2>
              <p>{g.blurb}</p>
            </div>
            <div className="grid">
              {byMode.get(g.mode)!.map((c) => (
                <DreamCard key={c.id} d={c} />
              ))}
            </div>
          </section>
        ))}

        {people === 0 && jobs.length === 0 && (
          <div className="empty">
            <h2>No dreams yet.</h2>
            <p>Start with five seconds of someone, head to toe.</p>
            <Link href="/new" className="btn">Make the first one</Link>
          </div>
        )}
      </div>
    </>
  );
}

function card(d: Dream, intent: string | null): CardDream {
  return {
    id: d.id,
    name: displayName(d),
    line: lineOf(d, intent),
    note: legendNote(d),
    badge: isPrivate(d) ? "Private" : null,
    poster: mediaUrl(d, d.thumb),
    preview: mediaUrl(d, d.preview),
  };
}
