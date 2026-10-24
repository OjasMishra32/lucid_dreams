"""The private data root: $COURT_DATA or --data-root (the flag wins), no default, nothing about the real footage in code.

--real needs a root (and fails with a clear message before any work without one); --synth never does. Every private path
(bundle, staging, default config, scratch, decoded frames) and the clip (config key `clip`) derives from it.
"""

import json
from pathlib import Path

import pytest

from pipeline.court.bake import bake, config, providers, synth
from pipeline.court.bake.bake import Options


def make_root(tmp_path, name="root") -> Path:
    root = tmp_path / name
    root.mkdir()
    return root


# ---------------------------------------------------------------- config.data_root / require_data_root


def test_no_flag_and_no_env_means_no_root():
    assert config.data_root() is None
    assert config.data_root("") is None


def test_env_var_names_the_root(tmp_path, monkeypatch):
    monkeypatch.setenv("COURT_DATA", str(tmp_path))
    assert config.data_root() == tmp_path
    assert config.require_data_root() == tmp_path


def test_flag_wins_over_env(tmp_path, monkeypatch):
    a, b = make_root(tmp_path, "a"), make_root(tmp_path, "b")
    monkeypatch.setenv("COURT_DATA", str(a))
    assert config.data_root(str(b)) == b
    assert config.require_data_root(b) == b


def test_an_empty_env_var_is_not_a_root(monkeypatch):
    monkeypatch.setenv("COURT_DATA", "")
    assert config.data_root() is None


def test_an_empty_flag_is_no_root_and_does_not_fall_back_to_the_env(tmp_path, monkeypatch):
    monkeypatch.setenv("COURT_DATA", str(tmp_path))  # `--data-root "$UNSET"` must not quietly bake into the env's root
    assert config.data_root("") is None
    with pytest.raises(config.DataRootError):
        config.require_data_root("")


def test_a_root_inside_this_checkout_is_refused(monkeypatch):
    inside = config.CHECKOUT / "pipeline"
    assert config.inside_checkout(inside) and config.inside_checkout(config.CHECKOUT)
    with pytest.raises(config.DataRootError, match="inside this checkout"):
        config.require_data_root(inside)
    monkeypatch.chdir(inside)  # a relative root resolves against the working directory
    with pytest.raises(config.DataRootError, match="inside this checkout"):
        config.require_data_root(".")


def test_root_expands_a_tilde(monkeypatch):
    monkeypatch.setenv("HOME", "/somewhere/home")
    assert config.data_root("~/data") == Path("/somewhere/home/data")


def test_require_without_a_root_says_how_to_give_one():
    with pytest.raises(config.DataRootError) as e:
        config.require_data_root()
    msg = str(e.value)
    assert "COURT_DATA" in msg and "--data-root" in msg


def test_a_folder_elsewhere_is_not_inside_the_checkout(tmp_path):
    assert not config.inside_checkout(tmp_path)


def test_require_refuses_a_root_that_is_not_a_folder(tmp_path):
    with pytest.raises(config.DataRootError, match="not a folder"):
        config.require_data_root(tmp_path / "missing")


def test_everything_private_derives_from_the_root(tmp_path):
    r = tmp_path
    assert config.bundle_dir(r) == r / "bundle" / "court-side"
    assert config.staging_dir(r) == r / "work" / "show"
    assert config.default_config_path(r) == r / "work" / "bake" / "bake_config.json"
    assert config.tmp_dir(r) == r / "work" / "bake" / "tmp"
    assert config.frames_dir(r) == r / "work" / "layers" / "f1080"


# ---------------------------------------------------------------- config.load and the `clip` key


def test_clip_is_a_config_key_and_round_trips():
    cfg = config.from_dict({"clip": "some-clip.mp4"})
    assert cfg.clip == "some-clip.mp4"
    assert config.from_dict(config.to_dict(cfg)).clip == "some-clip.mp4"
    assert config.BakeConfig().clip == ""


def _write_cfg(path: Path, **kw) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(config.to_dict(config.BakeConfig(**kw))))
    return path


def test_load_reads_the_default_config_under_the_root(tmp_path):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="c.mp4")
    assert config.load(root=root).clip == "c.mp4"


def test_load_prefers_an_explicit_path_then_the_env_var_over_the_root(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="from-root.mp4")
    via_env = _write_cfg(tmp_path / "env.json", clip="from-env.mp4")
    via_arg = _write_cfg(tmp_path / "arg.json", clip="from-arg.mp4")
    monkeypatch.setenv("COURT_BAKE_CONFIG", str(via_env))
    assert config.load(root=root).clip == "from-env.mp4"
    assert config.load(via_arg, root=root).clip == "from-arg.mp4"


def test_load_with_no_path_and_no_root_names_the_options():
    with pytest.raises(config.DataRootError) as e:
        config.load()
    assert "--config" in str(e.value) and "COURT_DATA" in str(e.value)


def test_load_picks_the_root_up_from_the_env_var(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="c.mp4")
    monkeypatch.setenv("COURT_DATA", str(root))
    assert config.load().clip == "c.mp4"


# ---------------------------------------------------------------- providers: clip, scratch, frames


def test_clip_is_relative_to_the_root_unless_absolute_or_tilde(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    assert providers.resolve_clip(config.BakeConfig(clip=""), root) is None
    assert providers.resolve_clip(config.BakeConfig(clip="a/b.mp4"), root) == root / "a" / "b.mp4"
    absolute = tmp_path / "elsewhere" / "x.mp4"
    assert providers.resolve_clip(config.BakeConfig(clip=str(absolute)), root) == absolute
    monkeypatch.setenv("HOME", "/somewhere/home")
    assert providers.resolve_clip(config.BakeConfig(clip="~/x.mp4"), root) == Path("/somewhere/home/x.mp4")


def test_scratch_is_the_configs_else_under_the_root_else_the_system_temp(tmp_path):
    root = make_root(tmp_path)
    assert providers.tmp_for(config.BakeConfig(tmp=str(tmp_path / "t")), root) == tmp_path / "t"
    assert providers.tmp_for(config.BakeConfig(), root) == config.tmp_dir(root)
    assert providers.tmp_for(config.BakeConfig(), None).is_absolute()


def test_a_missing_clip_is_a_warning_not_a_silent_fallback(tmp_path):
    warnings = []
    assert providers.freeze_source_for(config.BakeConfig(), None, tmp_path / "nope.mp4", tmp_path, warnings) is None
    assert len(warnings) == 1 and "does not exist" in warnings[0]
    quiet = []
    assert providers.freeze_source_for(config.BakeConfig(), None, None, tmp_path, quiet) is None and quiet == []


class _Recorder:
    def __init__(self):
        self.calls = []

    def __call__(self, cfg, out_dir, opts, bake_fn, **kw):
        self.calls.append((cfg, Path(out_dir), kw))
        return {"ok": True}


def test_real_run_without_a_root_fails_before_reading_anything(tmp_path, monkeypatch):
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    with pytest.raises(config.DataRootError):
        providers.real_run(None, None, None, Options(), bake.bake)
    assert rec.calls == []


def test_real_run_derives_config_frames_staging_and_the_clip_from_the_root(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="the-clip.mp4")
    (root / "the-clip.mp4").touch()
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    opts = Options(data_root=root)
    providers.real_run(None, None, None, opts, bake.bake)
    (cfg, out, kw), = rec.calls
    assert out == config.staging_dir(root)
    assert cfg.frames_dir == str(config.frames_dir(root)) and cfg.frame_pattern == "{src:06d}.jpg"
    assert kw["freeze_clip"] == root / "the-clip.mp4"
    assert kw["data_root"] == root


def test_real_run_keeps_the_configs_own_frames_and_skips_the_clip_with_no_freeze_4k(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="the-clip.mp4", frames_dir=str(tmp_path / "frames"))
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    providers.real_run(None, None, None, Options(data_root=root, no_freeze_4k=True), bake.bake)
    (cfg, _out, kw), = rec.calls
    assert cfg.frames_dir == str(tmp_path / "frames")
    assert kw["freeze_clip"] is None


def test_real_run_warns_when_the_config_names_no_clip(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root))
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    providers.real_run(None, None, None, Options(data_root=root), bake.bake)
    (_cfg, _out, kw), = rec.calls
    assert kw["freeze_clip"] is None
    assert any("clip" in w for w in kw["warnings"])


def test_real_run_takes_the_root_from_the_env_when_the_options_have_none(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="c.mp4")
    (root / "c.mp4").touch()
    monkeypatch.setenv("COURT_DATA", str(root))
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    providers.real_run(None, None, None, Options(), bake.bake)
    assert rec.calls[0][2]["data_root"] == root


def test_real_run_with_a_clip_that_is_not_there_stops_before_any_work(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root), clip="missing.mp4")
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    with pytest.raises(providers.MissingInput, match="does not exist"):
        providers.real_run(None, None, None, Options(data_root=root), bake.bake)
    assert rec.calls == []
    providers.real_run(None, None, None, Options(data_root=root, no_freeze_4k=True), bake.bake)  # the 1080p set's F is the opt-out
    assert len(rec.calls) == 1


def test_real_run_with_no_config_file_names_where_it_looked(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    monkeypatch.setattr(providers, "build_run", _Recorder())
    with pytest.raises(providers.MissingInput) as e:
        providers.real_run(None, None, None, Options(data_root=root), bake.bake)
    assert str(config.default_config_path(root)) in str(e.value)


def test_relative_config_paths_are_relative_to_the_root_never_the_working_directory(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    absolute = tmp_path / "elsewhere" / "frames"
    _write_cfg(config.default_config_path(root), clip="c.mp4", calib="calib/c.json", layers="layers/out", tmp="scratch", frames_dir=str(absolute))
    (root / "c.mp4").touch()
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    monkeypatch.chdir(tmp_path)
    providers.real_run(None, None, None, Options(data_root=root), bake.bake)
    cfg = rec.calls[0][0]
    assert (cfg.calib, cfg.layers, cfg.tmp) == (str(root / "calib" / "c.json"), str(root / "layers" / "out"), str(root / "scratch"))
    assert cfg.frames_dir == str(absolute) and cfg.rife_dir == "" and cfg.watermark_model == ""


def test_real_run_refuses_an_output_folder_inside_the_checkout(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    _write_cfg(config.default_config_path(root))
    rec = _Recorder()
    monkeypatch.setattr(providers, "build_run", rec)
    with pytest.raises(config.DataRootError, match="inside this checkout"):
        providers.real_run(None, str(config.CHECKOUT / "out"), None, Options(data_root=root, no_freeze_4k=True), bake.bake)
    assert rec.calls == []


class _Stop(Exception):
    pass


def test_build_run_places_scratch_under_the_data_root_when_the_config_has_none(tmp_path, monkeypatch):
    work = tmp_path / "work"
    synth.write_clip(work)
    cfg = config.load(work / "bake_config.json")
    assert cfg.tmp  # synth's config names its own scratch: take it away
    import dataclasses

    cfg = dataclasses.replace(cfg, tmp="")
    root = make_root(tmp_path)
    seen = {}

    def stop(c, src, clip, tmp, warnings):
        seen["tmp"], seen["warnings"] = tmp, list(warnings)
        raise _Stop

    monkeypatch.setattr(providers, "freeze_source_for", stop)
    with pytest.raises(_Stop):
        providers.build_run(cfg, tmp_path / "out", Options(), bake.bake, data_root=root, warnings=["from the caller"])
    assert seen["tmp"] == config.tmp_dir(root)
    assert seen["warnings"][0] == "from the caller"


# ---------------------------------------------------------------- bake.check_out_dir


def test_the_assembled_bundle_is_refused_when_a_root_is_known(tmp_path, monkeypatch):
    root = make_root(tmp_path)
    bundle = config.bundle_dir(root)
    for p in (bundle, bundle / "video", bundle / "x" / ".." / "video"):
        with pytest.raises(ValueError, match="refusing"):
            bake.check_out_dir(p, root)
    monkeypatch.setenv("COURT_DATA", str(root))  # or from the environment
    with pytest.raises(ValueError, match="refusing"):
        bake.check_out_dir(bundle / "video")
    with pytest.raises(ValueError, match="refusing"):
        bake.bake({}, None, None, bundle, Options(data_root=root))
    assert bake.check_out_dir(config.staging_dir(root), root) == config.staging_dir(root).resolve()


def test_with_no_root_any_other_folder_is_fine(tmp_path):
    assert bake.check_out_dir(tmp_path) == tmp_path.resolve()


# ---------------------------------------------------------------- the CLI


@pytest.fixture
def runs(monkeypatch):
    """Stand-ins for the two runners: what they were given."""
    seen = {"real": [], "synth": []}

    def real(work, out, config_path, opts, bake_fn):
        seen["real"].append((work, out, config_path, opts))
        return {"ok": True}

    def synth(work, out, config_path, opts, bake_fn):
        seen["synth"].append((work, out, config_path, opts))
        return {"ok": True}

    monkeypatch.setattr(providers, "real_run", real)
    monkeypatch.setattr(providers, "synth_run", synth)
    return seen


def test_cli_real_without_a_root_fails_clearly_before_any_work(runs, capsys):
    assert bake.main(["--real"]) == 2
    err = capsys.readouterr().err
    assert "COURT_DATA" in err and "--data-root" in err
    assert runs["real"] == [] and runs["synth"] == []


def test_cli_real_with_a_root_that_is_not_a_folder_fails_before_any_work(tmp_path, runs, capsys):
    assert bake.main(["--real", "--data-root", str(tmp_path / "missing")]) == 2
    assert "not a folder" in capsys.readouterr().err
    assert runs["real"] == []


def test_cli_real_takes_the_root_from_the_env(tmp_path, monkeypatch, runs, capsys):
    root = make_root(tmp_path)
    monkeypatch.setenv("COURT_DATA", str(root))
    assert bake.main(["--real"]) == 0
    capsys.readouterr()
    assert runs["real"][0][3].data_root == root


def test_cli_real_flag_beats_env(tmp_path, monkeypatch, runs, capsys):
    a, b = make_root(tmp_path, "a"), make_root(tmp_path, "b")
    monkeypatch.setenv("COURT_DATA", str(a))
    assert bake.main(["--real", "--data-root", str(b)]) == 0
    capsys.readouterr()
    assert runs["real"][0][3].data_root == b


def test_cli_real_with_an_empty_flag_does_not_fall_back_to_the_env(tmp_path, monkeypatch, runs, capsys):
    monkeypatch.setenv("COURT_DATA", str(make_root(tmp_path)))
    assert bake.main(["--real", "--data-root", ""]) == 2
    assert "COURT_DATA" in capsys.readouterr().err
    assert runs["real"] == []


def test_cli_real_with_a_root_inside_the_checkout_fails_before_any_work(runs, capsys):
    assert bake.main(["--real", "--data-root", str(config.CHECKOUT)]) == 2
    assert "inside this checkout" in capsys.readouterr().err
    assert runs["real"] == []


def test_cli_real_refuses_the_bundle_under_the_flags_root(tmp_path, runs):
    root = make_root(tmp_path)
    with pytest.raises(ValueError, match="refusing"):
        bake.main(["--real", "--data-root", str(root), "--out", str(config.bundle_dir(root) / "video")])
    assert runs["real"] == []


def test_cli_synth_needs_no_root(tmp_path, runs, capsys):
    assert bake.main(["--synth", str(tmp_path / "work")]) == 0
    capsys.readouterr()
    assert runs["synth"][0][3].data_root is None and runs["real"] == []


def test_cli_synth_with_a_root_still_refuses_the_bundle(tmp_path, runs):
    root = make_root(tmp_path)
    with pytest.raises(ValueError, match="refusing"):
        bake.main(["--synth", str(tmp_path / "work"), "--data-root", str(root), "--out", str(config.bundle_dir(root))])
