import type { Metadata } from "next";
import LiveBoard from "@/components/LiveBoard";
import { liveState } from "@/lib/bridge/liveRun";

export const dynamic = "force-dynamic";
export const metadata: Metadata = {
  title: "Live",
  description: "How a dream is made, as it happens: the stages, the GPUs and the real frame beside our render of it.",
};

/** For the judges: a running job's stages, timings, GPUs and truth-vs-render strip, read from HiPerGator as it happens. */
export default async function Live({ searchParams }: { searchParams: Promise<{ run?: string }> }) {
  const { run } = await searchParams;
  const pinned = typeof run === "string" && run.length > 0;
  const initial = await liveState(pinned ? run : null);
  return <LiveBoard initial={initial} pinned={pinned && initial.run?.id === run} />;
}
