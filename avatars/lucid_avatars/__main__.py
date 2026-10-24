"""Command line: `python -m lucid_avatars validate dreams/<id>`, `... idle motion.json`, `... bake dreams/<id>`,
`... results <run>-tuned.work`, `... head-swap dreams/<id> heads/<person>/heads --person <person> ...`,
`... blink dreams/<id> --smplx ...`, `... lips dreams/<person>-head --person <person> ...` (their own voice moves their
lips)."""

import argparse
import sys

import numpy as np

from .bundle import validate_bundle
from .idle import IDLE_S, idle_loop


def main() -> int:
    parser = argparse.ArgumentParser(prog="lucid_avatars")
    sub = parser.add_subparsers(dest="cmd", required=True)
    v = sub.add_parser("validate", help="check dream bundles against the AGENTS.md contract")
    v.add_argument("bundles", nargs="+")
    i = sub.add_parser("idle", help="write an idle-loop motion.json")
    i.add_argument("out")
    i.add_argument("--seconds", type=float, default=IDLE_S)
    i.add_argument("--fps", type=int, default=30)
    i.add_argument("--stand-y", type=float, default=0.0, help="SMPL-X transl y that puts the soles on y = 0")
    b = sub.add_parser("bake", help="avatar bundle -> replay bundle (posed per frame) for players that can't skin")
    b.add_argument("bundle")
    b.add_argument("--id", help="new bundle id (default <id>-baked, next to the source)")
    b.add_argument("--fps", type=float, default=15.0)
    r = sub.add_parser("results", help="fine-tune work dir -> avatars/README.md Results section + avatars/results/")
    r.add_argument("work", help="the fine-tune's <run>-tuned.work dir (results.md, compare.png)")
    r.add_argument("--max-width", type=int, default=1600, help="renders wider than this are scaled down")
    h = sub.add_parser("head-swap", help="avatar bundle + LAM head -> <id>-head bundle (consenting people only)")
    h.add_argument("bundle", help="the person's own avatar bundle, dreams/<person>")
    h.add_argument("heads", help="lam-head.sbatch's heads/ folder for this person")
    h.add_argument("--person", required=True, help="who the face belongs to; must be in head_swap.CONSENTED")
    h.add_argument("--smplx", required=True, help="SMPLX_NEUTRAL.npz (the model DiGS used)")
    h.add_argument("--flame-ids", required=True, help="SMPL-X__FLAME_vertex_ids.npy")
    h.add_argument("--photo", help="which LAM head, <person>-<photo> (default the person's first)")
    h.add_argument("--id", help="new bundle id (default <id>-head, next to the source)")
    h.add_argument("--held", help="another dreams/.held to honour too (the one next to the bundle always counts)")
    h.add_argument("--seam-offset", type=float, default=0.0, help="move the jaw-line seam up (+) or down, metres")
    h.add_argument("--flame-expr", help="FLAME extract from flame_expr_npz.py: adds avatar/expr.bin (expressions and "
                   "this face's blink) and the 20 s living idle")
    h.add_argument("--keep-motion", action="store_true", help="keep the source's motion.json even if it is an idle")
    bl = sub.add_parser("blink", help="any SMPL-X avatar bundle -> blinks (avatar/expr.bin) and the 20 s living idle, "
                        "in place")
    bl.add_argument("bundle", help="the bundle to update, dreams/<id>")
    bl.add_argument("--smplx", required=True, help="SMPLX_NEUTRAL.npz (the model the avatar was built with)")
    bl.add_argument("--flame-ids", required=True, help="SMPL-X__FLAME_vertex_ids.npy")
    bl.add_argument("--flame-expr", required=True, help="FLAME extract from flame_expr_npz.py")
    bl.add_argument("--keep-motion", action="store_true", help="keep the bundle's motion.json even if it is an idle")
    lp = sub.add_parser("lips", help="head-swapped bundle + a person's own voice -> <id>-voice bundle whose lips follow "
                        "it (voice-consenting people only)")
    lp.add_argument("bundle", help="the person's head swap, dreams/<person>-head (with FLAME, so it has expr.bin)")
    lp.add_argument("--person", required=True, help="whose voice and face; must be in head_swap.VOICE_CONSENTED")
    lp.add_argument("--id", help="new bundle id (default <id>-voice, next to the source)")
    lp.add_argument("--held", help="another dreams/.held to honour too (the one next to the bundle always counts)")
    lp.add_argument("--check", action="store_true", help="run the consent gate only (hpg/lips.sbatch does, first)")
    lp.add_argument("--heads", help="lam-head.sbatch's heads/ folder for this person")
    lp.add_argument("--photo", help="which LAM head (default: the one the head swap used, head_swap.json)")
    lp.add_argument("--smplx", help="SMPLX_NEUTRAL.npz")
    lp.add_argument("--flame-ids", help="SMPL-X__FLAME_vertex_ids.npy")
    lp.add_argument("--flame-expr", help="flame_expr_npz.py's FLAME extract")
    lp.add_argument("--arkit", help="arkit_on_flame_npz.py's ARKit-on-FLAME extract")
    lp.add_argument("--a2e-json", help="LAM_Audio2Expression's save_json_path file for the audio")
    lp.add_argument("--voice", help="the audio as .m4a: becomes the bundle's voice.m4a")
    uc = sub.add_parser("uika-check", help="the head distill's consent gate for the teacher step (hpg/uika-head.sbatch)")
    uc.add_argument("--person", required=True, help="whose face; must be in head_swap.CONSENTED")
    uc.add_argument("--photos", required=True, help="their own photos, data/avatars/faces/<person>")
    uc.add_argument("--out", required=True, help="their own teacher folder, data/avatars/heads/<person>/uika")
    uc.add_argument("--held", required=True, help="dreams/.held")
    dc = sub.add_parser("distill-check", help="the head distill's consent gate (hpg/head-distill.sbatch)")
    dc.add_argument("bundle", help="the person's own avatar bundle, dreams/<person>")
    dc.add_argument("--person", required=True, help="whose face; must be in head_swap.CONSENTED")
    dc.add_argument("--teacher", required=True, help="their own teacher folder, data/avatars/heads/<person>/uika")
    dc.add_argument("--id", required=True, help="the new bundle's id, <person>-...")
    dc.add_argument("--held", help="another dreams/.held to honour too (the one next to the bundle always counts)")
    args = parser.parse_args()

    if args.cmd in ("uika-check", "distill-check"):
        from . import head_distill_core as D

        if args.cmd == "uika-check":
            refused = D.teacher_consent_errors(args.person, args.photos, args.out, args.held)
            ok = f"consent OK: {args.person}'s own photos -> {args.out}"
        else:
            refused = D.distill_consent_errors(args.person, args.bundle, args.teacher, args.held, args.id)
            ok = f"consent OK: {args.person}'s teacher -> {args.id}"
        print("REFUSED" if refused else ok, *refused, sep="\n     ")
        return 2 if refused else 0

    if args.cmd == "lips":
        import json
        from pathlib import Path

        from . import head_swap as H
        from .lips import lips_bundle

        src = Path(args.bundle)
        new_id = args.id or f"{src.name}-voice"
        refused = H.voice_consent_errors(args.person, src, args.held, new_id)
        if refused:
            print("REFUSED", *refused, sep="\n     ")
            return 2
        if args.check:
            print(f"consent OK: {args.person}'s voice may drive {src.name} -> {new_id}")
            return 0
        need = ("heads", "smplx", "flame_ids", "flame_expr", "arkit", "a2e_json", "voice")
        if missing := [n.replace("_", "-") for n in need if not getattr(args, n)]:
            parser.error("lips needs " + ", ".join("--" + m for m in missing) + " (or --check)")
        try:
            photo = args.photo or json.loads((src / "head_swap.json").read_text())["headPhoto"]
            ply, obj = H.pick_head(args.heads, args.person, photo)
            root = lips_bundle(src, args.person, ply, obj, args.smplx, args.flame_ids, args.flame_expr, args.arkit,
                               args.a2e_json, args.voice, src.parent, new_id, held=args.held)
        except (PermissionError, ValueError, OSError) as e:
            print("REFUSED" if isinstance(e, PermissionError) else "FAILED", e, sep="\n     ")
            return 2 if isinstance(e, PermissionError) else 1
        errors = validate_bundle(root)
        report = json.loads((root / "lips.json").read_text())
        print((root / "lips.json").read_text().strip())
        if not report["meetsTarget"]:
            print(f"WARNING: the 9 channels keep {report['varianceKept']:.1%} of the mouth's motion (want "
                  f"{report['target']:.0%}): look at a render before anyone sees it")
        print(f"{'FAIL' if errors else 'OK  '} {root}", *errors, sep="\n     ")
        return 1 if errors else 0

    if args.cmd == "validate":
        failed = 0
        for b in args.bundles:
            errors = validate_bundle(b)
            print(f"{'FAIL' if errors else 'OK  '} {b}")
            for e in errors:
                print(f"     {e}")
            failed += bool(errors)
        return 1 if failed else 0
    if args.cmd == "bake":
        from pathlib import Path

        from .bake import bake_bundle

        src = Path(args.bundle)
        root = bake_bundle(src, src.parent, args.id or f"{src.name}-baked", fps=args.fps)
        errors = validate_bundle(root)
        print(f"{'FAIL' if errors else 'OK  '} {root}", *errors, sep="\n     ")
        return 1 if errors else 0
    if args.cmd == "results":
        from pathlib import Path

        from .results_page import fill

        here = Path(__file__).resolve().parents[1]
        for c in fill(args.work, here / "README.md", here / "results", args.max_width):
            print(f"wrote {c} ({c.stat().st_size // 1024} KB)")
        print(f"wrote {here / 'README.md'} (Results section)")
        return 0
    if args.cmd == "blink":
        from pathlib import Path

        from . import any_face as A

        src = Path(args.bundle)
        refused = A.held_errors(src)
        if refused:
            print("REFUSED", *refused, sep="\n     ")
            return 2
        try:
            root = A.add_face(src, args.smplx, args.flame_ids, args.flame_expr, keep_motion=args.keep_motion)
        except ValueError as e:
            print("REFUSED", str(e), sep="\n     ")
            return 2
        errors = validate_bundle(root)
        print((root / A.FACE_FILE).read_text().strip())
        print(f"{'FAIL' if errors else 'OK  '} {root}", *errors, sep="\n     ")
        return 1 if errors else 0
    if args.cmd == "head-swap":
        from pathlib import Path

        from . import head_swap as H

        src = Path(args.bundle)
        new_id = args.id or f"{src.name}-head"
        refused = H.consent_errors(args.person, src, args.held, new_id)
        if not refused:
            try:
                ply, obj = H.pick_head(args.heads, args.person, args.photo)
            except ValueError as e:
                refused = [str(e)]
        if refused:
            print("REFUSED", *refused, sep="\n     ")
            return 2
        root = H.swap_bundle(src, ply, obj, args.smplx, args.flame_ids, src.parent, new_id,
                             seam_offset=args.seam_offset, flame_npz=args.flame_expr, keep_motion=args.keep_motion)
        errors = validate_bundle(root)
        print((root / "head_swap.json").read_text().strip())
        print(f"{'FAIL' if errors else 'OK  '} {root}", *errors, sep="\n     ")
        return 1 if errors else 0
    idle_loop(np.zeros(10), args.seconds, args.fps, args.stand_y).save(args.out)
    print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
