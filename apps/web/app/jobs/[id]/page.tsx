import type { Metadata } from "next";
import { notFound } from "next/navigation";
import JobProgress from "@/components/JobProgress";
import { jobStatus } from "@/lib/bridge";
import { readDream } from "@/lib/bridge/dreams";
import { getJob } from "@/lib/bridge/store";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Making a dream" };

export default async function JobPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const status = await jobStatus(id);
  if (!status) notFound();
  const job = getJob(id);
  const dream = readDream(id);
  const name = job?.name ?? dream?.name ?? id;
  return <JobProgress id={id} name={name} kind={job?.kind ?? dream?.kind ?? "replay"} initial={status} />;
}
