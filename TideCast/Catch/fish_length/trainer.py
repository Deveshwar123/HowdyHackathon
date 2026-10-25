import os
import pandas as pd

from sklearn.metrics import r2_score, mean_absolute_error, mean_squared_error
from sklearn.preprocessing import StandardScaler, MinMaxScaler
from sklearn.model_selection import train_test_split
from flaml import AutoML

from fish_length.utils import FishLengthUtils


class FishLengthTrainer:
    """Trainer for fish lengths that embeds images, fits an AutoML regressor, and saves inference artifacts."""
    def __init__(
        self,
        artifacts_dir: str = "artifacts",
        device: str = "auto"
    ):
        self.utils = FishLengthUtils(artifacts_dir, device)

        self.feat_scaler = StandardScaler()
        self.len_scaler = MinMaxScaler(feature_range=(0, 1))
        self.automl = AutoML()

    def fit_and_save(
        self,
        csv_path: str,
        image_col: str = "image",
        target_col: str = "length",
        test_size: float = 0.2,
        random_state: int = None,
        time_budget_s: int = 60,
        verbose: bool = True
    ) -> dict:
        """Trains from a CSV of image paths and lengths, evaluates, and writes artifacts to disk."""
        if not os.path.exists(csv_path):
            raise FileNotFoundError(f"CSV not found: {csv_path}")

        df = pd.read_csv(csv_path)
        if image_col not in df or target_col not in df:
            raise ValueError(f"CSV must contain columns '{image_col}' and '{target_col}'")

        missing = [p for p in df[image_col] if not os.path.exists(p)]
        if missing:
            raise FileNotFoundError(f"Missing image files (first 5): {missing[:5]}")

        train_df, test_df = train_test_split(
            df[[image_col, target_col]],
            test_size=test_size,
            random_state=random_state,
            shuffle=True,
        )

        if verbose:
            print(f"Embedding {len(train_df)} train / {len(test_df)} test images...")

        X_train = self.utils.embed_batch(train_df[image_col].tolist())
        X_test = self.utils.embed_batch(test_df[image_col].tolist())
        y_train = train_df[target_col].to_numpy().astype(float).reshape(-1, 1)
        y_test = test_df[target_col].to_numpy().astype(float).flatten()

        X_train_s = self.feat_scaler.fit_transform(X_train)
        X_test_s = self.feat_scaler.transform(X_test)
        y_train_s = self.len_scaler.fit_transform(y_train).ravel()

        if verbose:
            print(f"Running FLAML AutoML (time_budget={time_budget_s}s)...")

        self.automl.fit(
            X_train=X_train_s,
            y_train=y_train_s,
            task="regression",
            time_budget=time_budget_s,
            metric="mae",
            verbose=verbose,
            estimator_list=["xgboost"]
        )

        y_pred_s = self.automl.predict(X_test_s).reshape(-1, 1)
        y_pred = self.len_scaler.inverse_transform(y_pred_s).flatten()

        r2 = r2_score(y_test, y_pred)
        mae = mean_absolute_error(y_test, y_pred)
        mse = mean_squared_error(y_test, y_pred)

        self.utils.save_pickle(self.automl, self.utils.DEFAULT_ARTIFACTS["model"])
        self.utils.save_pickle(self.feat_scaler, self.utils.DEFAULT_ARTIFACTS["feat_scaler"])
        self.utils.save_pickle(self.len_scaler, self.utils.DEFAULT_ARTIFACTS["len_scaler"])

        if verbose:
            print(f"Saved artifacts to {os.path.abspath(self.utils.artifacts_dir)}")

        return {"r2": r2, "mae": mae, "mse": mse}
