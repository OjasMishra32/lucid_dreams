import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import WatchMeTry from "@/components/WatchMeTry";
import { attemptsView, lessonOf, lessonSteps } from "@/lib/bridge/attempts";
import { readDream } from "@/lib/bridge/dreams";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const d = readDream((await params).id);
  return { title: d ? `Watch me try · ${d.name}` : "Not found", robots: { index: false } };
}

/** "Watch me try": film your try at a lesson, and Gemini says what to fix, on both videos side by side. */
export default async function TryPage({ params }: Props) {
  const d = readDream((await params).id);
  if (!d) notFound();
  const back = `/library/${encodeURIComponent(d.id)}`;
  const l = lessonOf(d.id);

  if (!l) {
    return (
      <div className="narrow try-none">
        <Link href={back} className="back">{d.name}</Link>
        <h1 className="page-title">Watch me try</h1>
        <p>
          This works on lessons: a clip of someone doing a move, with the sentence &ldquo;teach me this&rdquo;. {d.name}&apos;s plan
          isn&apos;t a lesson{d.kind === "avatar" ? ", and a photo can't show a move" : " yet"}.
        </p>
        <Link href={back} className="btn secondary">Back to {d.name}</Link>
      </div>
    );
  }

  const e = l.experience;
  return (
    <div className="wrap try-page">
      <Link href={back} className="back">{d.name}</Link>
      <header className="try-head">
        <p className="plan-eyebrow">{[e.category, e.title].filter(Boolean).join(" · ")}</p>
        <h1 className="page-title">Watch me try</h1>
        <p>Film yourself doing the move. Gemini watches your try next to the lesson and tells you what to fix, moment by moment.</p>
      </header>
      <WatchMeTry
        id={d.id}
        steps={lessonSteps(e).map(({ start, end, title, tip }) => ({ start, end, title, tip }))}
        clockS={e.durationS || d.durationS}
        initial={attemptsView(l.dream, e)}
      />
    </div>
  );
}
