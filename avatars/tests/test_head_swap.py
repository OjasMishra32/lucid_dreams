import json
import shutil

import numpy as np
import pytest

from lucid_avatars import head_swap as H
from lucid_avatars.bundle import validate_bundle, write_avatar_bundle
from lucid_avatars.gaussian_ply import SH_C0, Gaussians, read_ply, write_ply
from lucid_avatars.idle import idle_loop
from lucid_avatars.skinning import read_skin_bin, skeleton_dict
from lucid_avatars.smplx_layout import NUM_JOINTS, J


def _rot(axis, angle):
    axis = np.asarray(axis, float) / np.linalg.norm(axis)
    K = np.array([[0, -axis[2], axis[1]], [axis[2], 0, -axis[0]], [-axis[1], axis[0], 0]])
    return np.eye(3) + np.sin(angle) * K + (1 - np.cos(angle)) * K @ K


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
    head, flame = H.lam_head(tmp_path / "me-a_gs_offset.ply", tmp_path / "me-a_textured_mesh.obj")
    np.testing.assert_allclose(head.xyz, pos, atol=1e-6)
    np.testing.assert_allclose(0.5 + SH_C0 * head.f_dc, rgb, atol=1e-6)
    np.testing.assert_allclose(flame, pos[:H.FLAME_VERTS] - offset[:H.FLAME_VERTS], atol=1e-6)


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


def _synthetic_body(tmp_path):
    """A tiny SMPL-X-like model: a column of vertices, the top ones the FLAME head, joints regressed from them."""
    rng = np.random.default_rng(4)
    n_body, n_head = 400, H.FLAME_VERTS
    body_v = np.column_stack([rng.uniform(-0.2, 0.2, n_body), rng.uniform(-1.3, 0.15, n_body),
                              rng.uniform(-0.1, 0.1, n_body)])
    head_v = np.column_stack([rng.uniform(-0.08, 0.08, n_head), rng.uniform(0.12, 0.45, n_head),
                              rng.uniform(-0.09, 0.11, n_head)])
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
    assert np.abs(rgb - 0.7).max() < 0.02  # toned to the body's skin
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
