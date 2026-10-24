import katex from "katex";
import "katex/dist/katex.min.css";
import Atlas, { type AtlasStep } from "@/components/tech/Atlas";
import GaussianPlayground from "@/components/tech/GaussianPlayground";
import Compositing from "@/components/tech/Compositing";
import Trajectories from "@/components/tech/Trajectories";
import FillRate from "@/components/tech/FillRate";
import HeadsetStage from "@/components/tech/HeadsetStage";
import { MeasuredTable, TruthSlider } from "@/components/home/Measured";
import { heroFrames, heroJoints, measured, rigCameras } from "@/lib/scenes";
import type { RigCamera } from "@/lib/three/story";
import "./tech.css";

// the equations the opening's strip runs through: one for each chapter below
const MATH = [
  String.raw`\Sigma=R\,S\,S^{\top}R^{\top}`,
  String.raw`\Sigma'=J\,W\,\Sigma\,W^{\top}J^{\top}`,
  String.raw`C=\sum_i c_i\,\alpha_i\prod_{j<i}(1-\alpha_j)`,
  String.raw`\lambda\,\tilde{\mathbf x}=K\,[R\mid\mathbf t]\,\tilde{\mathbf X}`,
  String.raw`\mathcal L=0.8\,\mathcal L_1+0.2\,(1-\mathrm{SSIM})`,
  String.raw`M(\boldsymbol\beta,\boldsymbol\theta)=W(\bar T+B_S+B_P,\,J,\,\boldsymbol\theta,\,\mathcal W)`,
  String.raw`\dot{\mathbf v}=\mathbf g-k_D\lVert\mathbf v\rVert\mathbf v+k_L C_L\lVert\mathbf v\rVert^2\,\hat{\boldsymbol\omega}\times\hat{\mathbf v}`,
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
/** Inline math. */
function M({ tex }: { tex: string }) {
  return <span dangerouslySetInnerHTML={{ __html: katex.renderToString(tex, { throwOnError: false, output: "html", strict: false }) }} />;
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
            One real frame, rendered live. Each Gaussian has a position, rotation, scale, opacity and color, plus
            degree-1 spherical harmonics so the color shifts with viewing angle. About 15 bytes each in SPZ, 4 MB a frame.
          </p>
          <Eq tex={String.raw`\Theta=\{(\boldsymbol\mu_i,\ \mathbf q_i,\ \mathbf s_i,\ o_i,\ \mathbf k_i)\}_{i=1}^{N}`} />
          <Eq tex={String.raw`c_i(\mathbf d)=\sum_{\ell=0}^{1}\sum_{m=-\ell}^{\ell}k_{i,\ell}^{m}\,Y_{\ell}^{m}(\mathbf d)`} />
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
            Dense on the face and hands, sparse on flat cloth. MCMC densification puts them there, capped at 300k per frame.
          </p>
          <Eq tex={String.raw`\boldsymbol\mu \leftarrow \boldsymbol\mu-\eta\,\nabla_{\boldsymbol\mu}\mathcal L+\lambda\,\eta\,\sigma\!\big(-\kappa(o-t)\big)\,\Sigma\,\boldsymbol\varepsilon`} label="ε ~ N(0, I). Kheradmand et al., 2024" />
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
          <Eq tex={String.raw`\lambda\begin{pmatrix}u\\v\\1\end{pmatrix}=K\,[\,R\mid\mathbf t\,]\begin{pmatrix}\mathbf X\\1\end{pmatrix}`} />
          <Eq tex={String.raw`K=\begin{pmatrix}1735.6&0&352\\0&1735.6&640\\0&0&1\end{pmatrix}`} label="from 4DAnyone's cameras.json, 704 × 1280 per view" />
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
            GVHMR fits SMPL-X to the clip. We keep its 22 joints per frame, and lessons score your head and hands against
            them. Avatars are skinned with dual quaternions so wrists don&apos;t collapse when they twist.
          </p>
          <Eq tex={String.raw`M(\boldsymbol\beta,\boldsymbol\theta)=W\!\big(\bar{T}+B_S(\boldsymbol\beta)+B_P(\boldsymbol\theta),\ J(\boldsymbol\beta),\ \boldsymbol\theta,\ \mathcal W\big)`} />
          <Eq tex={String.raw`\hat{\mathbf q}_i=\frac{\sum_j w_{ij}\,\hat{\mathbf q}_j}{\big\lVert\sum_j w_{ij}\,\hat{\mathbf q}_j\big\rVert}`} />
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
          Each person is about 290k 3D Gaussians, fit to 48 views and rendered twice per frame at 72 Hz on a Quest 3S.
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
          <li><a href="#headset">Quest 3S</a></li>
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
            Each Gaussian is projected to 2D (EWA splatting), blurred by 0.3 px² and drawn as a quad out to √8σ. As you
            move, all 290k get re-sorted by distance and blended back to front, <M tex={String.raw`C\leftarrow\alpha c+(1-\alpha)\,C`} />.
          </p>
          <div className="eq-row">
            <Eq tex={String.raw`\Sigma'=J\,W\,\Sigma\,W^{\top}J^{\top}+0.3\,I_2`} label="Zwicker et al., 2001" />
            <Eq tex={String.raw`J=\begin{pmatrix}f/z&0&-f x/z^{2}\\0&f/z&-f y/z^{2}\end{pmatrix}`} />
          </div>
          <Eq tex={String.raw`\alpha_i(\mathbf p)=o_i\,\exp\!\Big(-\tfrac12\,\boldsymbol\delta^{\top}\Sigma_i'^{-1}\boldsymbol\delta\Big),\qquad T_i=\prod_{j<i}(1-\alpha_j)`} />
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
          <Eq tex={String.raw`\begin{aligned}\mathcal L=\ &0.8\,\lVert\hat I-I\rVert_1+0.2\,\big(1-\operatorname{SSIM}(\hat I,I)\big)+0.1\,\lVert\hat A-A\rVert_1\\ +\ &0.3\,\mathcal L_{\text{VGG}}+0.01\,\overline{\sigma(o)}+0.01\,\overline{e^{s}}+\mathcal L_{\text{aniso}}\end{aligned}`} />
          <Eq tex={String.raw`\operatorname{PSNR}=10\log_{10}\frac{1}{\operatorname{MSE}}\ \text{dB}`} />
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
          <Eq tex={String.raw`\dot{\mathbf v}=\mathbf g-\frac{\rho C_D A}{2m}\lVert\mathbf v\rVert\,\mathbf v+\frac{\rho A}{2m}\,C_L\lVert\mathbf v\rVert^{2}\,\frac{\boldsymbol\omega\times\mathbf v}{\lVert\boldsymbol\omega\times\mathbf v\rVert},\qquad C_L=\min\!\Big(0.32,\ \frac{1}{2+v/(r\omega)}\Big)`} />
        </div>
        <Trajectories />
      </section>

      <section id="headset" className="t-headset">
        <HeadsetStage />
      </section>

      <section className="t-chapter t-wide t-fill">
        <div className="t-text">
          <h2>Frame budget</h2>
          <p>
            Spark draws every Gaussian as a quad, even faint ones, so cost is total quad area. On the headset we keep the
            160k that matter most, render at 70%, and a governor shrinks splats and adds foveation when frames run late.
          </p>
          <Eq tex={String.raw`N_{\text{px}}=\sum_i 4k^2\,\sigma_{1i}\sigma_{2i}\Big(\frac{f}{z_i}\Big)^{2},\qquad f=\frac{W}{2\tan(\mathrm{FOV}/2)}`} />
          <p className="quiet">Estimates from one real frame, face-on. Foveation not counted.</p>
        </div>
        <FillRate />
      </section>
    </section>
  );
}
