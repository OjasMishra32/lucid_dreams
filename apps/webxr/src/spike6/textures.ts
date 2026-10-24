import * as THREE from "three";

function canvas(width: number, height: number): CanvasRenderingContext2D {
  const element = document.createElement("canvas");
  element.width = width;
  element.height = height;
  const context = element.getContext("2d");
  if (!context) throw new Error("Canvas 2D unavailable");
  return context;
}

function texture(context: CanvasRenderingContext2D, anisotropy: number): THREE.CanvasTexture {
  const map = new THREE.CanvasTexture(context.canvas);
  map.colorSpace = THREE.SRGBColorSpace;
  map.anisotropy = anisotropy;
  return map;
}

export function courtTexture(anisotropy: number): THREE.CanvasTexture {
  const ctx = canvas(4096, 2048);
  const length = 28.65;
  const width = 15.24;
  ctx.fillStyle = "#c89655";
  ctx.fillRect(0, 0, 4096, 2048);
  // Stable plank variation and fine grain, all generated locally.
  for (let row = 0; row < 96; row++) {
    for (let col = -1; col < 20; col++) {
      const x = col * 224 + (row % 2) * 112;
      const y = row * 22;
      const light = 54 + ((row * 17 + col * 13) % 13);
      ctx.fillStyle = `hsl(34 48% ${light}%)`;
      ctx.fillRect(x, y, 223, 21);
      ctx.fillStyle = "#56320e18";
      for (let grain = 0; grain < 4; grain++) ctx.fillRect(x + grain * 17, y + grain * 5, 190, 1);
    }
  }
  ctx.save();
  ctx.scale(4096 / length, 2048 / width);
  ctx.translate(0, width / 2);
  ctx.fillStyle = "#9b3038";
  for (const x of [0, length - 5.79]) ctx.fillRect(x, -2.44, 5.79, 4.88);
  ctx.strokeStyle = "#fff7e7";
  ctx.lineWidth = 0.05;
  const line = (x1: number, y1: number, x2: number, y2: number) => {
    ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
  };
  const circle = (x: number, y: number, radius: number) => {
    ctx.beginPath(); ctx.arc(x, y, radius, 0, Math.PI * 2); ctx.stroke();
  };
  ctx.strokeRect(0.04, -width / 2 + 0.04, length - 0.08, width - 0.08);
  line(length / 2, -width / 2, length / 2, width / 2);
  circle(length / 2, 0, 1.83);
  const corner = width / 2 - 0.91;
  const angle = Math.asin(corner / 7.24);
  const join = 1.60 + Math.sqrt(7.24 ** 2 - corner ** 2);
  for (const right of [false, true]) {
    ctx.save();
    if (right) { ctx.translate(length, 0); ctx.scale(-1, 1); }
    ctx.strokeRect(0, -2.44, 5.79, 4.88);
    circle(5.79, 0, 1.83);
    line(0, -corner, join, -corner);
    line(0, corner, join, corner);
    ctx.beginPath(); ctx.arc(1.60, 0, 7.24, -angle, angle); ctx.stroke();
    ctx.beginPath(); ctx.arc(1.60, 0, 1.22, -Math.PI / 2, Math.PI / 2); ctx.stroke();
    line(1.22, -0.915, 1.22, 0.915);
    circle(1.60, 0, 0.23);
    ctx.restore();
  }
  ctx.restore();
  return texture(ctx, anisotropy);
}

export function backdropTexture(anisotropy: number): THREE.CanvasTexture {
  const ctx = canvas(4096, 2048);
  ctx.fillStyle = "#101a2c";
  ctx.fillRect(0, 0, 4096, 2048);
  for (let row = 0; row < 24; row++) {
    const y = 220 + row * 69;
    ctx.fillStyle = "#4f5665";
    ctx.fillRect(0, y + 48, 4096, 5);
    for (let col = 0; col < 96; col++) {
      const x = col * 44 + (row % 2) * 22;
      ctx.fillStyle = ["#b33e4c", "#346280", "#d6b08a", "#7b8293"][(row * 7 + col * 11) % 4];
      ctx.beginPath(); ctx.arc(x, y, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(x - 10, y + 10, 20, 25);
    }
  }
  ctx.fillStyle = "#16253e";
  ctx.fillRect(0, 1780, 4096, 268);
  ctx.fillStyle = "#dae6f3";
  ctx.font = "bold 94px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("COURT SIDE   /   SYNTHETIC ARENA", 2048, 1950);
  return texture(ctx, anisotropy);
}

export function billboardTexture(): THREE.CanvasTexture {
  const ctx = canvas(256, 1024);
  ctx.fillStyle = "#bf8967";
  ctx.beginPath(); ctx.ellipse(128, 95, 40, 65, 0, 0, Math.PI * 2); ctx.fill();
  ctx.strokeStyle = "#bf8967";
  ctx.lineWidth = 30;
  ctx.lineCap = "round";
  for (const side of [-1, 1]) {
    ctx.beginPath(); ctx.moveTo(128 + side * 55, 220); ctx.lineTo(128 + side * 96, 520); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(128 + side * 30, 600); ctx.lineTo(128 + side * 49, 970); ctx.stroke();
  }
  ctx.fillStyle = "#d8dfed";
  ctx.fillRect(76, 175, 104, 365);
  ctx.fillStyle = "#263b59";
  ctx.fillRect(77, 540, 102, 132);
  return texture(ctx, 1);
}

export function textureBytes(map: THREE.CanvasTexture): number {
  // RGBA8 allocation, including the actual integer dimensions of every mip level.
  let { width, height } = map.image as HTMLCanvasElement;
  let bytes = 0;
  do {
    bytes += width * height * 4;
    if (!map.generateMipmaps || (width === 1 && height === 1)) break;
    width = Math.max(1, Math.floor(width / 2));
    height = Math.max(1, Math.floor(height / 2));
  } while (true);
  return bytes;
}
