# Credits and source ledger

Every source Lucid Dreams uses, with its link and license: the people in the demo, the places and objects around them,
every model and its weights, and every library. Started by Atina; completed by Ian (Sat 12:45 AM) with licenses read
from each project's own license file, model card or Wikimedia Commons metadata, not inferred from search results.
It contains links and license terms only: no source media, model weights, private recordings, consent evidence, or
credentials.

**Our code is MIT** (the repository's `LICENSE`). That covers only what we wrote. Several components below carry
**non-commercial, share-alike or copyleft terms**; Lucid Dreams is a non-commercial hackathon project and uses them
within those terms (summary at the end). A license is never consent to clone a person's voice or to imply anyone
endorses Lucid Dreams.

Rows marked **pending** must name the exact asset that appears before the video or Devpost is published.

## People in the demo

| Use | Source and attribution | License / permitted use | Status |
| --- | --- | --- | --- |
| Piano lesson, side by side (`piano-han`) | Jason M. C. Han (“JMC, Han”), piano teacher, Wikimedia Commons. Candidate videos: [*D major Sonata - Beethoven*](https://commons.wikimedia.org/wiki/File:D_major_Sonata_-_Beethoven,_Piano_teacher_JMC,_Han.webm), [*3rd movement of Sonata 'Moonlight' Rocking Video*](https://commons.wikimedia.org/wiki/File:3rd_movement_of_Sonata_%27Moonlight%27_Rocking_Video_JMC,_Han_%28Jason%29.webm), [*Video Version of c Minor Prelude (BWV.847 Bach)*](https://commons.wikimedia.org/wiki/File:Video_Version_of_c_Minor_Prelude_%28BWV.847_Bach%29,JMC,Han.webm) | [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/) (all three): credit Jason M. C. Han, link the license, say it was adapted (reconstructed in 3D), share derivatives alike. | **Pending:** Ojasva names the exact file and time window used. |
| Chess with the legends: Bobby Fischer | “Bobby Fischer in Amsterdam voor besprekingen met FIDE-voorzitter Max Euwe…” (1972), W. Punt for Anefo, Nationaal Archief, [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Bobby_Fischer_in_Amsterdam_voor_besprekingen_met_FIDE-voorzitter_Max_Euwe_over_d,_Bestanddeelnr_925-3509.jpg) (the photo `apps/webxr/README.md` credits). Atina's earlier pick, [*Bobby Fischer 1972b*](https://commons.wikimedia.org/wiki/File:Bobby_Fischer_1972b.jpg), is the same photographer and license. | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/) (both). | **Pending:** Ojasva confirms which of the two fed the avatar job. Always labelled “Stockfish at Fischer's peak rating. Not affiliated.” |
| Chess with the legends: Magnus Carlsen | [*Magnus Carlsen (2012)*](https://commons.wikimedia.org/wiki/File:Magnus_Carlsen_%282012%29.jpg), Wikimedia Commons user Autopilot | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/): credit Autopilot, link the license, state edits, share derivatives alike. | Ready. Always labelled “Stockfish at Carlsen's peak rating. Not affiliated.” |
| Standing with you: Juice WRLD | [*Juice WRLD - Les Ardentes 2019*](https://commons.wikimedia.org/wiki/File:Juice_WRLD_-_Les_Ardentes_2019.jpg), Lexiou WesCudi | [CC BY-SA 2.0](https://creativecommons.org/licenses/by-sa/2.0/): credit Lexiou WesCudi, link the license, state edits, share derivatives alike. | Ready. No voice, no speech written for him, no endorsement implied. |
| Two jump-shot replays (`jump-shot`, `jump-shot-2`) | Pexels videos [20521082](https://www.pexels.com/video/20521082/) and [20521018](https://www.pexels.com/video/20521018/) | [Pexels License](https://www.pexels.com/license/): free to use and modify; no attribution required (we credit anyway); no implied endorsement; not redistributed as-is. | **Pending:** creator names (Pexels' pages are behind a bot check; Ojasva copies them from the download pages). |
| LeBron's jump shot (`lebron-jumper`) | Clip supplied by Ojasva for this non-commercial hackathon demonstration; not redistributed in this repository. | Limited demo use only: no voice, no synthetic speech, no endorsement claim. | **Pending:** Ojasva's private permission record and final-use confirmation. |
| Buster Keaton restoration | [*Neighbors* (1920), Edward F. Cline and Buster Keaton](https://commons.wikimedia.org/wiki/File:Neighbors_%28Edward_F._Cline_and_Buster_Keaton,_1920%29.webm) | Public domain in the US (PD-US-expired on the source page). | Ready to cite; Ojasva selects the short cut. |
| Josephine Baker restoration candidate | [*Le Pompier des Folies Bergère* (1928)](https://commons.wikimedia.org/wiki/File:Le_Pompier_des_Folies_Berg%C3%A8re_%281928%29.webm), unknown author | Public domain on the source page (anonymous work). Keep the source attribution. | Use only if its cut is selected. |
| Someone you've lost | A teammate's family photo or video, private, with written consent; anonymous record in [consent.md](consent.md). | Only what that written consent allows. | **Pending:** written yes. Skipped without one. |
| The synthetic test person | Our own: generated by `pipeline/lucid/synthetic.py` (`samples/synthetic-test`). | MIT, like the rest of the project. | Ready. |

## Places and objects

| Asset | Source | Author(s) | License |
| --- | --- | --- | --- |
| Concert hall | [Poly Haven: Music Hall 01](https://polyhaven.com/a/music_hall_01) | Sergej Majboroda | [CC0 1.0](https://polyhaven.com/license) |
| Court | [Poly Haven: Netball Court](https://polyhaven.com/a/netball_court) | Dimitrios Savva, Jarod Guest | CC0 1.0 |
| Gym | [Poly Haven: Crossfit Gym](https://polyhaven.com/a/crossfit_gym) | Dimitrios Savva, Jarod Guest | CC0 1.0 |
| Boxing ring | [Poly Haven: Basement Boxing Ring](https://polyhaven.com/a/basement_boxing_ring) | Sergej Majboroda | CC0 1.0 |
| Studio | [Poly Haven: Monochrome Studio 02](https://polyhaven.com/a/monochrome_studio_02) | Grzegorz Wronkowski | CC0 1.0 |
| Mountains | [Poly Haven: Golden Gate Hills](https://polyhaven.com/a/golden_gate_hills) | Dimitrios Savva, Jarod Guest | CC0 1.0 |
| Chess set (site and WebXR) | [Poly Haven: Chess Set](https://polyhaven.com/a/chess_set) | Riley Queen | CC0 1.0 |
| Basketball and hoop | Built in code at regulation size (`apps/webxr/src/props.ts`, `apps/quest/Assets/LucidDreams/Scripts/Props/`) | Lucid Dreams | MIT |

Per-file details: [`apps/webxr/public/places/CREDITS.md`](../apps/webxr/public/places/CREDITS.md),
[`apps/site/public/assets/CREDITS.md`](../apps/site/public/assets/CREDITS.md).

## Models and weights

| Model | What it does for us | License / terms |
| --- | --- | --- |
| [4DAnyone](https://github.com/ant-research/4DAnyone) ([weights](https://huggingface.co/AntResearch/4DAnyone)), Jin, Xie, Zhang, Shen, Xu, Shen, Bao, Zhou, Xu (SIGGRAPH Asia 2026) | One video in, 24-48 consistent 360-degree views: the core of every replay. | Code and `model.safetensors`: Apache-2.0. Its weight repository is asset-by-asset ([LICENSE.md](https://huggingface.co/AntResearch/4DAnyone/blob/main/LICENSE.md)); the rows below are the third-party assets it ships. |
| ↳ [Wan2.2-TI2V-5B](https://huggingface.co/Wan-AI/Wan2.2-TI2V-5B) VAE and [Wan2.1](https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B) UMT5 prompt context | Video latent space and the fixed prompt. | Apache-2.0. |
| ↳ [Wan2.2-TI2V-5B-Turbo](https://huggingface.co/quanhaol/Wan2.2-TI2V-5B-Turbo) rank-64 LoRA (mirror of [Kijai's](https://huggingface.co/Kijai/WanVideo_comfy)) | Fast sampling. | **[CC BY-NC-SA 4.0](https://creativecommons.org/licenses/by-nc-sa/4.0/)**: non-commercial, share-alike. |
| ↳ [GVHMR](https://github.com/zju3dv/GVHMR) | Body motion from the clip (also used for avatar motion). | **Educational, research and non-profit use only**; derivatives must stay open source ([LICENSE](https://github.com/zju3dv/GVHMR/blob/main/LICENSE)). |
| ↳ HMR 2.0 from [4D-Humans](https://github.com/shubham-goel/4D-Humans), [ViTPose](https://github.com/ViTAE-Transformer/ViTPose) | Inside GVHMR. | MIT; Apache-2.0. |
| ↳ [Ultralytics YOLOv8](https://github.com/ultralytics/ultralytics) (`yolov8x.pt`) | Person detection inside GVHMR. | **AGPL-3.0**. |
| ↳ [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | Person segmentation for the views. | MIT. |
| ↳ [VGG-19](https://www.robots.ox.ac.uk/~vgg/research/very_deep/) | Perceptual loss. | CC BY 4.0. |
| ↳ MHR70 keypoint schema from [Meta Sapiens2](https://github.com/facebookresearch/sapiens2) | SMPL-X to keypoint regressor layout. | Sapiens2 License. |
| [DiGS-Avatar](https://github.com/KLMAV-CUC/DiGS-Avatar) (ECCV 2026) and its student checkpoint | One photo to a photoreal, animatable Gaussian person; the base we fine-tune on 4DAnyone's views. | MIT (code). The student checkpoint comes from the Google Drive link in `pipeline/hpg/setup-digs.sbatch`; no separate license is stated for it. |
| [DINOv3](https://github.com/facebookresearch/dinov3) ViT-B/16 (Meta) | Image features inside DiGS-Avatar. | [DINOv3 License](https://ai.meta.com/resources/models-and-libraries/dinov3-license) (gated; custom terms). |
| [Sana-Sprint 1.6B](https://huggingface.co/Efficient-Large-Model/Sana_Sprint_1.6B_1024px) and [DC-AE f32c32](https://huggingface.co/mit-han-lab/dc-ae-f32c32-sana-1.1-diffusers) (MIT HAN Lab / NVIDIA) | Diffusion prior and autoencoder inside DiGS-Avatar. | Sana-Sprint: Apache-2.0. DC-AE: MIT (diffusers release); the original `dc-ae-f32c32-sana-1.1` card states no license; code in [efficientvit](https://github.com/mit-han-lab/efficientvit) is Apache-2.0. |
| [IDOL](https://huggingface.co/yiyuzhuang/IDOL) assets (Yiyu Zhuang et al.) | Avatar template cache used by DiGS-Avatar. | No license stated on the model card or the [repository](https://github.com/yiyuzhuang/IDOL); used for research as distributed. |
| [SMPL-X](https://smpl-x.is.tue.mpg.de/) (Max Planck Institute for Intelligent Systems) | The body model and skeleton every avatar is posed with. | **[SMPL-X Model License](https://smpl-x.is.tue.mpg.de/modellicense.html)**: non-commercial scientific research; registration required; never committed or redistributed. |
| [NLF](https://github.com/isarandi/nlf) (István Sárándi) | Fits SMPL-X to a photo for avatars. | Code MIT; released models **non-commercial research use** (README). |
| U²-Net human segmentation via [rembg](https://github.com/danielgatis/rembg) | The avatar's photo matte. | [U-2-Net](https://github.com/xuebinqin/U-2-Net): Apache-2.0; rembg: MIT. |
| [Whisper](https://github.com/openai/whisper) weights via [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Words and timings for captions. | MIT (both). |
| [Demucs](https://github.com/facebookresearch/demucs) | Separates the speaking voice from music and noise (`voice.m4a`). | MIT. |
| [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) via [Real-ESRGAN-ncnn-vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) | 4x restoration of old footage (no face model). | BSD-3-Clause; MIT. |
| [Gemini](https://ai.google.dev/) (Google): `gemini-3.8-flash` and fallbacks, `gemini-3.8-flash-tts` (voice “Sulafat”) | Watches the move, writes the plan and guide, speaks the guide as a coach (never as the person). | [Gemini API Terms](https://ai.google.dev/gemini-api/terms). Uploads are deleted after each guide. |

## Code and libraries

**Pipeline (HiPerGator, Python)**

| Library | License |
| --- | --- |
| [PyTorch](https://github.com/pytorch/pytorch), [xFormers](https://github.com/facebookresearch/xformers), [PyTorch3D](https://github.com/facebookresearch/pytorch3d) | BSD-3-Clause |
| [gsplat](https://github.com/nerfstudio-project/gsplat) (v1.5.3): our per-frame Gaussian reconstruction | Apache-2.0 |
| [diff-gaussian-rasterization](https://github.com/graphdeco-inria/diff-gaussian-rasterization) and [simple-knn](https://github.com/camenduru/simple-knn) (Inria / MPII, used by DiGS-Avatar) | **[Gaussian-Splatting License](https://github.com/graphdeco-inria/gaussian-splatting/blob/main/LICENSE.md)**: non-commercial research and evaluation only (the simple-knn fork carries no license file; upstream is Inria's) |
| [timm](https://github.com/huggingface/pytorch-image-models), [Transformers](https://github.com/huggingface/transformers), [huggingface_hub](https://github.com/huggingface/huggingface_hub), [Kornia](https://github.com/kornia/kornia), [PyTorch Lightning](https://github.com/Lightning-AI/pytorch-lightning), [MMEngine](https://github.com/open-mmlab/mmengine), [MMCV](https://github.com/open-mmlab/mmcv), [torch-fidelity](https://github.com/toshas/torch-fidelity) | Apache-2.0 |
| [LPIPS](https://github.com/richzhang/PerceptualSimilarity), [imageio-ffmpeg](https://github.com/imageio/imageio-ffmpeg) | BSD-2-Clause |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime), [gdown](https://github.com/wkentaro/gdown) | MIT |
| [plyfile](https://github.com/dranjan/python-plyfile) | GPL-3.0 (used as an installed dependency; not bundled) |
| [FFmpeg](https://ffmpeg.org/) | LGPL or GPL depending on the build configuration (Atina's Homebrew build enables GPL components) |

**Web app, WebXR viewer and site (TypeScript)**

| Library | License |
| --- | --- |
| [three.js](https://github.com/mrdoob/three.js), [Spark](https://github.com/sparkjsdev/spark) (Gaussian rendering), [Vite](https://github.com/vitejs/vite), [Next.js](https://github.com/vercel/next.js), [React](https://github.com/facebook/react), [busboy](https://github.com/mscdex/busboy) | MIT |
| [MediaPipe Tasks Vision](https://github.com/google-ai-edge/mediapipe) (in-browser “one person, head to toe” check), [Google Gen AI SDK](https://github.com/googleapis/js-genai), [TypeScript](https://github.com/microsoft/TypeScript) | Apache-2.0 |
| [chess.js](https://github.com/jhlywa/chess.js) | BSD-2-Clause |
| [Stockfish 19](https://github.com/official-stockfish/Stockfish), WebAssembly build from [stockfish.js](https://github.com/nmrugg/stockfish.js) | **GPL-3.0**; shipped as a separate program with its license in `apps/webxr/public/engine/STOCKFISH-COPYING.txt`. Its ratings are never presented as the real players. |

**Quest app (Unity)**

| Component | License |
| --- | --- |
| [Unity Gaussians](https://github.com/ninjamode/Unity-VR-Gaussian-Splatting) (Constantin Kleinbeck), built on Aras Pranckevičius's [UnityGaussianSplatting](https://github.com/aras-p/UnityGaussianSplatting) | MIT |
| Unity 6 engine | [Unity Terms of Service](https://unity.com/legal/terms-of-service) |
| Universal Render Pipeline, OpenXR, AR Foundation, XR Hands, XR Interaction Toolkit, Input System, uGUI / TextMesh Pro | [Unity Companion License](http://www.unity3d.com/legal/licenses/Unity_Companion_License) |
| Unity OpenXR: Meta | Unity Companion License (source); Unity Package Distribution License (binaries) |
| Liberation Sans (TextMesh Pro's default font) | [SIL Open Font License 1.1](https://openfontlicense.org/) |

## Terms that limit use (summary)

Lucid Dreams is a non-commercial hackathon project, and these terms keep it that way:

- **Non-commercial:** Inria's diff-gaussian-rasterization and simple-knn, GVHMR, NLF's models, SMPL-X, and the Wan2.2
  Turbo LoRA (CC BY-NC-SA 4.0). DINOv3 has its own custom license.
- **Copyleft:** Ultralytics YOLOv8 (AGPL-3.0), Stockfish (GPL-3.0), plyfile (GPL-3.0).
- **Share-alike media:** Jason Han's videos (CC BY-SA 4.0), Carlsen (CC BY-SA 3.0), Juice WRLD (CC BY-SA 2.0): the
  reconstructions made from them are shared under the same license when distributed.
- **Never redistributed:** SMPL-X files, model weights, LeBron's clip, private family media.

## Attribution and release checks

- Keep the exact source links above in the Devpost and the video description. Next to each CC BY-SA person, give
  the creator, the license link and “adapted: reconstructed in 3D”.
- Public figures appear for the demo only, from real footage or freely licensed photos, always labelled, never with
  their voice or words written for them, and never implying endorsement.
- For a team or family asset, record only an anonymous ID and scope in [consent.md](consent.md). Written consent,
  original media and private links stay outside this repository.
- Before release, clear every **pending** row: the piano file, the Fischer file, the Pexels creators, LeBron's
  permission record.
