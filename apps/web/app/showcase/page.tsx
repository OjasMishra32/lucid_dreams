import type { Metadata } from "next";
import ShowcaseMoment, { type MomentDream } from "@/components/ShowcaseMoment";
import { listDreams, listReady } from "@/lib/bridge/dreams";
import { intentOf } from "@/lib/bridge/experience";
import { dreamFile, isPrivate } from "@/lib/dream";
import { MOMENTS, SHOWCASE_IDS } from "@/lib/showcase";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Showcase",
  description: "Five moments, one sentence each: a person from one video or photo, in your room, doing it with you.",
};

export default function Showcase() {
  const all = listDreams();
  const ready = new Map(listReady(all).map((d) => [d.id, d])); // never a private dream: those are a family's
  const privateIds = new Set(all.filter(isPrivate).map((d) => d.id));
  return (
    <>
      <header className="hero showcase-head">
        <p className="eyebrow">Showcase</p>
        <h1 className="display">
          Five moments.
          <br />
          One sentence each.
        </h1>
        <p className="lede">
          Every one starts as a single video or photo and a sentence of what you want to do with that person. Then
          they&apos;re in your room, doing it with you.
        </p>
      </header>

      <div className="wrap moments">
        {MOMENTS.map((m, i) => {
          const said = m.sentence ? new RegExp(m.sentence, "i") : null;
          const d =
            m.ids.map((id) => ready.get(id)).find(Boolean) ??
            (said ? [...ready.values()].find((r) => !SHOWCASE_IDS.includes(r.id) && said.test(intentOf(r) ?? "")) : undefined);
          const dream: MomentDream | null = d
            ? {
                id: d.id,
                name: d.name,
                intent: intentOf(d),
                preview: d.preview ? dreamFile(d.id, d.preview) : null,
                poster: d.thumb ? dreamFile(d.id, d.thumb) : null,
              }
            : null;
          const kept = !dream && m.ids.some((id) => privateIds.has(id));
          // chess: the other legend too, when their dream is ready
          const alt = d && m.chess ? (m.ids.find((id) => ready.has(id) && m.chess![id] !== m.chess![d.id]) ?? null) : null;
          return <ShowcaseMoment key={m.title} n={i + 1} moment={m} dream={dream} alt={alt} kept={kept} />;
        })}
      </div>
    </>
  );
}
