import warnings
warnings.filterwarnings("ignore")

import argparse
import csv
import os
from fish_length.predictor import FishLengthPredictor


def main():
    parser = argparse.ArgumentParser(description="Predict fish lengths from images.")
    parser.add_argument("path", help="Image file path or glob pattern.")
    parser.add_argument("--artifacts", default="artifacts", help="Directory containing model .pkl files.")
    parser.add_argument("--device", default="auto", choices=["auto", "cpu", "cuda", "gpu"], help="Device to use.")
    parser.add_argument("--out", default="predictions.csv", help="Output CSV for batch predictions (glob input).")
    args = parser.parse_args()

    print("\nFish Length Predictor v1.0 - a package to predict fish lengths from images\n")
    print("Loading the pre-trained models and running inference on your images")
    print("This may take a few minutes depending on your hardware and the number of images\n")
    p = FishLengthPredictor(artifacts_dir=args.artifacts, device=args.device)

    # If path is a single file path, predict and print.
    if os.path.isfile(args.path):
        y = p.predict_file(args.path)
        print(f"{args.path}: {y:.6f}")
        return

    # Otherwise treat path as a glob pattern and write CSV.
    results = p.predict_glob(args.path)

    # If no matches, warn and exit non-zero for CI visibility.
    if not results:
        print("No files matched pattern: ", args.path)
        raise SystemExit(2)

    with open(args.out, "w", newline="") as f:
        writer = csv.writer(f)
        writer.writerow(["file", "pred_length"])
        for k, v in results.items():
            print(f"{k}: {v:.6f}")
            writer.writerow([k, v])
    print(f"\nWrote predictions to {args.out}")


if __name__ == "__main__":
    main()
