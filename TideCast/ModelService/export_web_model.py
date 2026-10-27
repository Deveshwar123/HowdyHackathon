#!/usr/bin/env python3
"""Turn the length model's DINOv2 ViT-g/14 into a file a web browser can run (ONNX), shrink it,
check how much the shrinking changes the answers, and build the species finder's reference index
with the same shrunk model.

Needs the length model's packages (requirements.txt here) plus onnx and onnxruntime, and ~14 GB of
free RAM for the export. Run from the repo root:

    python3 TideCast/ModelService/export_web_model.py OUT_DIR

Writes to OUT_DIR:
  dinov2_vitg14_q4.onnx / dinov2_vitg14_int8.onnx   the browser model (4-bit and 8-bit weights)
  species-refs.bin, species-refs.json               the species index for the browser
  report.json                                       accuracy of each variant against the original
"""
import gc
import glob
import json
import os
import sys
import time

import numpy as np
import torch
from PIL import Image, ImageOps

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
CATCH = os.path.join(ROOT, "TideCast", "Catch")
sys.path.insert(0, CATCH)

OUT = os.path.abspath(sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "web-model"))
FP32_DIR = os.path.join(OUT, "fp32")
FP32 = os.path.join(FP32_DIR, "dinov2_vitg14.onnx")
VARIANTS = {"q4": os.path.join(OUT, "dinov2_vitg14_q4.onnx"),
            "int8": os.path.join(OUT, "dinov2_vitg14_int8.onnx")}
os.makedirs(FP32_DIR, exist_ok=True)


def log(*a):
    print(time.strftime("%H:%M:%S"), *a, flush=True)


def export_fp32():
    if os.path.exists(FP32):
        return log("fp32 ONNX already there")
    from fish_length.utils import _dinov2_vitg14
    log("loading DINOv2 ViT-g/14 (fp32, CPU)")
    model = _dinov2_vitg14().eval()
    x = torch.randn(1, 3, 224, 224)
    log("exporting to ONNX (a few minutes)")
    with torch.no_grad():
        torch.onnx.export(model, (x,), FP32, input_names=["pixel_values"], output_names=["embedding"],
                          opset_version=17, do_constant_folding=True)
    del model
    gc.collect()
    log("exported", FP32)


def quantize():
    import onnx
    if not os.path.exists(VARIANTS["q4"]):
        try:
            from onnxruntime.quantization.matmul_nbits_quantizer import MatMulNBitsQuantizer as Quantizer
        except ImportError:  # onnxruntime < 1.20 calls it MatMul4BitsQuantizer
            from onnxruntime.quantization.matmul_4bits_quantizer import MatMul4BitsQuantizer as Quantizer
        log("4-bit weights (MatMulNBits, block 32)")
        m = onnx.load(FP32, load_external_data=True)
        q = Quantizer(m, block_size=32, is_symmetric=True)
        q.process()
        q.model.save_model_to_file(VARIANTS["q4"], use_external_data_format=False)
        del m, q
        gc.collect()
        log("q4", os.path.getsize(VARIANTS["q4"]) // 2**20, "MB")
    if not os.path.exists(VARIANTS["int8"]):
        from onnxruntime.quantization import QuantType, quantize_dynamic
        log("8-bit weights (dynamic quantization)")
        try:
            quantize_dynamic(FP32, VARIANTS["int8"], weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"])
        except Exception as e:  # the 4.4 GB input is past protobuf's 2 GB limit for some steps
            log("retrying int8 with external data:", type(e).__name__, str(e)[:200])
            tmp = os.path.join(FP32_DIR, "int8_ext.onnx")
            quantize_dynamic(FP32, tmp, weight_type=QuantType.QInt8, op_types_to_quantize=["MatMul"],
                             use_external_data_format=True)
            onnx.save(onnx.load(tmp, load_external_data=True), VARIANTS["int8"])   # one file for the browser
        log("int8", os.path.getsize(VARIANTS["int8"]) // 2**20, "MB")


def transform():
    import torchvision.transforms as T
    # Exactly the length model's preprocessing (fish_length/utils.py).
    return T.Compose([T.ToTensor(), T.Resize(244), T.CenterCrop(224), T.Normalize([0.5], [0.5])])


def evaluate():
    import onnxruntime as ort
    from fish_length.predictor import FishLengthPredictor
    tf = transform()
    pred = FishLengthPredictor(artifacts_dir=os.path.join(CATCH, "fish_length", "artifacts"), device="cpu")
    torch_model = pred.utils.model

    def length(feats):
        return float(pred.predict_features(np.asarray(feats, dtype=np.float32)))

    photos = sorted(glob.glob(os.path.join(ROOT, "TideCast", "fish-photos", "*.jpg")))[:24]
    sessions = {}
    for k, p in VARIANTS.items():
        so = ort.SessionOptions()
        so.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        sessions[k] = ort.InferenceSession(p, so, providers=["CPUExecutionProvider"])
    report = {k: {"cos": [], "dlen_cm": [], "ms": []} for k in VARIANTS}
    lengths = []
    for path in photos:
        x = tf(Image.open(path).convert("RGB"))[:3].unsqueeze(0)
        with torch.no_grad():
            ref = torch_model(x)[0].numpy()
        ref_len = length(ref)
        lengths.append(ref_len)
        for k, s in sessions.items():
            t0 = time.time()
            e = s.run(None, {"pixel_values": x.numpy()})[0][0]
            report[k]["ms"].append((time.time() - t0) * 1000)
            report[k]["cos"].append(float(e @ ref / (np.linalg.norm(e) * np.linalg.norm(ref))))
            report[k]["dlen_cm"].append(abs(length(e) - ref_len))
        log(os.path.basename(path), f"{ref_len:.1f} cm",
            " ".join(f"{k}: cos {report[k]['cos'][-1]:.4f} d{report[k]['dlen_cm'][-1]:.2f}cm" for k in VARIANTS))
    summary = {k: {"min_cos": min(v["cos"]), "mean_cos": float(np.mean(v["cos"])),
                   "median_dlen_cm": float(np.median(v["dlen_cm"])), "max_dlen_cm": max(v["dlen_cm"]),
                   "ms_per_image_cpu": float(np.median(v["ms"])),
                   "size_mb": os.path.getsize(VARIANTS[k]) // 2**20} for k, v in report.items()}
    summary["_lengths_cm"] = [round(x, 1) for x in lengths]
    del torch_model, pred
    gc.collect()
    return summary, sessions


def species_index(session, variant):
    import scoring
    import species_ai
    from fish_data import FISH_DB
    ids = {scoring.slug(n): n for n in FISH_DB}
    refs = species_ai.references(ids)
    tf = transform()
    names, rows = [], []
    for i, (sid, path) in enumerate(refs):
        img = Image.open(path).convert("RGB")
        for im in (img, ImageOps.mirror(img)):
            x = tf(im)[:3].unsqueeze(0).numpy()
            e = session.run(None, {"pixel_values": x})[0][0]
            rows.append(e / (np.linalg.norm(e) + 1e-8))
            names.append(sid)
        if i % 20 == 0:
            log(f"species refs {i}/{len(refs)}")
    m = np.stack(rows).astype(np.float16)
    m.tofile(os.path.join(OUT, "species-refs.bin"))
    with open(os.path.join(OUT, "species-refs.json"), "w") as f:
        json.dump({"variant": variant, "dim": int(m.shape[1]), "count": int(m.shape[0]), "dtype": "float16",
                   "ids": names, "names": {k: v for k, v in ids.items()}}, f)
    log("species index", m.shape)


if __name__ == "__main__":
    log("torch", torch.__version__, "| out", OUT)
    export_fp32()
    quantize()
    summary, sessions = evaluate()
    # 4-bit is half the download; use it unless it changes the length noticeably.
    q4 = summary["q4"]
    chosen = "q4" if q4["median_dlen_cm"] <= 1.0 and q4["min_cos"] >= 0.97 else "int8"
    summary["chosen"] = chosen
    with open(os.path.join(OUT, "report.json"), "w") as f:
        json.dump(summary, f, indent=1)
    log("report", json.dumps({k: v for k, v in summary.items() if k != "_lengths_cm"}))
    species_index(sessions[chosen], chosen)
    log("DONE")
