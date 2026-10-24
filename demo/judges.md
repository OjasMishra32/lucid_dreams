# Judge Q&A

Owner: Atina. Answers below are deliberately specific about what has been built and what still needs real-world verification. Replace bracketed values only with verified reports.

## What is Lucid Dreams?

Lucid Dreams turns a video or photo, plus a sentence of intent, into a life-size person in your room. A clip can become a slowed lesson; an approved family photo can become a quiet companion; a chess experience uses Stockfish at a named player’s peak rating, never the real person.

## Why does this fit “Fresh off the frontier”?

4DAnyone was made public in August 2026. It creates consistent multi-view video from one casual video, giving our reconstruction many views of the same moving person. DiGS-Avatar, public in June 2026, gives us a photoreal avatar starting point from one photo. Our research experiment fine-tunes that avatar on 4DAnyone’s generated views and reports held-out fidelity before and after.

## What did you build yourselves?

We built the intake-to-dream pipeline, reconstruction/export flow, bundle players for WebXR and Quest, teach and companion experiences, seen-versus-imagined display, local caption generation, and a manual old-footage restoration tool. The system connects the recent models into one product experience and measures the resulting reconstruction.

## How do you measure fidelity?

We compare held-out renders against their target views with PSNR, SSIM and LPIPS, and inspect render sharpness with variance of the Laplacian. For the final demo we will report only measured values: PSNR [verified value], SSIM [verified value], LPIPS [verified value], sharpness [verified value], seen fraction [verified value], and processing time [verified value]. A visually sharp render alone is not proof of identity fidelity.

## What is real and what is generated?

The source-facing detail is grounded in the input footage. New viewpoints inevitably contain generated detail. The Reality check control tints source-unseen Gaussians blue and shows the measured seen fraction. We do not describe unseen sides or backs as recorded fact.

## How do you handle consent and privacy?

We process photoreal likenesses and voices only with written permission for the intended scope. Consent evidence and raw family media stay private; the public repository uses anonymous record IDs only. A person can decline any use. Public figures appear only through credited footage or licensed photos for the demo; we never clone their voice, make them endorse Lucid Dreams, or claim they are participating.

## Why are there public figures?

They are clearly labelled demonstration references. Buster Keaton and Josephine Baker are sourced from credited public-domain media. Fischer and Carlsen chess moments are labelled “Stockfish at [name]’s peak rating. Not affiliated.” The experience is an engine at a rating, not the person, their voice or their endorsement.

## Does restoration make old footage better?

Our manual restoration tool deinterlaces, lightly denoises and uses Real-ESRGAN 4× upscaling without face-restoration models. On a synthetic engineering test it increased SSIM and edge sharpness but reduced PSNR and introduced some invented texture. That does not prove better identity or 3D reconstruction. We keep it opt-in until matched Keaton/Baker and consenting-person A/B reconstruction tests support its use.

## What are the main limitations?

The best input has one full-body subject, stable camera, bright even light and a sharp 5–10 second clip. Fast motion blur, occlusions and unseen body regions remain difficult. A photo avatar starts with even less observed detail. Reconstruction takes compute and is not yet an instant mobile feature.

## What happens next?

We will complete matched restoration and reconstruction comparisons, improve fidelity around hands and fast motion, test the Quest build in a real room, and expand consented companion and coaching experiences. Any change to automatic restoration will wait for that evidence.
