import { dreamUrl, formatCount, listDreams } from "./dream";

export async function renderLibrary(root: HTMLElement) {
  root.innerHTML = `
    <nav class="nav"><div class="wordmark">Lucid Dreams</div><div class="nav-links"><a class="nav-link" href="?mode=chess">Chess</a><a class="nav-link" href="https://github.com/OjasMishra32/lucid_dreams">Source</a></div></nav>
    <header class="hero">
      <p class="eyebrow">Lucid Dreams</p>
      <h1>Anyone from any video,<br />standing in your room.</h1>
      <p>One clip becomes a photoreal, life-size person you can walk all the way around. On any screen, or right in your room on Quest.</p>
    </header>
    <section class="feature" id="feature" hidden></section>
    <h2 class="section-title" id="grid-title" hidden>Dreams</h2>
    <main class="grid" id="grid"></main>`;
  const grid = root.querySelector<HTMLElement>("#grid")!;
  const dreams = await listDreams().catch(() => []);
  if (!dreams.length) {
    grid.outerHTML = `<p class="empty">The first dreams are being made.</p>`;
    return;
  }
  const lead = dreams.find((d) => d.preview && !d.id.startsWith("synthetic")) ?? null;
  if (lead) {
    const feature = root.querySelector<HTMLElement>("#feature")!;
    feature.hidden = false;
    feature.innerHTML = `<a href="?dream=${encodeURIComponent(lead.id)}" class="feature-frame">
        <video src="${dreamUrl(lead.id, lead.preview!)}" autoplay muted loop playsinline></video></a>
      <p class="feature-caption">${escapeHtml(lead.name)}. ${lead.kind === "avatar" ? "One photo, and now they can move." : "Rebuilt from one video, walked all the way around."}</p>`;
  }
  root.querySelector<HTMLElement>("#grid-title")!.hidden = false;
  grid.innerHTML = dreams
    .map((d) => {
      const meta = [d.kind === "avatar" ? "From a photo" : `${d.durationS.toFixed(1)} s`, d.frames?.gaussiansPerFrame ? `${formatCount(d.frames.gaussiansPerFrame)} Gaussians` : ""]
        .filter(Boolean)
        .join(" · ");
      // no render yet: the name's first letter, set quietly, instead of an empty tile
      const thumb = d.thumb ? `<img src="${dreamUrl(d.id, d.thumb)}" alt="" loading="lazy" />` : `<span class="initial">${escapeHtml(d.name.trim().charAt(0).toUpperCase())}</span>`;
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
