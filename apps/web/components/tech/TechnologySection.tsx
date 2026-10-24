import katex from "katex";
import "katex/dist/katex.min.css";
import Atlas, { type AtlasStep } from "@/components/tech/Atlas";
import GaussianPlayground from "@/components/tech/GaussianPlayground";
import Compositing from "@/components/tech/Compositing";
import Trajectories from "@/components/tech/Trajectories";
import FillRate from "@/components/tech/FillRate";
import { MeasuredTable, TruthSlider } from "@/components/home/Measured";
import { heroFrames, heroJoints, measured, rigCameras } from "@/lib/scenes";
import type { RigCamera } from "@/lib/three/story";
import "./tech.css";

// the equations the opening's strip runs through: one for each chapter below
const MATH = [
  String.raw`\Sigma=R\,S\,S^{\top}R^{\top}`,
  String.raw`C=\sum_i c_i\,\alpha_i\prod_{j<i}(1-\alpha_j)`,
  String.raw`\mathcal L=0.8\,\mathcal L_1+0.2\,(1-\mathrm{SSIM})`,
  String.raw`N_{\mathrm{px}}=\sum_i 4k^2\sigma_{1i}\sigma_{2i}(f/z_i)^2`,
];

/** Display math, typeset on the server (no client JavaScript for the equations). */
function Eq({ tex, label }: { tex: string; label?: string }) {
  const html = katex.renderToString(tex, { displayMode: true, throwOnError: false, output: "html", strict: false });
  return (
    <figure className="eq">
      <div dangerouslySetInnerHTML={{ __html: html }} />
      {label && <figcaption>{label}</figcaption>}
    </figure>
  );
}

/** The technology chapters, a section of the one page (#technology): the real math, each idea with a live visual. */
export default function TechnologySection() {
  const hero = heroFrames();
  const cams = rigCameras() as RigCamera[];
  const joints = heroJoints(0);
  const rows = measured();
  const n = hero?.count ?? 289466;
  const seen = hero?.seen != null ? `${Math.round(hero.seen * 1000) / 10}%` : "about half";

  const steps: AtlasStep[] = [
    {
      mode: "splats",
      label: "Splats",
      body: (
        <>
          <p className="t-num">02</p>
          <h3>{n.toLocaleString("en-US")} per frame</h3>
          <p>
            One real frame, rendered live. Each Gaussian has a position, rotation, scale, opacity and color. About 15
            bytes each compressed, 4 MB a frame.
          </p>
        </>
      ),
    },
    {
      mode: "ellipsoids",
      label: "Shapes",
      body: (
        <>
          <h3>Their actual shapes</h3>
          <p>
            Each one drawn solid at 1σ. Long thin Gaussians look fine from the training views but smear from new ones,
            so we penalize axis ratios over 6:1.
          </p>
          <Eq tex={String.raw`\mathcal L_{\text{aniso}}=\beta\,\frac1N\sum_{i}\max\!\Big(0,\ \max_k s_{ik}-\min_k s_{ik}-\log 6\Big),\quad \beta=0.05`} />
        </>
      ),
    },
    {
      mode: "centres",
      label: "Centers",
      body: (
        <>
          <h3>Just the centers</h3>
          <p>
            Dense on the face and hands, sparse on flat cloth. Training adds and moves them where the error is high, capped
            at 300k per frame.
          </p>
        </>
      ),
    },
    {
      mode: "cameras",
      label: "Cameras",
      body: (
        <>
          <p className="t-num">03</p>
          <h3>48 generated cameras</h3>
          <p>
            4DAnyone (Aug 2026) turns one video into 48 synced views: 3 rings of 16 at −10°, 15° and 35°, 2.8 m out. The
            cameras are known, so there&apos;s no structure-from-motion step.
          </p>
        </>
      ),
    },
    {
      mode: "skeleton",
      label: "Body",
      body: (
        <>
          <h3>Body tracking</h3>
          <p>
            GVHMR fits a body model (SMPL-X) to the clip. We keep its 22 joints per frame, and lessons score your head and
            hands against them.
          </p>
        </>
      ),
    },
    {
      mode: "seen",
      label: "Real vs generated",
      body: (
        <>
          <h3>Real vs generated</h3>
          <p>
            A Gaussian counts as seen if the real camera saw it: in frame, on the person, within 4 cm of the rendered
            depth. Everything else was generated and shows blue. For her, {seen} was seen.
          </p>
          <Eq tex={String.raw`\begin{aligned}\text{seen}_i=\bigvee_{c}\ &\big[\pi_c(\boldsymbol\mu_i)\in\Omega_c\big]\ \wedge\ \big[A_c(\pi_c(\boldsymbol\mu_i))>\tfrac12\big]\\ \wedge\ &\big[z_{c,i}\le D_c(\pi_c(\boldsymbol\mu_i))+4\,\text{cm}\big]\end{aligned}`} />
        </>
      ),
    },
  ];

  return (
    <section id="technology" className="tech" aria-labelledby="tech-title">
      <header className="t-hero">
        <p className="t-eyebrow">Technology</p>
        <h2 id="tech-title" className="t-title">The math</h2>
        <p className="t-lede">
          Each person is about 290k 3D Gaussians, fit to 48 views and rendered twice per frame at 72 Hz.
        </p>
        <div className="math-strip" aria-hidden="true">
          <div className="math-run">
            {[...MATH, ...MATH].map((tex, i) => (
              <span key={i} className="math-item" dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { throwOnError: false, output: "html", strict: false }) }} />
            ))}
          </div>
        </div>
        <ol className="t-toc">
          <li><a href="#primitive">One Gaussian</a></li>
          <li><a href="#anatomy">A frame</a></li>
          <li><a href="#pixel">Rendering</a></li>
          <li><a href="#fit">Training</a></li>
          <li><a href="#physics">Ball physics</a></li>
        </ol>
      </header>

      <section id="primitive" className="t-chapter">
        <div className="t-text">
          <p className="t-num">01</p>
          <h2>One Gaussian</h2>
          <p>
            Everything is made of 3D Gaussians: soft ellipsoids with a position, rotation, three scales, an opacity and a
            color. We optimize a quaternion and log-scales, so Σ always stays valid.
          </p>
          <Eq tex={String.raw`G(\mathbf x)=\exp\!\Big(-\tfrac12\,(\mathbf x-\boldsymbol\mu)^{\!\top}\Sigma^{-1}(\mathbf x-\boldsymbol\mu)\Big)`} />
          <Eq tex={String.raw`\Sigma=R\,S\,S^{\top}R^{\top}`} />
          <Eq tex={String.raw`S=\operatorname{diag}\!\big(e^{s_1},e^{s_2},e^{s_3}\big),\qquad R=R\big(\mathbf q/\lVert\mathbf q\rVert\big)`} />
          <p className="quiet">Drag the two axes. Same algebra in 2D.</p>
        </div>
        <GaussianPlayground />
      </section>

      <section id="anatomy" className="t-atlas">
        <Atlas input={{ frame: hero?.frame ?? "", reality: hero?.reality ?? null, cameras: cams, joints }} steps={steps} />
      </section>

      <section id="pixel" className="t-chapter t-wide">
        <div className="t-text">
          <p className="t-num">04</p>
          <h2>Rendering a pixel</h2>
          <p>
            Spark projects each Gaussian to a 2D ellipse and draws it as a quad. As you move, all 290k get re-sorted by
            distance and blended: each pixel&apos;s color is every Gaussian&apos;s color, weighted by its alpha and by how
            much light is left after the ones in front.
          </p>
          <Eq tex={String.raw`C=\sum_i c_i\,\alpha_i\,T_i,\qquad T_i=\prod_{j<i}(1-\alpha_j)`} />
          <p className="quiet">Drag the ray to move the pixel.</p>
        </div>
        <Compositing />
      </section>

      <section id="fit" className="t-chapter t-fit">
        <div className="t-text">
          <p className="t-num">05</p>
          <h2>Training</h2>
          <p>
            Render 4 of the 48 views, compare, step with Adam, repeat. 7,000 steps for the first frame, then 1,500 for
            each next one, starting from the last (about a minute per frame on a B200). The real video frame counts as one
            more camera, only where it agrees with the views.
          </p>
          <Eq tex={String.raw`\mathcal L=0.8\,\lVert\hat I-I\rVert_1+0.2\,\big(1-\operatorname{SSIM}(\hat I,I)\big)+0.1\,\lVert\hat A-A\rVert_1+\mathcal L_{\text{reg}}`} label="color error, structure (SSIM), the person's outline, and small penalties on opacity, size and stretch" />
        </div>
        <div className="t-truth">
          <TruthSlider real="/media/truth-dance-real.jpg" render="/media/truth-dance-render.jpg" />
          <p className="quiet t-cap">Real frame vs our render, same camera, same instant.</p>
          {rows.length > 0 && (
            <div className="t-measured">
              <MeasuredTable rows={rows} />
              <p className="quiet t-fine">
                PSNR and SSIM: our render vs the 4DAnyone views it trained on (every 8th camera, median over frames). Seen:
                share of Gaussians the real camera saw.
              </p>
            </div>
          )}
        </div>
      </section>

      <section id="physics" className="t-chapter t-wide">
        <div className="t-text">
          <p className="t-num">06</p>
          <h2>Ball physics</h2>
          <p>
            Tennis runs at 240 Hz: gravity, drag and Magnus lift from spin, plus a grass bounce where friction trades
            speed for spin. Federer&apos;s AI uses the same model to read the ball.
          </p>
          <Eq tex={String.raw`\dot{\mathbf v}=\mathbf g\ -\ k_D\lVert\mathbf v\rVert\,\mathbf v\ +\ k_L\,C_L\lVert\mathbf v\rVert^{2}\,(\hat{\boldsymbol\omega}\times\hat{\mathbf v})`} label="gravity, drag, Magnus lift" />
        </div>
        <Trajectories />
      </section>

      <section className="t-chapter t-wide t-fill">
        <div className="t-text">
          <h2>Frame budget</h2>
          <p>
            Spark draws every Gaussian as a quad, even faint ones, so cost is total quad area. On the headset we keep the
            160k that matter most, render at 70%, and a governor shrinks splats and adds foveation when frames run late.
          </p>
          <Eq tex={String.raw`N_{\text{px}}=\sum_i 4k^2\,\sigma_{1i}\sigma_{2i}\Big(\frac{f}{z_i}\Big)^{2}`} label="pixels shaded: each quad's area, with σ the Gaussian's two biggest radii, z its distance, f the focal length" />
          <p className="quiet">Estimates from one real frame, face-on. Foveation not counted.</p>
        </div>
        <FillRate />
      </section>
    </section>
  );
}
