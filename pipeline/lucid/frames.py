"""Multi-view frames for reconstruction: the cameras, and RGBA images per frame (the person cut out of each view).

Two sources share one interface:
  FourDAnyoneFrames  a 4DAnyone result: decodes the generated views for a frame range and cuts the person out
                     with the BiRefNet model 4DAnyone ships; builds a visual-hull point cloud to start from
  PreparedFrames     a folder of RGBA PNGs + cameras.json + init_points.ply (synthetic tests, or any capture rig)

World: 4DAnyone's own, right-handed, metric, +Y up, centred on the person. Cameras: OpenCV (x right, y down, z forward).
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

import numpy as np

# 4DAnyone's Nerfstudio helpers hand back points in a Z-up world; this undoes that rotation.
_Z_UP_TO_Y_UP = np.array([[1.0, 0.0, 0.0], [0.0, 0.0, 1.0], [0.0, -1.0, 0.0]], dtype=np.float32)


@dataclass
class Rig:
    K: np.ndarray  # [V,3,3]
    camera_to_world: np.ndarray  # [V,4,4] OpenCV
    width: int
    height: int

    @property
    def views(self) -> int:
        return int(self.K.shape[0])

    @property
    def world_to_camera(self) -> np.ndarray:
        return np.linalg.inv(self.camera_to_world)

    @classmethod
    def from_json(cls, path: Path) -> "Rig":
        rig = json.loads(Path(path).read_text())
        cams = sorted(rig["cameras"], key=lambda c: int(c["camera_id"]))
        widths = {int(c["image_width"]) for c in cams}
        heights = {int(c["image_height"]) for c in cams}
        if len(widths) != 1 or len(heights) != 1:
            raise ValueError("every view must share one raster size")
        return cls(
            np.stack([np.asarray(c["K"], np.float64) for c in cams]),
            np.stack([np.asarray(c["camera_to_world"], np.float64) for c in cams]),
            widths.pop(),
            heights.pop(),
        )

    def to_json(self) -> dict:
        return {
            "camera_model": "OPENCV",
            "cameras": [
                {
                    "camera_id": i,
                    "K": self.K[i].tolist(),
                    "camera_to_world": self.camera_to_world[i].tolist(),
                    "image_width": self.width,
                    "image_height": self.height,
                }
                for i in range(self.views)
            ],
        }


class PreparedFrames:
    """root/cameras.json, root/frames/NNNNNN/VV.png (RGBA), root/init_points.ply."""

    def __init__(self, root: Path):
        self.root = Path(root)
        self.rig = Rig.from_json(self.root / "cameras.json")
        self.frame_ids = sorted(int(p.name) for p in (self.root / "frames").iterdir() if p.is_dir())

    def rgba(self, frame: int) -> np.ndarray:
        from PIL import Image

        d = self.root / "frames" / f"{frame:06d}"
        return np.stack([np.asarray(Image.open(d / f"{v:02d}.png").convert("RGBA")) for v in range(self.rig.views)])

    def init_points(self, frame: int) -> tuple[np.ndarray, np.ndarray]:
        from .gaussians import read_points_ply

        return read_points_ply(self.root / "init_points.ply")


class FourDAnyoneFrames:
    """Frames [start, end) of a finished 4DAnyone result, decoded once and cut out with BiRefNet."""

    def __init__(self, result: Path, start: int, end: int, device: str = "cuda:0", model_dir: str | None = None):
        import av

        from fdanyone.assets import resolve_foreground_model
        from fdanyone.download import ensure_foreground_model
        from fdanyone.foreground import predict_foreground_masks
        from fdanyone.result_videos import read_target_videos

        self.result = Path(result)
        self.rig = Rig.from_json(self.result / "cameras.json")
        self.device = device
        self.frame_ids = list(range(start, end))
        cameras = json.loads((self.result / "cameras.json").read_text())["cameras"]
        cameras = sorted(cameras, key=lambda c: int(c["camera_id"]))
        self._cameras = cameras
        videos = read_target_videos(self.result, cameras)

        rgb = np.zeros((len(self.frame_ids), self.rig.views, self.rig.height, self.rig.width, 3), np.uint8)
        for v, path in enumerate(videos):
            with av.open(str(path)) as container:
                for i, frame in enumerate(container.decode(container.streams.video[0])):
                    if i >= end:
                        break
                    if i >= start:
                        rgb[i - start, v] = frame.to_ndarray(format="rgb24")

        if model_dir is None:
            import fdanyone

            model_dir = str(Path(fdanyone.__file__).resolve().parents[1] / "models")
        model_root = model_dir
        ensure_foreground_model(model_root)
        flat = tuple(rgb.reshape(-1, self.rig.height, self.rig.width, 3))
        masks = predict_foreground_masks(flat, resolve_foreground_model(model_root), device)
        masks = masks.reshape(len(self.frame_ids), self.rig.views, self.rig.height, self.rig.width)
        self._rgb = rgb
        self._masks = masks

    def rgba(self, frame: int) -> np.ndarray:
        i = frame - self.frame_ids[0]
        return np.concatenate([self._rgb[i], self._masks[i][..., None]], axis=-1)

    def init_points(self, frame: int) -> tuple[np.ndarray, np.ndarray]:
        from fdanyone.nerfstudio.visual_hull import build_sparse_point_cloud

        i = frame - self.frame_ids[0]
        images = tuple(self._rgb[i])
        binary = self._masks[i] >= 128
        points_zup, colors = build_sparse_point_cloud(images, binary, self._cameras, self.device)
        points = np.asarray(points_zup, np.float32) @ _Z_UP_TO_Y_UP.T
        colors = np.asarray(colors, np.float32)
        if colors.max() > 1.0:
            colors = colors / 255.0
        return points, colors
