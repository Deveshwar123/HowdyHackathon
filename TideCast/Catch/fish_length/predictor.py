import glob
from typing import Dict

from sklearn.preprocessing import StandardScaler, MinMaxScaler
from flaml import AutoML

from fish_length.utils import FishLengthUtils


class FishLengthPredictor:
    """Inference-only predictor for fish length from a single image or a batch."""
    def __init__(
        self,
        artifacts_dir: str = "artifacts",
        device: str = "auto"
    ):
        self.utils = FishLengthUtils(artifacts_dir, device)

        self.automl: AutoML = self.utils.load_pickle(self.utils.DEFAULT_ARTIFACTS["model"])
        self.feat_scaler: StandardScaler = self.utils.load_pickle(self.utils.DEFAULT_ARTIFACTS["feat_scaler"])
        self.len_scaler: MinMaxScaler = self.utils.load_pickle(self.utils.DEFAULT_ARTIFACTS["len_scaler"])

    def predict_file(self, image_path: str) -> float:
        """Predict fish length for a single image path."""
        feats = self.utils.embed_image(image_path)
        X = self.feat_scaler.transform(feats.reshape(1, -1))
        y_scaled = self.automl.predict(X).reshape(-1, 1)
        y = self.len_scaler.inverse_transform(y_scaled)[0, 0]
        return float(y)

    def predict_glob(self, pattern: str) -> Dict[str, float]:
        """Predict fish lengths for a glob pattern; returns mapping file->prediction."""
        files = sorted(glob.glob(pattern))
        out = {}
        for fp in files:
            try:
                out[fp] = self.predict_file(fp)
            except Exception as _:
                out[fp] = float("nan")
        return out
