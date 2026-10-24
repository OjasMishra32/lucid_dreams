// The loading page's progress (court.ts): the bytes the bundle's big files have brought in so far, so a slow link (a
// tunnel over venue Wi-Fi: ~200 MB at a few MB/s) shows a bar instead of a still "Loading the court". The show stream
// (video.ts) and the splats (freeze.ts) report here; the rest of the bundle is small. DOM-free (loading.test.ts).

interface Item {
  loaded: number;
  total: number;
  done: boolean;
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

  /** Bytes in for one file so far (total 0 while its length is unknown). */
  progress(key: string, loaded: number, total: number): void {
    const item = this.items.get(key) ?? { loaded: 0, total: 0, done: false };
    item.loaded = Math.max(item.loaded, loaded);
    item.total = Math.max(item.total, total, 0);
    this.items.set(key, item);
  }

  /** The file is in (its total becomes what came in, when the length was never known). */
  finished(key: string): void {
    const item = this.items.get(key) ?? { loaded: 0, total: 0, done: false };
    item.done = true;
    if (!item.total || item.loaded > item.total) item.total = item.loaded;
    else item.loaded = item.total;
    this.items.set(key, item);
  }

  failed(key: string, e: unknown): void {
    this.errors.push(`${key}: ${e instanceof Error ? e.message : String(e)}`);
    this.finished(key);
  }

  snapshot(): LoadSnapshot {
    let loaded = 0;
    let total = 0;
    let done = 0;
    const pending: string[] = [];
    for (const [key, item] of this.items) {
      loaded += item.loaded;
      total += Math.max(item.total, item.loaded);
      if (item.done) done++;
      else pending.push(key);
    }
    return { loaded, total, files: this.items.size, done, pending, errors: [...this.errors] };
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
