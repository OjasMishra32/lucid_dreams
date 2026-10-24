import type { Metadata, Viewport } from "next";
import Nav from "@/components/Nav";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "Lucid Dreams", template: "%s · Lucid Dreams" },
  description: "Anyone from any video, standing in your room.",
};

export const viewport: Viewport = { themeColor: "#000000", viewportFit: "cover" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="skip">Skip to content</a>
        <Nav />
        <main id="main" tabIndex={-1}>{children}</main>
        <footer className="footer">
          <div className="footer-inner">
            <span>Lucid Dreams. Open source under the MIT license.</span>
            <a href="https://github.com/OjasMishra32/lucid_dreams">Source on GitHub</a>
          </div>
        </footer>
      </body>
    </html>
  );
}
