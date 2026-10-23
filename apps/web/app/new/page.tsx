import type { Metadata } from "next";
import MakeDream from "@/components/MakeDream";

export const metadata: Metadata = { title: "Make a dream" };

export default function NewDream() {
  return (
    <div className="wrap make">
      <header className="make-head">
        <h1 className="page-title">Make a dream.</h1>
        <p>Five seconds of someone is all it takes.</p>
      </header>
      <MakeDream />
    </div>
  );
}
