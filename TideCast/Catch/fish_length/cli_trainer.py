import warnings
warnings.filterwarnings("ignore")

import argparse
from fish_length.trainer import FishLengthTrainer


def main():
    parser = argparse.ArgumentParser(description="Train a model to predict fish lengths from images and save artifacts.")
    parser.add_argument("path", help="Path to CSV file with columns for image paths and target lengths.")
    parser.add_argument("--image-col", default="image", help="Name of the image-path column in the CSV (default: image).")
    parser.add_argument("--target-col", default="length", help="Name of the length target column (default: length).")
    parser.add_argument("--test-size", type=float, default=0.2, help="Test set fraction (default: 0.2).")
    parser.add_argument("--random-state", type=int, default=None, help="Random seed for the train/test split.")
    parser.add_argument("--time-budget", type=int, default=60, help="AutoML time budget in seconds (default: 60).")
    parser.add_argument("--artifacts", default="custom-artifacts", help="Directory to write model and scaler artifacts.")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "gpu"], help="Device to use.")
    args = parser.parse_args()

    print("\nFish Length Predictor v1.0 - a package to predict fish lengths from images\n")
    print("The training process will start now")
    print(f"This process will take {args.time_budget} seconds plus a few additional minutes (depending on your hardware and the number of images)\n")
    t = FishLengthTrainer(artifacts_dir=args.artifacts, device=args.device)

    metrics = t.fit_and_save(
        csv_path=args.path,
        image_col=args.image_col,
        target_col=args.target_col,
        test_size=args.test_size,
        random_state=args.random_state,
        time_budget_s=args.time_budget
    )

    print("\nTraining complete")
    print(f"R2: {metrics.get('r2'):.6f}")
    print(f"MAE: {metrics.get('mae'):.6f}")
    print(f"MSE: {metrics.get('mse'):.6f}")    


if __name__ == "__main__":
    main()
