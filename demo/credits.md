# Credits and source ledger

Owner: Atina. This public ledger credits every planned demo source and the open-source technology used by Lucid Dreams. It contains links and license terms only; it contains no source media, model weights, private recordings, consent evidence, or credentials.

Before publishing the demo video or Devpost, confirm that each row marked **pending** names the exact asset that actually appears. Do not substitute a similarly named file, infer a license from a search result, or treat a license as consent to clone a person's voice or imply their endorsement.

## Demo media

| Planned use | Source and attribution | License / permitted use | Status |
| --- | --- | --- | --- |
| Buster Keaton restoration and living-room replay | [*Neighbors* (1920), Edward F. Cline and Buster Keaton, Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Neighbors_(Edward_F._Cline_and_Buster_Keaton,_1920).webm) | Public domain in the United States; source page marks it PD-US-expired. | Ready to cite; Ojasva selects and supplies the short processed cut. |
| Josephine Baker restoration candidate | [*Le Pompier des Folies Bergère* (1928), unknown author, Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Le_Pompier_des_Folies_Berg%C3%A8re_(1928).webm) | Public domain on the source page as an anonymous work. Preserve the source attribution. | Ready to cite; use only if its cut is selected. |
| Bobby Fischer avatar reference | [*Bobby Fischer 1972b*, W. Punt for Anefo / Nationaal Archief, Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Bobby_Fischer_1972b.jpg) | [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/). | Ready to cite. The chess experience must say: “Stockfish at Fischer's peak rating. Not affiliated.” |
| Magnus Carlsen avatar reference | [*Magnus Carlsen (2012)*, Autopilot, Wikimedia Commons](https://commons.wikimedia.org/wiki/File:Magnus_Carlsen_(2012).jpg) | [CC BY-SA 3.0](https://creativecommons.org/licenses/by-sa/3.0/): credit Autopilot, link the license, state edits, and keep any distributed derivative under the same or a compatible license. | Ready to cite. The chess experience must say: “Stockfish at Carlsen's peak rating. Not affiliated.” |
| Two Pexels jump-shot replays | Exact Pexels item URLs and creator names are still needed from Ojasva’s queued files. | [Pexels License](https://www.pexels.com/license/): free to use and modify, with no implied endorsement or standalone redistribution. | **Pending exact source URLs before release.** |
| LeBron jump-shot replay | Ojasva-supplied clip for this non-commercial hackathon demonstration. It is not redistributed in this repository. | Limited demo permission reported by the team; no voice cloning, synthetic speech, or endorsement claim. | **Pending Ojasva’s private permission record and final-use confirmation.** |
| Consented teammate and family media | Private, consented originals; anonymous consent records live in [consent.md](consent.md). | Only the written permissions recorded for that asset. | **Pending selection and written approval.** Never publish private evidence here. |

## Open-source code and models

| Component | Role in Lucid Dreams | License / terms |
| --- | --- | --- |
| [4DAnyone](https://github.com/ant-research/4DAnyone) | Single video to consistent multi-view video; core replay input. | Apache-2.0 for first-party code. Follow its third-party notices and model terms. |
| [DiGS-Avatar](https://github.com/KLMAV-CUC/DiGS-Avatar) | One-photo Gaussian avatar and the starting point for fine-tuning. | MIT. |
| [gsplat](https://github.com/nerfstudio-project/gsplat) | Gaussian reconstruction and rasterization support. | Apache-2.0. |
| [Spark](https://github.com/sparkjsdev/spark) and [three.js](https://github.com/mrdoob/three.js) | Browser / WebXR Gaussian and scene rendering. | Spark: use its package license; three.js: MIT. Confirm the exact Spark package version and license text in the final dependency lockfile before release. |
| [Unity VR Gaussian Splatting](https://github.com/ninjamode/Unity-VR-Gaussian-Splatting) | Quest Gaussian renderer reference/base. | MIT. |
| [NLF](https://github.com/isarandi/nlf) | SMPL-X body fitting for avatars. | Code: MIT; model assets: non-commercial research terms. |
| [rembg](https://github.com/danielgatis/rembg) | Avatar matte extraction. | MIT. |
| [GVHMR](https://github.com/zju3dv/GVHMR) | Supporting body-motion estimate inside the replay pipeline. | Follow upstream research / non-commercial terms and 4DAnyone's third-party notices. |
| [BiRefNet](https://github.com/ZhengPeng7/BiRefNet) | Person segmentation used in view preparation. | MIT. |
| [SMPL-X](https://smpl-x.is.tue.mpg.de/) | Avatar skeleton and body model. | Model license requires acceptance; never commit or redistribute the model files. |
| [whisper.cpp](https://github.com/ggml-org/whisper.cpp) | Local speech transcription and word timestamps for captions. | MIT. Whisper weights remain outside the repository and follow their own model terms. |
| [Real-ESRGAN ncnn Vulkan](https://github.com/xinntao/Real-ESRGAN-ncnn-vulkan) and [Real-ESRGAN](https://github.com/xinntao/Real-ESRGAN) | Manual 4× old-footage restoration test. | ncnn Vulkan wrapper: MIT; upstream Real-ESRGAN: BSD-3-Clause. No face-restoration model is used. |
| [FFmpeg](https://ffmpeg.org/) | Media decoding, deinterlacing, denoising and muxing. | License depends on the build configuration; Atina’s Homebrew build enables GPL components. |
| [Stockfish](https://github.com/official-stockfish/Stockfish) | The chess engine behind the rated chess side mode. | GPL-3.0-or-later; never describe its ratings as the real people. |

## Attribution and release checks

- Keep the exact source links above in Devpost and the demo-video description. Add creator name, license link and any required adaptation / share-alike notice next to a CC BY-SA asset.
- Preserve the public-figure labels in the media table everywhere those assets appear. The source license does not authorize voice cloning or a claim that someone endorses Lucid Dreams.
- The `apps/site` chess-board model has its own [asset credit](../apps/site/public/assets/CREDITS.md); keep that file with any public site deployment.
- For a team or family asset, record only an anonymous ID and scope in [consent.md](consent.md). Written consent, original media and private links remain outside this repository.
