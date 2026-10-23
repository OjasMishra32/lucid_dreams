"""Image losses and metrics on [B,H,W,3] tensors in [0,1]."""

from __future__ import annotations

import torch
import torch.nn.functional as F


def _gaussian_window(size: int = 11, sigma: float = 1.5, device=None) -> torch.Tensor:
    x = torch.arange(size, device=device, dtype=torch.float32) - size // 2
    g = torch.exp(-(x**2) / (2 * sigma**2))
    g = g / g.sum()
    return (g[:, None] * g[None, :])[None, None].repeat(3, 1, 1, 1)


def ssim(pred: torch.Tensor, gt: torch.Tensor) -> torch.Tensor:
    """Mean SSIM (11x11 Gaussian window, the usual constants)."""
    x = pred.permute(0, 3, 1, 2)
    y = gt.permute(0, 3, 1, 2)
    w = _gaussian_window(device=x.device)
    pad = w.shape[-1] // 2
    mu_x = F.conv2d(x, w, padding=pad, groups=3)
    mu_y = F.conv2d(y, w, padding=pad, groups=3)
    sxx = F.conv2d(x * x, w, padding=pad, groups=3) - mu_x**2
    syy = F.conv2d(y * y, w, padding=pad, groups=3) - mu_y**2
    sxy = F.conv2d(x * y, w, padding=pad, groups=3) - mu_x * mu_y
    c1, c2 = 0.01**2, 0.03**2
    s = ((2 * mu_x * mu_y + c1) * (2 * sxy + c2)) / ((mu_x**2 + mu_y**2 + c1) * (sxx + syy + c2))
    return s.mean()


def psnr(pred: torch.Tensor, gt: torch.Tensor) -> torch.Tensor:
    mse = ((pred - gt) ** 2).mean().clamp_min(1e-10)
    return -10 * torch.log10(mse)


def sharpness(img: torch.Tensor) -> torch.Tensor:
    """Variance of the Laplacian of the luminance: higher = sharper. img [H,W,3] in [0,1]."""
    lum = (img[..., 0] * 0.299 + img[..., 1] * 0.587 + img[..., 2] * 0.114)[None, None]
    k = torch.tensor([[0, 1, 0], [1, -4, 1], [0, 1, 0]], dtype=lum.dtype, device=lum.device)[None, None]
    return F.conv2d(lum, k).var()
