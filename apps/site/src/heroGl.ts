// The hero: the render is black around the person, so a tiny WebGL pass turns black into transparency and the person
// stands in front of the headline instead of behind a black box. No three.js here: this runs on first paint.

const VERT = `attribute vec2 p; varying vec2 uv; void main() { uv = vec2(p.x * 0.5 + 0.5, 0.5 - p.y * 0.5); gl_Position = vec4(p, 0.0, 1.0); }`;
// premultiplied output: the render was made over black, so its colour already is colour x coverage
const FRAG = `precision mediump float; varying vec2 uv; uniform sampler2D t;
void main() {
  vec3 c = texture2D(t, uv).rgb;
  float m = max(c.r, max(c.g, c.b));
  float a = smoothstep(0.035, 0.12, m);
  gl_FragColor = vec4(c * mix(1.0, a, step(m, 0.12)) , a);
}`;

export interface HeroGl {
  canvas: HTMLCanvasElement;
}

export function mountHeroGl(video: HTMLVideoElement, host: HTMLElement): HeroGl | null {
  const canvas = document.createElement("canvas");
  canvas.className = "hero-gl";
  canvas.setAttribute("aria-hidden", "true");
  const gl = canvas.getContext("webgl", { premultipliedAlpha: true, alpha: true, antialias: false });
  if (!gl) return null;
  const sh = (type: number, src: string) => {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    return s;
  };
  const prog = gl.createProgram()!;
  gl.attachShader(prog, sh(gl.VERTEX_SHADER, VERT));
  gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FRAG));
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) return null;
  gl.useProgram(prog);
  const buf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const loc = gl.getAttribLocation(prog, "p");
  gl.enableVertexAttribArray(loc);
  gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
  const tex = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.clearColor(0, 0, 0, 0);

  const size = () => {
    const r = canvas.getBoundingClientRect();
    const dpr = Math.min(devicePixelRatio || 1, 2);
    const w = Math.max(2, Math.min(1080, Math.round(r.width * dpr)));
    const h = Math.max(2, Math.round((w * 16) / 9));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  };
  const draw = (src: TexImageSource) => {
    try {
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, src);
    } catch {
      return;
    }
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  };

  host.appendChild(canvas);
  size();
  new ResizeObserver(() => {
    size();
    if (video.readyState >= 2) draw(video);
  }).observe(canvas);

  // the poster first, so the person is there before the video has a frame
  if (video.poster) {
    const img = new Image();
    img.decoding = "async";
    img.onload = () => video.readyState < 2 && draw(img);
    img.src = video.poster;
  }

  type RVFC = (cb: () => void) => number;
  const rvfc = (video as unknown as { requestVideoFrameCallback?: RVFC }).requestVideoFrameCallback?.bind(video);
  if (rvfc) {
    const onFrame = () => {
      draw(video);
      rvfc(onFrame);
    };
    rvfc(onFrame);
  } else {
    const loop = () => {
      if (!video.paused && video.readyState >= 2) draw(video);
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  }
  video.addEventListener("loadeddata", () => draw(video));
  video.addEventListener("seeked", () => draw(video));
  document.documentElement.classList.add("has-hero-gl");
  return { canvas };
}
