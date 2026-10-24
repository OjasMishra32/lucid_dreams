import type { Metadata } from "next";
import LivePipeline from "@/components/LivePipeline";
import { liveReply } from "@/lib/bridge/live";
import type { LiveReply } from "@/lib/live";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Live",
  description: "A dream being made: every stage with its real timing, the GPUs on it, and each frame as it's fitted.",
};

const FIRST_ANSWER_MS = 4000;

/** /live?id=<run>: one run, live. Without an id it follows the newest run still building, else shows the newest run. */
export default async function LivePage({ searchParams }: { searchParams: Promise<{ id?: string | string[] }> }) {
  const { id } = await searchParams;
  const want = typeof id === "string" && id ? id : null;
  // HiPerGator can be slow to answer the first time: the page comes up anyway and asks again
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = new Promise<LiveReply>((resolve) => {
    timer = setTimeout(() => resolve({ now: Date.now(), refreshS: 2, run: null, reason: "connecting" }), FIRST_ANSWER_MS);
  });
  const initial = await Promise.race([liveReply(want, !want), slow]).finally(() => clearTimeout(timer));
  // keyed, so going from one run's page to another (or to /live) starts fresh instead of keeping the last run
  return <LivePipeline key={want ?? "newest"} initial={initial} want={want} />;
}
