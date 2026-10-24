import Link from "next/link";

export default function NotFound() {
  return (
    <div className="empty">
      <h2>Nothing here.</h2>
      <p>That dream may still be on its way, or it has a different name.</p>
      <Link href="/" className="btn">Back to Lucid Dreams</Link>
    </div>
  );
}
