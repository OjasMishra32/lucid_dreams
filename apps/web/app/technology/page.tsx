import type { Metadata } from "next";
import katex from "katex";
import "katex/dist/katex.min.css";
import Atlas, { type AtlasStep } from "@/components/tech/Atlas";
import GaussianPlayground from "@/components/tech/GaussianPlayground";
import Compositing from "@/components/tech/Compositing";
import Trajectories from "@/components/tech/Trajectories";
import FillRate from "@/components/tech/FillRate";
import HeadsetStage from "@/components/tech/HeadsetStage";
import { MeasuredTable, TruthSlider } from "@/components/home/Measured";
import { ViewerLink } from "@/components/ViewInRoom";
import { heroFrames, heroJoints, measured, rigCameras } from "@/lib/scenes";
import type { RigCamera } from "@/lib/three/story";
import "./tech.css";

export const metadata: Metadata = {
  title: "Technology",
  description: "The mathematics of Lucid Dreams: anisotropic 3D Gaussians, EWA projection, front-to-back compositing, 4DAnyone's 48 cameras, MCMC densification, SMPL-X, Magnus lift and the fill rate of a Quest 3S.",
};

export const dynamic = "force-dynamic";

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

export default function TechnologyPage() {
  const hero = heroFrames();
  const cams = rigCameras() as RigCamera[];
  const joints = heroJoints(0);
  const rows = measured();
  const n = hero?.count ?? 289466;

  const steps: AtlasStep[] = [
    {
      mode: "splats",
      label: "Splats",
      body: (
        <>
          <p className="t-num">02</p>
          <h3>{n.toLocaleString("en-US")} of them.</h3>
          <p>
            One frame of the dancer, rendered live in this page. Each Gaussian is fourteen numbers (a mean, a unit
            quaternion, three log-scales, an opacity and a colour) plus nine that let its colour change with the
            direction you look from: spherical harmonics up to degree one.
          </p>
          <Eq tex={String.raw`\Theta=\{(\boldsymbol\mu_i,\ \mathbf q_i,\ \mathbf s_i,\ o_i,\ \mathbf k_i)\}_{i=1}^{N}`} />
          <Eq tex={String.raw`c_i(\mathbf d)=\sum_{\ell=0}^{1}\sum_{m=-\ell}^{\ell}k_{i,\ell}^{m}\,Y_{\ell}^{m}(\mathbf d)`} />
          <p className="quiet">
            On the wire each one is about 15 bytes (SPZ: 24-bit fixed-point means, 8-bit log-scales and opacity, a
            quaternion in three bytes, the base colour), so a frame is about 4 MB and the whole five seconds 518 MB.
          </p>
        </>
      ),
    },
    {
      mode: "ellipsoids",
      label: "Ellipsoids",
      body: (
        <>
          <h3>Their true shapes.</h3>
          <p>
            Drawn flat to one standard deviation, every Gaussian shows its real extent and orientation: long thin ones
            along the folds of a sleeve, broad ones across a back. A needle can look right from the views it was fitted
            to and smear from everywhere else, so the fit taxes any axis ratio past six to one.
          </p>
          <Eq tex={String.raw`\mathcal L_{\text{aniso}}=\beta\,\frac1N\sum_{i}\max\!\Big(0,\ \max_k s_{ik}-\min_k s_{ik}-\log 6\Big),\qquad \beta=0.05`} />
        </>
      ),
    },
    {
      mode: "centres",
      label: "Centres",
      body: (
        <>
          <h3>And where they sit.</h3>
          <p>
            Shrink each one to a point and the means are what is left: dense where detail lives (the face, the hands, a
            hem), sparse across flat cloth. They got there by MCMC densification: the Gaussians are treated as samples of
            a distribution and moved by stochastic Langevin steps, with dead ones relocated to where the loss is high,
            capped at 300,000 so every frame fits the headset.
          </p>
          <Eq tex={String.raw`\boldsymbol\mu \leftarrow \boldsymbol\mu-\eta\,\nabla_{\boldsymbol\mu}\mathcal L+\lambda\,\eta\,\sigma\!\big(-\kappa(o-t)\big)\,\Sigma\,\boldsymbol\varepsilon`} label="ε ~ N(0, I). Kheradmand et al., 3D Gaussian Splatting as Markov Chain Monte Carlo (2024)" />
        </>
      ),
    },
    {
      mode: "cameras",
      label: "48 cameras",
      body: (
        <>
          <p className="t-num">03</p>
          <h3>Forty-eight cameras that were never there.</h3>
          <p>
            One video holds one viewpoint. 4DAnyone, a video diffusion model published this August, generates the same
            five seconds from 48 more, in step frame for frame: three rings of sixteen at −10°, 15° and 35°,
            2.8 m out. Those cameras are known exactly, so there is no structure from motion to solve; every pixel is a
            ray of a pinhole camera.
          </p>
          <Eq tex={String.raw`\lambda\begin{pmatrix}u\\v\\1\end{pmatrix}=K\,[\,R\mid\mathbf t\,]\begin{pmatrix}\mathbf X\\1\end{pmatrix}`} />
          <Eq tex={String.raw`K=\begin{pmatrix}1735.6&0&352\\0&1735.6&640\\0&0&1\end{pmatrix}`} label="This rig, from 4DAnyone's own cameras.json: 704 × 1280 pixels a view" />
        </>
      ),
    },
    {
      mode: "skeleton",
      label: "Skeleton",
      body: (
        <>
          <h3>A body under the light.</h3>
          <p>
            GVHMR fits SMPL-X to the clip: a parametric body whose shape β and pose θ drive 10,475 vertices through
            blend shapes and linear blend skinning. We carry its 22 body joints into every bundle, checked against the
            Gaussians (the head 1 to 5 cm above the head&apos;s Gaussians, planted ankles at ankle height). Lessons score
            your head and wrists against them.
          </p>
          <Eq tex={String.raw`M(\boldsymbol\beta,\boldsymbol\theta)=W\!\big(\bar{T}+B_S(\boldsymbol\beta)+B_P(\boldsymbol\theta),\ J(\boldsymbol\beta),\ \boldsymbol\theta,\ \mathcal W\big)`} />
          <p>
            The people you play against are rigged the same way, and every Gaussian follows its bones by dual-quaternion
            skinning, which keeps volume where linear blending collapses a twisted wrist into a candy wrapper.
          </p>
          <Eq tex={String.raw`\hat{\mathbf q}_i=\frac{\sum_j w_{ij}\,\hat{\mathbf q}_j}{\big\lVert\sum_j w_{ij}\,\hat{\mathbf q}_j\big\rVert},\qquad R_i' = R(\hat{\mathbf q}_i)\,R_i`} />
        </>
      ),
    },
    {
      mode: "seen",
      label: "Seen vs imagined",
      body: (
        <>
          <h3>What a camera really saw.</h3>
          <p>
            The real camera is solved against the generated views. A Gaussian counts as seen when its centre lands inside
            that frame, on the person, and no more than 4 cm behind the depth rendered there. Everything else, like the
            back she turned away, was imagined by the model, and the Reality check paints it blue.
          </p>
          <Eq tex={String.raw`\begin{aligned}\text{seen}_i=\bigvee_{c}\ &\big[\pi_c(\boldsymbol\mu_i)\in\Omega_c\big]\ \wedge\ \big[A_c(\pi_c(\boldsymbol\mu_i))>\tfrac12\big]\\ \wedge\ &\big[z_{c,i}\le D_c(\pi_c(\boldsymbol\mu_i))+4\,\text{cm}\big]\end{aligned}`} label="π_c projects into camera c, A_c and D_c are the alpha and expected depth it renders" />
          <p className="quiet">For this dancer, {hero?.seen != null ? `${Math.round(hero.seen * 1000) / 10}%` : "about half"} of the Gaussians were seen.</p>
        </>
      ),
    },
  ];

  return (
    <div className="tech">
      <header className="t-hero">
        <p className="t-eyebrow">Technology</p>
        <h1>The mathematics of being in the room.</h1>
        <p className="t-lede">
          Every person here is a few hundred thousand anisotropic 3D Gaussians, fitted to 48 views of a moment no camera
          filmed, then projected, sorted and blended for each eye 72 times a second by the phone-class GPU strapped to
          your face.
        </p>
        <div className="t-hero-eq">
          <Eq tex={String.raw`C(\mathbf p)=\sum_{i=1}^{N} c_i\,\alpha_i(\mathbf p)\prod_{j<i}\big(1-\alpha_j(\mathbf p)\big)`} />
        </div>
        <ol className="t-toc">
          <li><a href="#primitive">One Gaussian</a></li>
          <li><a href="#anatomy">A person</a></li>
          <li><a href="#pixel">To a pixel</a></li>
          <li><a href="#fit">The fit</a></li>
          <li><a href="#physics">The ball</a></li>
          <li><a href="#headset">The headset</a></li>
        </ol>
      </header>

      <section id="primitive" className="t-chapter">
        <div className="t-text">
          <p className="t-num">01</p>
          <h2>One Gaussian.</h2>
          <p>
            Everything you see is built from one primitive: a 3D Gaussian, a soft ellipsoid of density with a centre, an
            orientation, three radii, an opacity and a colour. The optimiser never touches a matrix. It moves a quaternion
            and three log-scales, and the covariance is assembled from them, so it stays symmetric positive semi-definite
            whatever the gradient does.
          </p>
          <Eq tex={String.raw`G(\mathbf x)=\exp\!\Big(-\tfrac12\,(\mathbf x-\boldsymbol\mu)^{\!\top}\Sigma^{-1}(\mathbf x-\boldsymbol\mu)\Big)`} />
          <Eq tex={String.raw`\Sigma=R\,S\,S^{\top}R^{\top}`} />
          <Eq tex={String.raw`S=\operatorname{diag}\!\big(e^{s_1},e^{s_2},e^{s_3}\big),\qquad R=R\big(\mathbf q/\lVert\mathbf q\rVert\big)`} />
          <p className="quiet">Drag the ends of the two axes. In 2D, the same algebra: Σ&apos;s eigenvectors are R&apos;s columns, its eigenvalues σ².</p>
        </div>
        <GaussianPlayground />
      </section>

      <section id="anatomy" className="t-atlas">
        <Atlas input={{ frame: hero?.frame ?? "", reality: hero?.reality ?? null, cameras: cams, joints }} steps={steps} />
      </section>

      <section id="pixel" className="t-chapter t-wide">
        <div className="t-text">
          <p className="t-num">04</p>
          <h2>From a Gaussian to a pixel.</h2>
          <p>
            A 3D Gaussian seen through a perspective camera is no longer Gaussian, but linearised at its centre it is:
            Zwicker&apos;s elliptical weighted average. The renderer carries each covariance into the eye with the view
            matrix W and the Jacobian J of the projection, adds 0.3 px² so nothing is thinner than a pixel, and draws a
            quad along the result&apos;s eigenvectors out to k = √8 standard deviations.
          </p>
          <div className="eq-row">
            <Eq tex={String.raw`\Sigma'=J\,W\,\Sigma\,W^{\top}J^{\top}+0.3\,I_2`} label="EWA splatting (Zwicker et al., 2001)" />
            <Eq tex={String.raw`J=\begin{pmatrix}f/z&0&-f x/z^{2}\\0&f/z&-f y/z^{2}\end{pmatrix}`} label="the projection's Jacobian at the centre" />
          </div>
          <Eq tex={String.raw`\lambda_{1,2}=\tfrac{a+d}{2}\pm\sqrt{\big(\tfrac{a-d}{2}\big)^2+b^2},\qquad \text{quad}=\pm k\sqrt{\lambda_1}\,\mathbf e_1\ \pm k\sqrt{\lambda_2}\,\mathbf e_2,\qquad \Sigma'=\begin{pmatrix}a&b\\b&d\end{pmatrix}`} />
          <p>
            Order matters: as you move, all 290,000 are re-sorted by their distance from the eye on a background thread
            (Rust compiled to WebAssembly), and the GPU blends them back to front, <M tex={String.raw`C\leftarrow\alpha c+(1-\alpha)\,C`} />,
            which is the same sum as front to back. Below, one pixel&apos;s ray through a slice of nine Gaussians, computed
            exactly that way. Drag along the image.
          </p>
          <Eq tex={String.raw`\alpha_i(\mathbf p)=o_i\,\exp\!\Big(-\tfrac12\,\boldsymbol\delta^{\top}\Sigma_i'^{-1}\boldsymbol\delta\Big),\quad \boldsymbol\delta=\mathbf p-\pi(\boldsymbol\mu_i),\qquad T_i=\prod_{j<i}(1-\alpha_j)`} />
        </div>
        <Compositing />
      </section>

      <section id="fit" className="t-chapter t-wide">
        <div className="t-text">
          <p className="t-num">05</p>
          <h2>Fitting a moment, frame by frame.</h2>
          <p>
            The renderer is differentiable, so the Gaussians are fitted by gradient descent: render four of the 48 views,
            compare, step with Adam, repeat. The first frame starts from a visual hull and takes 7,000 steps; every later
            frame starts from the one before and takes 1,500, about a minute on an NVIDIA B200, which is also why she
            doesn&apos;t flicker. Each step draws on a random background, so transparency has to be learned rather than
            painted.
          </p>
          <Eq tex={String.raw`\mathcal L=0.8\,\lVert\hat I-I\rVert_1+0.2\,\big(1-\operatorname{SSIM}(\hat I,I)\big)+0.1\,\lVert\hat A-A\rVert_1+0.3\,\mathcal L_{\text{VGG}}+0.01\,\overline{\sigma(o)}+0.01\,\overline{e^{s}}+\mathcal L_{\text{aniso}}`} />
          <div className="eq-row">
            <Eq tex={String.raw`\operatorname{SSIM}(x,y)=\frac{(2\mu_x\mu_y+C_1)(2\sigma_{xy}+C_2)}{(\mu_x^2+\mu_y^2+C_1)(\sigma_x^2+\sigma_y^2+C_2)}`} />
            <Eq tex={String.raw`\operatorname{PSNR}=10\log_{10}\frac{1}{\operatorname{MSE}}\ \text{dB}`} />
          </div>
          <p>
            The real frame joins the fit as one more camera, solved against the views and weighted 1.5. Where the
            generated person and the real one disagree by a few centimetres, it counts only where they agree; otherwise
            the fit holds both, and you get a ghost limb.
          </p>
        </div>
        <div className="t-truth">
          <TruthSlider real="/media/truth-dance-real.jpg" render="/media/truth-dance-render.jpg" />
          <p className="quiet t-cap">The real frame against our render, from the same camera at the same instant.</p>
          {rows.length > 0 && (
            <div className="t-measured">
              <MeasuredTable rows={rows} />
            </div>
          )}
        </div>
      </section>

      <section id="physics" className="t-chapter t-wide">
        <div className="t-text">
          <p className="t-num">06</p>
          <h2>The ball obeys the air.</h2>
          <p>
            Against Federer the ball is simulated at 240 Hz, the same model for live play, his anticipation and the shot
            solver, so what he predicts is what happens. A tennis ball is a 57 g hollow shell, 6.7 cm across: quadratic
            drag, gravity, and Magnus lift from its spin, which makes topspin dip and slice float. Spin decays in the air.
            On grass the contact patch slides, and friction trades pace for spin until it grips.
          </p>
          <Eq tex={String.raw`\dot{\mathbf v}=\mathbf g-\frac{\rho C_D A}{2m}\lVert\mathbf v\rVert\,\mathbf v+\frac{\rho A}{2m}\,C_L\lVert\mathbf v\rVert^{2}\,\frac{\boldsymbol\omega\times\mathbf v}{\lVert\boldsymbol\omega\times\mathbf v\rVert},\qquad C_L=\min\!\Big(0.32,\ \frac{1}{2+v/(r\omega)}\Big)`} />
          <Eq tex={String.raw`v_n'=e\,v_n,\ \ e=\operatorname{clamp}(0.78-0.007\,v_n,\,0.62,\,0.76),\qquad j=\min\!\big(\mu(1+e)v_n,\ 0.4\,|u|\big),\ \ \Delta\omega=\tfrac{3}{2r}\,j,\ \ \mu=0.42`} label="the bounce: u is the contact point's slip, and a hollow shell's I = ⅔mr²" />
        </div>
        <Trajectories />
      </section>

      <section id="headset" className="t-headset">
        <HeadsetStage />
      </section>

      <section className="t-chapter t-wide t-fill">
        <div className="t-text">
          <h2>Every Gaussian costs pixels.</h2>
          <p>
            A Quest 3S has a phone&apos;s GPU and 1832 × 1920 pixels per eye. Spark draws each Gaussian as a quad
            whatever its opacity, so what a person costs is the sum of their quads, and a 290,000-Gaussian replay at
            arm&apos;s length runs to hundreds of millions of shaded fragments per eye per frame. We keep the Gaussians
            that add most to the picture, render at 70%, and a governor watches the frame time like a game&apos;s dynamic
            quality, trading splat size, the faintest Gaussians and foveation for frame rate.
          </p>
          <Eq tex={String.raw`N_{\text{px}}=\sum_i 4k^2\,\sigma_{1i}\sigma_{2i}\Big(\frac{f}{z_i}\Big)^{2},\qquad f=\frac{W}{2\tan(\mathrm{FOV}/2)},\qquad \text{keep } \operatorname*{top}_B\ o_i\,\sigma_{1i}\sigma_{2i}`} />
          <Eq tex={String.raw`\ell\leftarrow\begin{cases}\ell+1 & \overline{\text{fps}}<0.85\,f_{\text{display}}\ \text{for }0.4\,\text{s}\\ \ell-1 & \overline{\text{fps}}>0.95\,f_{\text{display}}\ \text{for }5\,\text{s}\end{cases}\qquad k_\ell\in\{2.83,\,2.5,\,2.3,\,2.1,\,1.9\}`} label="the governor, apps/webxr/src/xr/quality.ts" />
          <p className="quiet">Estimates from the Gaussians of one real frame each, face on. Foveation&apos;s savings at the edges of the view aren&apos;t counted.</p>
        </div>
        <FillRate />
      </section>

      <section className="t-close">
        <h2>Now stand next to them.</h2>
        <p className="t-lede">Open it in a Quest&apos;s browser, or on any laptop.</p>
        <div className="t-actions">
          <ViewerLink query="dream=dance-01" className="pill">Open the dancer</ViewerLink>
          <a className="pill pill-quiet" href="https://github.com/OjasMishra32/lucid_dreams">Read the source</a>
        </div>
        <p className="quiet t-credits">
          Built on 4DAnyone (Ant Research, 2026), gsplat with MCMC densification, GVHMR and SMPL-X, LHM++ and UIKA,
          Spark 2 for three.js, Stockfish 19. Credits and licences in the repository.
        </p>
      </section>
    </div>
  );
}
