import type { Metadata } from "next";
import ShowcaseMoment, { type MomentDream } from "@/components/ShowcaseMoment";
import { ViewerLink } from "@/components/ViewInRoom";
import { listDreams, listReady } from "@/lib/bridge/dreams";
import { intentOf } from "@/lib/bridge/experience";
import { isPrivate } from "@/lib/dream";
import { asSentence, displayName, mediaUrl } from "@/lib/present";
import { MOMENTS, SHOWCASE_IDS, chessLabel } from "@/lib/showcase";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Showcase",
  description: "Five moments, one sentence each: a person from one video or photo, in your room, doing it with you.",
};

export default function Showcase() {
  const all = listDreams();
  const ready = new Map(listReady(all).map((d) => [d.id, d])); // never a private dream: those are a family's
  const privateIds = new Set(all.filter(isPrivate).map((d) => d.id));

  const moments = MOMENTS.map((m, i) => {
    const said = m.sentence ? new RegExp(m.sentence, "i") : null;
    const d =
      m.ids.map((id) => ready.get(id)).find(Boolean) ??
      (said ? [...ready.values()].find((r) => !SHOWCASE_IDS.includes(r.id) && said.test(intentOf(r) ?? "")) : undefined);
    const dream: MomentDream | null = d
      ? {
          id: d.id,
          name: displayName(d),
          intent: intentOf(d),
          preview: mediaUrl(d, d.preview),
          poster: mediaUrl(d, d.thumb),
        }
      : null;
    const kept = !dream && m.ids.some((id) => privateIds.has(id));
    // chess: the other legend too, when their dream is ready
    const alt = d && m.chess ? (m.ids.find((id) => ready.has(id) && m.chess![id] !== m.chess![d.id]) ?? null) : null;
    return { m, n: i + 1, dream, kept, alt };
  });
  const shown = moments.filter((x) => x.dream);
  const waiting = moments.filter((x) => !x.dream);

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
        {shown.map(({ m, n, dream, kept, alt }) => (
          <ShowcaseMoment key={m.title} n={n} moment={m} dream={dream} alt={alt} kept={kept} />
        ))}

        {waiting.length > 0 && (
          <section className="waiting" aria-labelledby="waiting-title">
            <h2 id="waiting-title">{shown.length ? "And next." : "On their way."}</h2>
            <p>
              {waiting.length === 1 ? "One more moment" : `${waiting.length} more moments`}, planned and waiting for
              their person.
            </p>
            <ol>
              {waiting.map(({ m, n, kept }) => {
                const strength = m.chess ? Object.values(m.chess)[0] : null;
                return (
                  <li key={m.title}>
                    <p className="waiting-n num">{String(n).padStart(2, "0")}</p>
                    <div>
                      <h3>{m.title}</h3>
                      <p className="said">&ldquo;{asSentence(m.intent).replace(/\.$/, "")}.&rdquo;</p>
                    </div>
                    <div className="waiting-what">
                      <p>{m.line}</p>
                      <p className="status">
                        {kept
                          ? "Private. Shown only with her family’s permission."
                          : strength
                            ? "The board is ready; they take their seats once they pass the side-by-side with their photos."
                            : "Ready once it’s made."}
                      </p>
                      {strength && (
                        <>
                          <ViewerLink query={`mode=chess&strength=${strength}`} className="more">Play chess</ViewerLink>
                          <p>{chessLabel(strength)}</p>
                        </>
                      )}
                    </div>
                  </li>
                );
              })}
            </ol>
          </section>
        )}
      </div>
    </>
  );
}
