import json
import shutil

import numpy as np
import pytest

from test_face_expr import place_eyes

from lucid_avatars import face_expr as F
from lucid_avatars import head_swap as H
from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
from lucid_avatars.gaussian_ply import SH_C0, Gaussians, read_ply, write_ply
from lucid_avatars.idle import idle_loop
from lucid_avatars.motion import Motion
from lucid_avatars.skinning import quantize_top4, read_skin_bin, skeleton_dict
from lucid_avatars.smplx_layout import NUM_JOINTS, J


def _rot(axis, angle):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * K @ K


EYES_AT = [np.array([0.032, 0.36, 0.06]), np.array([-0.032, 0.36, 0.06])]


def _gaussians(xyz, rgb=0.5, alpha=0.9):
    n = len(xyz)
    return Gaussians(xyz=np.asarray(xyz, float), f_dc=np.full((n, 3), (rgb - 0.5) / SH_C0), f_rest=np.zeros((n, 0)),
                     opacity=np.full(n, np.log(alpha / (1 - alpha))), scale=np.full((n, 3), np.log(0.01)),
                     rotation=np.tile([1.0, 0, 0, 0], (n, 1)))


def test_umeyama_recovers_a_similarity():
    rng = np.random.default_rng(0)
    src = rng.normal(size=(200, 3))
    R, s, t = _rot([1, 2, 3], 0.7), 0.83, np.array([0.1, 1.5, -0.2])
    dst = s * src @ R.T + t
    s2, R2, t2 = H.umeyama(src, dst)
    assert s2 == pytest.approx(s) and np.allclose(R2, R) and np.allclose(t2, t)


def test_transform_gaussians_moves_means_turns_rotations_and_scales_sizes():
    g = _gaussians([[1.0, 0, 0]])
    g.rotation[:] = [np.cos(0.2), np.sin(0.2), 0, 0]  # 0.4 rad about x, [w, x, y, z]
    R, s, t = _rot([0, 0, 1], np.pi / 2), 2.0, np.array([0, 1.0, 0])
    out = H.transform_gaussians(g, s, R, t)
    np.testing.assert_allclose(out.xyz, [[0, 3.0, 0]], atol=1e-12)
    np.testing.assert_allclose(np.exp(out.scale), [[0.02] * 3])
    np.testing.assert_allclose(H.wxyz_to_matrix(out.rotation)[0], R @ _rot([1, 0, 0], 0.4), atol=1e-12)


def test_lam_head_reads_positions_from_the_textured_mesh_and_rgb_as_sh(tmp_path):
    n = H.FLAME_VERTS + 7
    rng = np.random.default_rng(1)
    pos = rng.normal(size=(n, 3))
    offset = rng.normal(scale=0.01, size=(n, 3))
    rgb = rng.uniform(0, 1, size=(n, 3))
    lam = _gaussians(offset)  # LAM writes the offsets in x, y, z and RGB in f_dc (gs_use_rgb)
    lam.f_dc = rgb
    write_ply(tmp_path / "me-a_gs_offset.ply", lam)
    (tmp_path / "me-a_textured_mesh.obj").write_text(
        "# x\n\n" + "".join(f"v {p[0]:.8f} {p[1]:.8f} {p[2]:.8f} 0.5 0.5 0.5\n" for p in pos) + "\nf 1 2 3\n")
    head, base = H.lam_head(tmp_path / "me-a_gs_offset.ply", tmp_path / "me-a_textured_mesh.obj")
    np.testing.assert_allclose(head.xyz, pos, atol=1e-6)
    np.testing.assert_allclose(0.5 + SH_C0 * head.f_dc, rgb, atol=1e-6)
    np.testing.assert_allclose(base, pos - offset, atol=1e-6)  # every Gaussian's vertex; FLAME's mesh comes first


def test_lam_head_refuses_a_mesh_that_doesnt_match(tmp_path):
    write_ply(tmp_path / "a_gs_offset.ply", _gaussians(np.zeros((H.FLAME_VERTS + 1, 3))))
    (tmp_path / "a_textured_mesh.obj").write_text("v 0 0 0\n")
    with pytest.raises(ValueError, match="vertices"):
        H.lam_head(tmp_path / "a_gs_offset.ply", tmp_path / "a_textured_mesh.obj")


def test_cross_fade_drops_the_old_head_and_the_new_neck():
    seam, band = 0.2, 0.03
    body = _gaussians([[0, 0.25, 0], [0, 0.25, 0.1], [0, 0.19, 0], [0, 0.10, 0], [0, 0.25, 0]])
    dominant = np.array([J["head"], J["jaw"], J["neck"], J["neck"], J["left_shoulder"]])
    head = _gaussians([[0, 0.25, 0], [0, 0.185, 0], [0, 0.15, 0]])
    b, keep_b, h, keep_h = H.cross_fade(body, dominant, head, seam, band)
    assert keep_b.tolist() == [False, False, True, True, True]  # head and jaw above the seam go; the rest stays
    alpha = lambda g: 1 / (1 + np.exp(-g.opacity))  # noqa: E731
    assert alpha(b)[0] == pytest.approx(0.9 * (0.2 - 0.19) / 0.03)  # neck in the band fades out toward the seam
    assert alpha(b)[1] == pytest.approx(0.9) and alpha(b)[2] == pytest.approx(0.9)  # below the band, a shoulder
    assert keep_h.tolist() == [True, True, False]  # the new head's neck below the band goes
    assert alpha(h)[0] == pytest.approx(0.9) and alpha(h)[1] == pytest.approx(0.9 * 0.5)


def test_nearest_vertex_skin_takes_that_vertex_weights():
    verts = np.array([[0, 0, 0], [1, 0, 0], [0, 1, 0.0]])
    lbs = np.zeros((3, NUM_JOINTS))
    lbs[0, J["head"]], lbs[1, J["neck"]] = 1, 1
    lbs[2, J["head"]], lbs[2, J["jaw"]] = 0.75, 0.25
    idx, q = H.nearest_vertex_skin(np.array([[0.9, 0.1, 0], [0.05, 0.9, 0]]), verts, lbs)
    assert idx[0, 0] == J["neck"] and q[0, 0] == 255
    assert dict(zip(idx[1][q[1] > 0], q[1][q[1] > 0])) == {J["head"]: 191, J["jaw"]: 64}


def test_lab_round_trip_and_tone_match_moves_the_ring_to_the_body():
    rng = np.random.default_rng(3)
    rgb = rng.uniform(0.05, 0.95, size=(500, 3))
    np.testing.assert_allclose(H.lab_to_rgb(H.rgb_to_lab(rgb)), rgb, atol=1e-6)
    body_ring = rng.normal([0.75, 0.55, 0.45], 0.03, size=(300, 3))
    head_rgb = rng.normal([0.55, 0.40, 0.35], 0.05, size=(400, 3))
    ring = np.arange(400) < 200
    out = H.match_tone(head_rgb, ring, body_ring)
    np.testing.assert_allclose(H.rgb_to_lab(out[ring]).mean(0), H.rgb_to_lab(body_ring).mean(0), atol=0.5)


def test_tone_match_keeps_dark_brown_eyes_brown_and_never_amplifies_colour():
    """Ian's grandma came out blue-eyed: scaling the head's colour spread up to the body's (x2 at most) pushed
    everything that isn't skin (brown eyes, warm grey hair, lips) through grey toward blue and purple."""
    rng = np.random.default_rng(5)
    skin = rng.normal([0.78, 0.60, 0.50], 0.005, size=(300, 3))  # LAM's smooth neck: very little colour spread
    eye, hair = np.array([[0.30, 0.20, 0.14]]), np.array([[0.74, 0.71, 0.67]])  # dark brown, warm grey
    head_rgb = np.concatenate([skin, eye, hair])
    ring = np.arange(len(head_rgb)) < 300
    body_ring = rng.normal([0.76, 0.58, 0.47], 0.05, size=(300, 3))  # DiGS's neck: much more spread
    out = H.match_tone(head_rgb, ring, body_ring)
    lab_in, lab_out = H.rgb_to_lab(head_rgb), H.rgb_to_lab(out)
    shift = lab_out[ring].mean(0) - lab_in[ring].mean(0)
    np.testing.assert_allclose(lab_out[300:] - lab_in[300:], np.tile(shift, (2, 1)), atol=0.05)  # a shift, no stretch
    a, b = lab_out[300, 1:]
    assert a > 0 and b > 0  # still brown, not blue
    unweighted = H.match_tone(head_rgb, ring, body_ring, weight=np.r_[np.ones(300), 0.0, 0.0])
    np.testing.assert_allclose(unweighted[300:], head_rgb[300:], atol=1e-6)  # weight 0: LAM's colour untouched


def _synthetic_body(tmp_path):
    """A tiny SMPL-X-like model: a column of vertices, the top ones the FLAME head, joints regressed from them."""
    rng = np.random.default_rng(4)
    n_body, n_head = 400, H.FLAME_VERTS
    body_v = np.column_stack([rng.uniform(-0.2, 0.2, n_body), rng.uniform(-1.3, 0.15, n_body),
                              rng.uniform(-0.1, 0.1, n_body)])
    head_v = np.column_stack([rng.uniform(-0.08, 0.08, n_head), rng.uniform(0.12, 0.45, n_head),
                              rng.uniform(-0.09, 0.11, n_head)])
    for c in EYES_AT:  # FLAME-like eyes (face_expr needs a real opening to shut), the rest kept clear of them
        near = np.linalg.norm(head_v - c, axis=1) < 0.03
        head_v[near] += (head_v[near] - c) / np.linalg.norm(head_v[near] - c, axis=1, keepdims=True) * 0.03
    place_eyes(head_v, EYES_AT, rng)
    joints = np.zeros((NUM_JOINTS, 3))
    joints[:, 1] = np.linspace(-1.2, 0.1, NUM_JOINTS)
    joints[J["neck"]], joints[J["head"]], joints[J["jaw"]] = [0, 0.11, 0], [0, 0.27, 0], [0, 0.22, 0.04]
    # one extra vertex per joint (after the head), so J_regressor @ verts reproduces the skeleton exactly
    verts = np.concatenate([body_v, head_v, joints])
    Jr = np.zeros((NUM_JOINTS, len(verts)))
    Jr[np.arange(NUM_JOINTS), n_body + n_head + np.arange(NUM_JOINTS)] = 1
    lbs = np.zeros((len(verts), NUM_JOINTS))
    lbs[:n_body, J["spine3"]] = 1
    lbs[n_body + n_head:, J["spine3"]] = 1
    lbs[n_body:n_body + n_head, J["head"]] = 1
    lbs[n_body + np.flatnonzero(head_v[:, 1] < 0.18), J["neck"]] = 1
    lbs[n_body + np.flatnonzero(head_v[:, 1] < 0.18), J["head"]] = 0
    np.savez(tmp_path / "SMPLX_NEUTRAL.npz", v_template=verts, shapedirs=np.zeros((len(verts), 3, 10)),
             J_regressor=Jr, weights=lbs)
    flame_ids = np.arange(n_body, n_body + n_head)
    np.save(tmp_path / "SMPL-X__FLAME_vertex_ids.npy", flame_ids)
    # the avatar: Gaussians on the vertices, skinned to the vertex they sit on
    g = _gaussians(verts + rng.normal(scale=0.003, size=verts.shape), rgb=0.7)
    idx, q = H.nearest_vertex_skin(g.xyz, verts, lbs)
    root = write_avatar_bundle(tmp_path / "dreams", "vishal", "Vishal", g, idle_loop(np.zeros(10), 1.0, 10),
                               skin=(idx, q), skeleton=skeleton_dict(joints))
    return root, verts, flame_ids


def test_swap_puts_the_lam_head_on_the_avatar_and_writes_a_valid_bundle(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    # LAM's head: the avatar's own FLAME vertices in another frame (turned, scaled, moved), darker skin
    R, s, t = _rot([0, 1, 0], 0.3), 1.12, np.array([0.02, -0.3, 0.05])
    flame_lam = (verts[flame_ids] - t) @ R / s  # so s R x + t gives back the avatar's head
    lam = _gaussians(np.zeros_like(flame_lam))
    lam.f_dc = np.full((len(flame_lam), 3), 0.4)  # RGB, as LAM stores it
    write_ply(tmp_path / "vishal-a_gs_offset.ply", lam)
    (tmp_path / "vishal-a_textured_mesh.obj").write_text("".join(f"v {p[0]} {p[1]} {p[2]}\n" for p in flame_lam))

    out = H.swap_bundle(root, tmp_path / "vishal-a_gs_offset.ply", tmp_path / "vishal-a_textured_mesh.obj",
                        tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy",
                        tmp_path / "dreams", "vishal-head")
    assert out.name == "vishal-head" and validate_bundle(out) == []
    report = json.loads((out / "head_swap.json").read_text())
    assert report["alignRmsM"] < 1e-6 and report["scale"] == pytest.approx(s)
    g = read_ply(out / "avatar" / "avatar.ply")
    idx, _ = read_skin_bin(out / "avatar" / "skin.bin")
    assert len(idx) == len(g) == report["bodyKept"] + report["headKept"]
    new = g.xyz[report["bodyKept"]:]
    assert new[:, 1].min() >= report["seamY"] - report["bandM"] - 1e-9  # the new head starts at the seam
    rgb = 0.5 + SH_C0 * g.f_dc[report["bodyKept"]:]
    y = new[:, 1]
    at_seam, face = y <= report["seamY"], y >= report["seamY"] + H.TONE_FADE_M
    assert at_seam.any() and face.any()
    assert np.abs(rgb[at_seam] - 0.7).max() < 0.02  # the neck is toned to the body's skin
    assert np.abs(rgb[face] - 0.4).max() < 1e-3  # the face keeps LAM's colours, from her close-up
    assert report["toneShiftLab"] and len(report["toneShiftLab"]) == 3
    # the old face (head, jaw, eyes) and neck never show above the seam; anything else left there is counted by joint
    above = report["bodyVisibleAboveSeam"]
    assert not {"head", "jaw", "left_eye", "right_eye", "neck"} & set(above)
    assert set(above) <= {"spine3"} and sum(above.values()) <= 3  # only the synthetic body's spine3 helper vertices
    dream = json.loads((out / "dream.json").read_text())
    assert dream["id"] == "vishal-head" and dream["source"]["head"]["model"].startswith("LAM")
    assert 0 < dream["metrics"]["seenFraction"] < 1 and (out / dream["avatar"]["reality"]).exists()
    assert dream["preview"] is None and not (out / "preview.mp4").exists()  # the old face's turntable is gone


def test_swap_refuses_a_skeleton_that_isnt_this_smplx(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    sk = json.loads((root / "avatar" / "skeleton.json").read_text())
    sk["rest"][J["head"]][1] += 0.05
    (root / "avatar" / "skeleton.json").write_text(json.dumps(sk))
    write_ply(tmp_path / "a_gs_offset.ply", _gaussians(np.zeros((len(flame_ids), 3))))
    (tmp_path / "a_textured_mesh.obj").write_text("".join(f"v {p[0]} {p[1]} {p[2]}\n" for p in verts[flame_ids]))
    with pytest.raises(ValueError, match="skeleton"):
        H.swap_bundle(root, tmp_path / "a_gs_offset.ply", tmp_path / "a_textured_mesh.obj",
                      tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy", tmp_path / "dreams",
                      "x-head")


def _lam_head_files(heads, stem, flame):
    heads.mkdir(parents=True, exist_ok=True)
    write_ply(heads / f"{stem}_gs_offset.ply", _gaussians(np.zeros_like(flame)))
    (heads / f"{stem}_textured_mesh.obj").write_text("".join(f"v {p[0]} {p[1]} {p[2]}\n" for p in flame))


def test_consent_allows_a_listed_person_on_their_own_avatar_only(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    assert H.consent_errors("vishal", root) == []
    assert any("consent" in e for e in H.consent_errors("bobby-fischer", root))
    other = tmp_path / "dreams" / "ian"
    shutil.copytree(root, other)
    dream = json.loads((other / "dream.json").read_text())
    (other / "dream.json").write_text(json.dumps({**dream, "id": "ian"}))
    assert any("own avatar" in e for e in H.consent_errors("vishal", other))  # no one's face on someone else's body


def test_consent_honours_dreams_held(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    (tmp_path / "dreams" / ".held").write_text("bobby-fischer\nvishal\n")
    assert any(".held" in e for e in H.consent_errors("vishal", root))


def test_pick_head_takes_the_persons_named_photo_or_their_first_and_needs_the_textured_mesh(tmp_path):
    heads = tmp_path / "heads"
    with pytest.raises(ValueError, match="no LAM head"):
        H.pick_head(heads, "vishal")
    flame = np.zeros((H.FLAME_VERTS, 3))
    _lam_head_files(heads, "vishal-b", flame)
    _lam_head_files(heads, "vishal-a", flame)
    _lam_head_files(heads, "magnus-a", flame)  # someone else's head in the same folder is never picked
    assert H.pick_head(heads, "vishal") == (heads / "vishal-a_gs_offset.ply", heads / "vishal-a_textured_mesh.obj")
    assert H.pick_head(heads, "vishal", "vishal-b")[0] == heads / "vishal-b_gs_offset.ply"
    (heads / "vishal-a_textured_mesh.obj").unlink()
    with pytest.raises(ValueError, match="textured_mesh"):
        H.pick_head(heads, "vishal", "vishal-a")


@pytest.mark.parametrize("photo", ["magnus-a", "*", "vishal-*", "../other/vishal-a", "vishal-a/../magnus-a"])
def test_pick_head_refuses_another_persons_head_globs_and_paths(tmp_path, photo):
    flame = np.zeros((H.FLAME_VERTS, 3))
    _lam_head_files(tmp_path / "heads", "magnus-a", flame)
    _lam_head_files(tmp_path / "other", "vishal-a", flame)
    with pytest.raises(ValueError):
        H.pick_head(tmp_path / "heads", "vishal", photo)


def test_consent_refuses_an_output_id_that_isnt_a_new_head_bundle_of_theirs(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    assert H.consent_errors("vishal", root, new_id="vishal-head") == []
    for bad in ("ian", "vishal", "../vishal-head", "vishal-head/x", "Vishal-Head"):
        assert H.consent_errors("vishal", root, new_id=bad), bad
    (tmp_path / "dreams" / "vishal-other").mkdir()  # an existing bundle the swap didn't write is never replaced
    assert any("not a head swap" in e for e in H.consent_errors("vishal", root, new_id="vishal-other"))


def test_consent_refuses_a_bundle_whose_folder_and_id_disagree(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    moved = root.rename(root.parent / "ian")  # Ian's folder, a dream.json that says vishal
    assert any("folder" in e for e in H.consent_errors("vishal", moved))


def test_consent_held_flag_adds_to_the_bundles_held_list_never_replaces_it(tmp_path):
    root, _, _ = _synthetic_body(tmp_path)
    (tmp_path / "dreams" / ".held").write_text("vishal\n")
    (tmp_path / "empty").write_text("")
    assert any(".held" in e for e in H.consent_errors("vishal", root, held=tmp_path / "empty"))


def test_cli_head_swap_refuses_without_consent_and_writes_nothing(tmp_path, monkeypatch, capsys):
    from lucid_avatars.__main__ import main

    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_head_files(tmp_path / "heads", "magnus-a", verts[flame_ids])
    monkeypatch.setattr("sys.argv", ["lucid_avatars", "head-swap", str(root), str(tmp_path / "heads"),
                                     "--person", "magnus-carlsen", "--smplx", str(tmp_path / "SMPLX_NEUTRAL.npz"),
                                     "--flame-ids", str(tmp_path / "SMPL-X__FLAME_vertex_ids.npy")])
    assert main() == 2
    assert "REFUSED" in capsys.readouterr().out
    assert sorted(p.name for p in (tmp_path / "dreams").iterdir()) == ["vishal"]


def test_cli_head_swap_writes_and_validates_the_new_bundle(tmp_path, monkeypatch, capsys):
    from lucid_avatars.__main__ import main

    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_head_files(tmp_path / "heads", "vishal-a", verts[flame_ids])
    monkeypatch.setattr("sys.argv", ["lucid_avatars", "head-swap", str(root), str(tmp_path / "heads"),
                                     "--person", "vishal", "--smplx", str(tmp_path / "SMPLX_NEUTRAL.npz"),
                                     "--flame-ids", str(tmp_path / "SMPL-X__FLAME_vertex_ids.npy")])
    assert main() == 0
    out = tmp_path / "dreams" / "vishal-head"
    assert "OK" in capsys.readouterr().out and validate_bundle(out) == []
    assert json.loads((out / "head_swap.json").read_text())["headPhoto"] == "vishal-a"


def _cli(monkeypatch, root, tmp_path, *extra):
    from lucid_avatars.__main__ import main

    monkeypatch.setattr("sys.argv", ["lucid_avatars", "head-swap", str(root), str(tmp_path / "heads"),
                                     "--smplx", str(tmp_path / "SMPLX_NEUTRAL.npz"),
                                     "--flame-ids", str(tmp_path / "SMPL-X__FLAME_vertex_ids.npy"), *extra])
    return main()


def test_cli_head_swap_refuses_held_people_and_someone_elses_head(tmp_path, monkeypatch, capsys):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_head_files(tmp_path / "heads", "magnus-a", verts[flame_ids])
    assert _cli(monkeypatch, root, tmp_path, "--person", "vishal") == 2  # only magnus's head is there
    (tmp_path / "dreams" / ".held").write_text("vishal\n")
    _lam_head_files(tmp_path / "heads", "vishal-a", verts[flame_ids])
    assert _cli(monkeypatch, root, tmp_path, "--person", "vishal") == 2
    assert capsys.readouterr().out.count("REFUSED") == 2
    assert sorted(p.name for p in (tmp_path / "dreams").iterdir()) == [".held", "vishal"]


# ---------------- life in the face: expr.bin, the living idle, skinning by correspondence ----------------

FACES = np.concatenate([place_eyes(np.zeros((H.FLAME_VERTS, 3)), EYES_AT, np.random.default_rng(0)),
                        [[0, 1, 2], [3, 4, 5], [3000, 3001, 3002]]])
MID_EDGES = [(0, 1), (3, 4), (3001, 3002)]


def _lam_with_flame(tmp_path, verts, flame_ids, R=None, s=1.12, t=(0.02, -0.3, 0.05)):
    """LAM's head (FLAME's vertices + three edge midpoints, in LAM's frame) and a FLAME npz whose template is the same
    mesh in yet another frame, whose expression 0 moves every vertex 1 mm along FLAME's +x."""
    R = _rot([0, 1, 0], 0.3) if R is None else R
    t = np.asarray(t)
    flame_lam = (verts[flame_ids] - t) @ R / s
    base = np.concatenate([flame_lam, [(flame_lam[a] + flame_lam[b]) / 2 for a, b in MID_EDGES]])
    lam = _gaussians(np.zeros_like(base))
    lam.f_dc = np.full((len(base), 3), 0.4)
    write_ply(tmp_path / "vishal-a_gs_offset.ply", lam)
    (tmp_path / "vishal-a_textured_mesh.obj").write_text("".join(f"v {p[0]} {p[1]} {p[2]}\n" for p in base))
    R0, k, t0 = _rot([1, 0, 0], -0.2), 0.9, np.array([0.0, 0.1, -0.05])  # LAM = k R0 FLAME + t0
    dirs = np.zeros((H.FLAME_VERTS, 3, 100))
    dirs[:, 0, 0] = 1e-3
    np.savez(tmp_path / "flame.npz", v_template=(flame_lam - t0) @ R0 / k, faces=FACES, expr_dirs=dirs)
    return (s, R, t), (k, R0), base


def _swap(tmp_path, root, **kw):
    return H.swap_bundle(root, tmp_path / "vishal-a_gs_offset.ply", tmp_path / "vishal-a_textured_mesh.obj",
                         tmp_path / "SMPLX_NEUTRAL.npz", tmp_path / "SMPL-X__FLAME_vertex_ids.npy", tmp_path / "dreams",
                         "vishal-head", **kw)


def test_swap_writes_expr_bin_in_the_avatars_frame_and_a_living_idle(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    (s, R, _), (k, R0), base = _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    assert validate_bundle(out) == []
    dream = json.loads((out / "dream.json").read_text())
    report = json.loads((out / "head_swap.json").read_text())
    assert dream["avatar"]["expr"] == F.EXPR_FILE and dream["avatar"]["exprChannels"] == list(F.EXPR_CHANNELS)
    first, d = F.read_expr_bin(out / F.EXPR_FILE)
    assert first == report["bodyKept"] and len(d) == report["headKept"]
    want = s * R @ (k * R0 @ [1e-3, 0, 0])  # FLAME's frame -> LAM's -> the avatar's
    np.testing.assert_allclose(d[:, 0], np.tile(want, (len(d), 1)), atol=2e-6)
    assert report["expr"]["subdivision"] == {"matched": len(MID_EDGES), "unmatched": 0}
    assert set(report["expr"]["blink"]) == {"openFraction", "pcaShare", "leakMm"}
    assert report["expr"]["blink"]["openFraction"] < 0.1  # the fitted blink shuts these eyes
    # the source's idle is now the living one: 20 s, blinking through the blink channel only
    m = Motion.load(out / dream["avatar"]["motion"])
    assert report["motion"] == "living idle" and m.num_frames / m.fps == pytest.approx(20.0)
    assert dream["frameCount"] == m.num_frames and dream["durationS"] == pytest.approx(20.0)
    assert np.abs(np.delete(m.expr, F.BLINK, axis=1)).max() == 0 and m.expr[:, F.BLINK].max() == 1.0
    src = Motion.load(root / "avatar" / "motion.json")
    np.testing.assert_allclose(m.betas, src.betas)
    np.testing.assert_allclose(np.median(m.root_t[:, 1]), np.median(src.root_t[:, 1]), atol=1e-6)


def test_swap_never_replaces_a_performance(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    dream = json.loads((root / "dream.json").read_text())
    dream["source"] = {"avatar": "vishal.work/code.pt", "motion": "runs/lebron-jumper/views/gvhmr"}  # digs-perform
    (root / "dream.json").write_text(json.dumps(dream))
    _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    report = json.loads((out / "head_swap.json").read_text())
    assert report["motion"] == "kept"
    assert (out / "avatar" / "motion.json").read_text() == (root / "avatar" / "motion.json").read_text()
    assert validate_bundle(out) == []


def test_swap_skins_lams_head_by_the_flame_correspondence(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    (s, R, t), _, base = _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    report = json.loads((out / "head_swap.json").read_text())
    lbs = np.load(tmp_path / "SMPLX_NEUTRAL.npz")["weights"]
    placed = s * base @ R.T + t
    kept = np.flatnonzero(placed[:, 1] >= report["seamY"] - report["bandM"])
    pairs = np.array([(i, i) for i in range(H.FLAME_VERTS)] + MID_EDGES)[kept]
    idx, q = read_skin_bin(out / "avatar" / "skin.bin")
    want_idx, want_q = quantize_top4(0.5 * (lbs[flame_ids[pairs[:, 0]]] + lbs[flame_ids[pairs[:, 1]]]))
    np.testing.assert_array_equal(idx[report["bodyKept"]:], want_idx)
    np.testing.assert_array_equal(q[report["bodyKept"]:], want_q)


def test_swap_without_flame_has_no_expr_and_keeps_the_motion(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root)
    dream = json.loads((out / "dream.json").read_text())
    assert "expr" not in dream["avatar"] and not (out / F.EXPR_FILE).exists()
    assert json.loads((out / "head_swap.json").read_text())["motion"] == "kept"
    assert validate_bundle(out) == []


def test_validate_catches_an_expr_bin_that_doesnt_fit(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    first, d = F.read_expr_bin(out / F.EXPR_FILE)
    F.write_expr_bin(out / F.EXPR_FILE, first, d[:-1])  # stops one Gaussian short of the end
    assert any("expr.bin" in e for e in validate_bundle(out))


def test_cli_head_swap_with_flame_writes_expr_and_can_keep_the_motion(tmp_path, monkeypatch, capsys):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_with_flame(tmp_path, verts, flame_ids)
    (tmp_path / "heads").mkdir()
    for f in ("vishal-a_gs_offset.ply", "vishal-a_textured_mesh.obj"):
        shutil.copy(tmp_path / f, tmp_path / "heads" / f)
    assert _cli(monkeypatch, root, tmp_path, "--person", "vishal", "--flame-expr", str(tmp_path / "flame.npz")) == 0
    out = tmp_path / "dreams" / "vishal-head"
    assert (out / F.EXPR_FILE).is_file() and json.loads((out / "head_swap.json").read_text())["motion"] == "living idle"
    assert _cli(monkeypatch, root, tmp_path, "--person", "vishal", "--flame-expr", str(tmp_path / "flame.npz"),
                "--keep-motion") == 0
    assert json.loads((out / "head_swap.json").read_text())["motion"] == "kept"
    assert "OK" in capsys.readouterr().out and validate_bundle(out) == []


def test_swap_without_an_eye_opening_skips_expr_but_still_swaps(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    _lam_with_flame(tmp_path, verts, flame_ids)
    z = dict(np.load(tmp_path / "flame.npz"))
    np.savez(tmp_path / "flame.npz", **{**z, "faces": FACES[-3:]})  # FLAME's faces without the eyes
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    report = json.loads((out / "head_swap.json").read_text())
    assert "eye opening" in report["expr"]["skipped"] and report["motion"] == "kept"
    assert not (out / F.EXPR_FILE).exists() and validate_bundle(out) == []


def test_swap_keeps_a_fine_tunes_own_clip(tmp_path):
    root, verts, flame_ids = _synthetic_body(tmp_path)
    dream = json.loads((root / "dream.json").read_text())
    dream["source"] = {"views": "runs/jump-shot/views", "motion": "runs/jump-shot/views/gvhmr", "start": "vishal"}
    (root / "dream.json").write_text(json.dumps(dream))  # digs_finetune.py's source: the clip it was tuned on
    _lam_with_flame(tmp_path, verts, flame_ids)
    out = _swap(tmp_path, root, flame_npz=tmp_path / "flame.npz")
    assert json.loads((out / "head_swap.json").read_text())["motion"] == "kept"
