// The loading page's progress (court.ts): the bytes the bundle's big files have brought in so far, so a slow link (a
// tunnel over venue Wi-Fi: ~200 MB at a few MB/s) shows a bar instead of a still "Loading the court". The show stream
// (video.ts) and the splats (freeze.ts) report here; the rest of the bundle is small. court.ts names the files the page
// will wait for up front (expectedFiles, expect): their sizes come from a HEAD each before any of them streams in, so
// the total is fixed from the start and the bar only moves forward. Without that, a file joined the total only when it
// started (one the browser queued behind the first six, or the Reality check's splats under ?probe, which start once
// the rest are in), and the bar ran backwards: 99% of 133 MB, then 82% of 185. DOM-free (loading.test.ts).
import type { CourtBundle } from "./format";

interface Item {
  loaded: number;
  total: number;
  done: boolean;
  /** Named up front (expect): its size from a HEAD (0 when the HEAD gave none), and whether that HEAD has answered. */
  expected: boolean;
  size: number;
  sized: boolean;
}

/** A file the page waits for: the key its loader reports under, and its URL. */
export interface ExpectedFile {
  key: string;
  url: string;
}

/**
 * The big files the page waits for before Enter, under the keys their loaders report: the show stream ("the show",
 * video.ts; not with `element`, where a <video> plays pass 1) and every splat file freeze.ts loads first (each
 * player's, each extra's that is splats or a body; a relief is a small glb). With `reality`, the Reality check's
 * splats too: court.ts waits for them on probe pages and with ?splats; otherwise they load after the page is ready.
 */
export function expectedFiles(bundle: CourtBundle, opts: { reality: boolean; element: boolean }): ExpectedFile[] {
  const { video, freeze } = bundle.court;
  const splats = [...freeze.players.map((p) => ({ file: p.splats, reality: p.reality })), ...(freeze.others ?? []).filter((o) => o.kind !== "relief")];
  const paths = [...splats.map((s) => s.file), ...(opts.reality ? splats.map((s) => s.reality) : [])];
  const show = opts.element ? [] : [{ key: "the show", url: bundle.file(video.file) }];
  return [...show, ...paths.map((path) => ({ key: path, url: bundle.file(path) }))];
}

export interface LoadSnapshot {
  /** Bytes in and bytes expected, over every file that has reported (a file's total is 0 until its length is known). */
  loaded: number;
  total: number;
  files: number;
  done: number;
  /** The files still coming in, by key. */
  pending: string[];
  errors: string[];
}

export class LoadProgress {
  private readonly items = new Map<string, Item>();
  private readonly errors: string[] = [];

  private item(key: string): Item {
    let item = this.items.get(key);
    if (!item) this.items.set(key, (item = { loaded: 0, total: 0, done: false, expected: false, size: 0, sized: true }));
    return item;
  }

  /**
   * The files the page will wait for, before any of them comes in: each counts as pending at once, and its size comes
   * from a HEAD (fired before the downloads, so the browser's six connections answer them first). Until every HEAD
   * has answered the total reads 0; a HEAD that fails leaves the file's own Content-Length to count, as before.
   */
  async expect(files: ExpectedFile[], fetcher: typeof fetch = fetch): Promise<void> {
    for (const { key } of files) Object.assign(this.item(key), { expected: true, sized: false });
    await Promise.all(
      files.map(async ({ key, url }) => {
        try {
          const res = await fetcher(url, { method: "HEAD" });
          if (res.ok) this.item(key).size = Number(res.headers.get("Content-Length")) || 0;
        } catch {
          // no size up front: the GET's own length counts once it answers
        } finally {
          this.item(key).sized = true;
        }
      }),
    );
  }

  /** Bytes in for one file so far (total 0 while its length is unknown). */
  progress(key: string, loaded: number, total: number): void {
    const item = this.item(key);
    item.loaded = Math.max(item.loaded, loaded);
    item.total = Math.max(item.total, total, 0);
  }

  /** The file is in (its total becomes what came in, when the length was never known). */
  finished(key: string): void {
    const item = this.item(key);
    item.done = true;
    if (!item.total || item.loaded > item.total) item.total = item.loaded;
    else item.loaded = item.total;
  }

  failed(key: string, e: unknown): void {
    this.errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    this.finished(key);
  }

  snapshot(): LoadSnapshot {
    let loaded = 0;
    let total = 0;
    let done = 0;
    let unsized = false;
    const pending: string[] = [];
    for (const [key, item] of this.items) {
      loaded += item.loaded;
      // a file in counts what came in; one still coming, the most any of its lengths says
      total += item.done ? Math.max(item.total, item.loaded) : Math.max(item.size, item.total, item.loaded);
      unsized ||= !item.sized;
      if (item.done) done++;
      else pending.push(key);
    }
    return { loaded, total: unsized ? 0 : total, files: this.items.size, done, pending, errors: [...this.errors] };
  }

  /** fetch(url)'s body as bytes, reporting under key as it streams in. */
  async bytes(url: string, key = url, fetcher: typeof fetch = fetch): Promise<Uint8Array> {
    this.progress(key, 0, 0);
    try {
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const length = Number(res.headers.get("Content-Length")) || 0;
      this.progress(key, 0, length);
      if (!res.body) {
        const all = new Uint8Array(await res.arrayBuffer());
        this.progress(key, all.length, length);
        this.finished(key);
        return all;
      }
      const reader = res.body.getReader();
      const chunks: Uint8Array[] = [];
      let got = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        got += value.length;
        this.progress(key, got, length);
      }
      // one copy into the final buffer (a known length can't be trusted to match: a proxy may re-encode)
      const all = new Uint8Array(got);
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      this.finished(key);
      return all;
    } catch (e) {
      this.failed(key, e);
      throw e;
    }
  }
}

/** The page's one tracker (court.ts reads it; video.ts and freeze.ts report to it). */
export const loads = new LoadProgress();

/** "87 / 190 MB" for the bar's label. */
export function megabytes(s: LoadSnapshot): string {
  const mb = (n: number) => (n / 1e6).toFixed(0);
  return `${mb(s.loaded)} / ${mb(s.total)} MB`;
}
