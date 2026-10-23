import { dreamUrl, formatCount, listDreams } from "./dream";

export async function renderLibrary(root: HTMLElement) {
  root.innerHTML = `
    <nav class="nav"><div class="wordmark">Lucid Dreams</div><a class="nav-link" href="https://github.com/OjasMishra32/lucid_dreams">Source</a></nav>
    <header class="hero">
      <p class="eyebrow">Lucid Dreams</p>
      <h1>Anyone from any video,<br />standing in your room.</h1>
      <p>One clip becomes a photoreal, life-size person you can walk all the way around. On any screen, or right in your room on Quest.</p>
    </header>
    <main class="grid" id="grid"></main>`;
  const grid = root.querySelector<HTMLElement>("#grid")!;
  const dreams = await listDreams().catch(() => []);
  if (!dreams.length) {
    grid.outerHTML = `<div class="empty"><div class="pulse"></div>The first dreams are being made.</div>`;
    return;
  }
  grid.innerHTML = dreams
    .map((d) => {
      const meta = [`${d.durationS.toFixed(1)} s`, d.frames?.gaussiansPerFrame ? `${formatCount(d.frames.gaussiansPerFrame)} Gaussians` : ""]
        .filter(Boolean)
        .join(" · ");
      const thumb = d.thumb ? `<img src="${dreamUrl(d.id, d.thumb)}" alt="" loading="lazy" />` : "";
      const preview = d.preview ? `<video src="${dreamUrl(d.id, d.preview)}" muted loop playsinline preload="none"></video>` : "";
      return `<a class="card" href="?dream=${encodeURIComponent(d.id)}">
        <div class="thumb">${thumb}${preview}</div>
        <h3>${escapeHtml(d.name)}</h3><p class="meta">${meta}</p></a>`;
    })
    .join("");
  grid.querySelectorAll<HTMLAnchorElement>(".card").forEach((card) => {
    const v = card.querySelector("video");
    if (!v) return;
    card.addEventListener("mouseenter", () => v.play().catch(() => {}));
    card.addEventListener("mouseleave", () => v.pause());
  });
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
