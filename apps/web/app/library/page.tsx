import type { Metadata } from "next";
import Link from "next/link";
import DreamCard from "@/components/DreamCard";
import JobTile from "@/components/JobTile";
import { activeJobs } from "@/lib/bridge";
import { listDreams } from "@/lib/bridge/dreams";

export const dynamic = "force-dynamic";
export const metadata: Metadata = { title: "Library" };

export default async function Library() {
  const jobs = await activeJobs(); // first: a job that just finished turns into a dream here
  const dreams = listDreams();

  return (
    <div className="wrap">
      <header className="page-head">
        <div>
          <h1 className="page-title">Library</h1>
          <p>
            {dreams.length === 0
              ? "Every dream you make lives here."
              : `${dreams.length} ${dreams.length === 1 ? "person" : "people"}, ready to stand in your room.`}
          </p>
        </div>
        <Link href="/new" className="btn secondary">Make a dream</Link>
      </header>

      {jobs.length > 0 && (
        <section>
          <h2 className="row-title">In progress</h2>
          <div className="in-progress">
            {jobs.map(({ job, status }) => (
              <JobTile key={job.id} id={job.id} name={job.name} initial={status} />
            ))}
          </div>
        </section>
      )}

      {dreams.length > 0 ? (
        <section>
          {jobs.length > 0 && <h2 className="row-title">Ready</h2>}
          <div className="grid">
            {dreams.map((d) => (
              <DreamCard key={d.id} dream={d} />
            ))}
          </div>
        </section>
      ) : (
        jobs.length === 0 && (
          <div className="empty">
            <h2>No dreams yet.</h2>
            <p>Start with five seconds of someone, head to toe.</p>
            <Link href="/new" className="btn">Make the first one</Link>
          </div>
        )
      )}
    </div>
  );
}
