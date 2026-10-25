# Minimal copy of DINOv2 (github.com/facebookresearch/dinov2 @ 7764ea0, Apache-2.0, see LICENSE):
# only the ViT backbone and its layers, so the length model runs without torch.hub on Python 3.9+.

from __future__ import annotations  # TideCast: lets the "X | None" hints run on Python 3.9
