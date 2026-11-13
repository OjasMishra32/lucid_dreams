import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Lucid Dreams does with your voice when you talk with someone, and what it keeps.",
};

/** Plain words on Talk: where a spoken turn goes, what's kept, and the limits. Linked from the submission. */
export default function Privacy() {
  return (
    <main style={{ maxWidth: 680, margin: "0 auto", padding: "120px 22px 96px", lineHeight: 1.6 }}>
      <h1 style={{ fontSize: 40, letterSpacing: "-0.02em", margin: "0 0 24px" }}>Privacy</h1>
      <p>
        Lucid Dreams runs in your browser. Watching someone, walking around them, Reality check, lessons and games stay
        on your device: nothing about them is sent anywhere.
      </p>
      <h2 style={{ fontSize: 22, margin: "36px 0 8px" }}>When you press Talk</h2>
      <p>
        The microphone opens only after you press Talk, and the first time it says where your words go. Your recording
        (at most 20 seconds) goes to OpenAI to turn it into text and to write the reply, and the reply&apos;s text goes
        to ElevenLabs to be spoken in the voice of the person you&apos;re talking with. Each turn is handled in memory
        and the recording isn&apos;t saved by us. The last few lines of the conversation are kept in the server&apos;s
        memory so the reply makes sense, and they&apos;re gone when the server restarts.
      </p>
      <p>
        To keep it fair for everyone, each visitor gets a limited number of turns an hour. For that we log a one-way hash
        of your address with each turn, never the address itself.
      </p>
      <h2 style={{ fontSize: 22, margin: "36px 0 8px" }}>The people</h2>
      <p>
        A voice is only ever cloned with the consent of the person it belongs to (and, for Ian&apos;s grandmother, her
        family&apos;s). Every reply is labelled as an AI voice. Public figures never speak and are labelled not
        affiliated.
      </p>
      <p style={{ marginTop: 40 }}>
        <Link href="/" className="btn">Back to Lucid Dreams</Link>
      </p>
    </main>
  );
}
