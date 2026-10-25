import os
import pickle
from typing import List
import numpy as np
from PIL import Image
import torch
import torchvision.transforms as T


DINOV2_VITG14_URL = "https://dl.fbaipublicfiles.com/dinov2/dinov2_vitg14/dinov2_vitg14_pretrain.pth"


def _dinov2_vitg14():
    """The same DINOv2 ViT-g/14 that torch.hub.load('facebookresearch/dinov2', 'dinov2_vitg14')
    builds, from the copy in _vendor/ (torch.hub's latest code needs Python 3.10+). The weights
    download once to torch's cache, ~/.cache/torch/hub/checkpoints."""
    import sys
    vendor = os.path.join(os.path.dirname(os.path.abspath(__file__)), "_vendor")
    if vendor not in sys.path:
        sys.path.insert(0, vendor)
    os.environ.setdefault("XFORMERS_DISABLED", "1")
    from dinov2.models.vision_transformer import vit_giant2
    model = vit_giant2(patch_size=14, img_size=518, init_values=1.0, ffn_layer="swiglufused", block_chunks=0,
                       num_register_tokens=0, interpolate_antialias=False, interpolate_offset=0.1)
    try:
        state = torch.hub.load_state_dict_from_url(DINOV2_VITG14_URL, map_location="cpu", weights_only=True)
    except TypeError:  # older torch without weights_only
        state = torch.hub.load_state_dict_from_url(DINOV2_VITG14_URL, map_location="cpu")
    model.load_state_dict(state, strict=True)
    return model


class Singleton(type):
    _instances = {}
    def __call__(cls, *args, **kwargs):
        if cls not in cls._instances:
            cls._instances[cls] = super(Singleton, cls).__call__(*args, **kwargs)
        return cls._instances[cls]


class FishLengthUtils(metaclass=Singleton):
    """Utility class (singleton) that handles DINOv2 embeddings and (de)serializing artifacts."""
    def __init__(
        self,
        artifacts_dir: str = "artifacts",
        device: str = "auto"
    ):
        self.DEFAULT_ARTIFACTS = {
            "model": "automl_model.pkl",
            "feat_scaler": "features_scaler_model.pkl",
            "len_scaler": "length_scaler_model.pkl",
        }

        self.artifacts_dir = artifacts_dir
        os.makedirs(self.artifacts_dir, exist_ok=True)
        self.device = self._device_from_str(device)
        self.model = _dinov2_vitg14().to(self.device)
        self.model.eval()

        self.transform = T.Compose([
            T.ToTensor(),
            T.Resize(244),
            T.CenterCrop(224),
            T.Normalize([0.5], [0.5]),
        ])

    def _device_from_str(self, s: str) -> torch.device:
        """Parses a device string and returns the corresponding torch.device (auto/cpu/cuda)."""
        s = (s or "auto").lower()
        if s == "auto":
            if torch.cuda.is_available():
                return torch.device("cuda")
            if getattr(torch.backends, "mps", None) and torch.backends.mps.is_available():
                return torch.device("mps")         # Apple-silicon Macs: much faster than CPU
            return torch.device("cpu")
        if s in {"cuda", "gpu"}:
            return torch.device("cuda")
        return torch.device("cpu")

    @torch.no_grad()
    def embed_image(self, image_path: str) -> np.ndarray:
        """Computes a single DINOv2 embedding for an image path (eval mode)."""
        img = Image.open(image_path).convert("RGB")
        x = self.transform(img)[:3].unsqueeze(0).to(self.device)
        feats = self.model(x)  # shape: (1, D)
        return feats[0].detach().cpu().numpy()

    def embed_batch(self, paths: List[str]) -> np.ndarray:
        """Batches over paths and stacks per-image embeddings into (N, D) array."""
        return np.stack([self.embed_image(p) for p in paths], axis=0)

    def save_pickle(self, obj, filename: str):
        """Saves a Python object as a pickle into the artifacts directory."""
        path = os.path.join(self.artifacts_dir, filename)
        with open(path, "wb") as f:
            pickle.dump(obj, f, protocol=pickle.HIGHEST_PROTOCOL)
        return path

    def load_pickle(self, name: str):
        """Loads a pickle artifact by name from the artifacts directory."""
        path = os.path.join(self.artifacts_dir, name)
        if not os.path.exists(path):
            raise FileNotFoundError(f"Missing artifact: {path}. "
                                    "Place required .pkl files in the artifacts directory.")
        with open(path, "rb") as f:
            return pickle.load(f)
