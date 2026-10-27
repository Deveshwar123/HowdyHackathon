#!/usr/bin/env python3
"""Turn the length model's DINOv2 ViT-g/14 into a file a web browser can run (ONNX), shrink it,
check how much the shrinking changes the answers, and build the species finder's reference index
with the same shrunk model.

Needs the length model's packages (requirements.txt here) plus onnx and onnxruntime, and ~14 GB of
free RAM for the export. Run from the repo root:

    python3 TideCast/ModelService/export_web_model.py OUT_DIR

Writes to OUT_DIR:
  dinov2_vitg14_q4.onnx                             the browser model, 4-bit weights (Standard)
  dinov2_vitg14_q8.onnx + .onnx.data                the browser model, 8-bit weights (High precision)
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
VARIANTS = {"q4": os.path.join(OUT, "dinov2_vitg14_q4.onnx"),     # Standard: one 690 MB file
            "q8": os.path.join(OUT, "dinov2_vitg14_q8.onnx")}     # High precision: 16 MB + 1.2 GB .data
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


def quantize_nbits(src, out, bits, external):
    """MatMulNBits (block 32, symmetric) one weight at a time, so the 4.4 GB model needs only a few
    hundred MB of RAM (onnxruntime's own quantizer loads everything and runs out of memory).
    Same packing as onnxruntime's quantizer, using its C++ kernel."""
    import onnx
    from onnx import external_data_helper, helper, numpy_helper
    from onnxruntime.capi._pybind_state import quantize_matmul_4bits, quantize_matmul_8bits
    bs, base = 32, os.path.dirname(src)
    data_f = open(out + ".data", "wb") if external else None   # q8 is past protobuf's 2 GB limit

    def stash(arr, name):
        t = numpy_helper.from_array(arr, name)
        if data_f is None:
            return t
        raw = t.raw_data
        off = data_f.tell()
        data_f.write(raw)
        external_data_helper.set_external_data(t, location=os.path.basename(out) + ".data", offset=off, length=len(raw))
        t.ClearField("raw_data")
        return t

    m = onnx.load(src, load_external_data=False)
    g = m.graph
    inits = {t.name: t for t in g.initializer}
    drop, add, nodes = set(), [], []
    for node in g.node:
        w_name = node.input[1] if node.op_type == "MatMul" and len(node.input) > 1 else None
        t = inits.get(w_name)
        if t is None or len(t.dims) != 2:
            nodes.append(node)
            continue
        w = np.ascontiguousarray(numpy_helper.to_array(t, base_dir=base).astype(np.float32))
        k, n = w.shape
        kb = (k + bs - 1) // bs
        packed = np.zeros((n, kb, bs * bits // 8), dtype=np.uint8)
        scales = np.zeros((n, kb), dtype=np.float32)
        zp = np.zeros((n, (kb + 1) // 2), dtype=np.uint8)
        (quantize_matmul_8bits if bits == 8 else quantize_matmul_4bits)(packed, w, scales, zp, bs, n, k, True)
        add += [stash(packed, w_name + f"_Q{bits}"), stash(scales.reshape(-1), w_name + "_scales")]
        nodes.append(helper.make_node("MatMulNBits", [node.input[0], w_name + f"_Q{bits}", w_name + "_scales"],
                                      list(node.output), name=(node.name or w_name) + f"_Q{bits}",
                                      domain="com.microsoft", K=k, N=n, bits=bits, block_size=bs))
        drop.add(w_name)
        del w, packed, scales
        gc.collect()
    keep = []
    for t in g.initializer:
        if t.name in drop:
            continue
        if t.data_location == onnx.TensorProto.EXTERNAL:
            external_data_helper.load_external_data_for_tensor(t, base)
            t.data_location = onnx.TensorProto.DEFAULT
            del t.external_data[:]
        keep.append(t)
    del g.initializer[:]
    g.initializer.extend(keep + add)
    del g.node[:]
    g.node.extend(nodes)
    # DINOv2's optional token masking: the export leaves it as a bool input; fix it to False.
    for i in list(g.input):
        if i.name == "masks":
            g.input.remove(i)
            g.initializer.append(numpy_helper.from_array(np.array(False), "masks"))
    if not any(o.domain == "com.microsoft" for o in m.opset_import):
        m.opset_import.append(helper.make_opsetid("com.microsoft", 1))
    if data_f:
        data_f.close()
    onnx.save_model(m, out)


def quantize():
    for k, (bits, external) in {"q4": (4, False), "q8": (8, True)}.items():
        if not os.path.exists(VARIANTS[k]):
            log(f"{bits}-bit weights (MatMulNBits, block 32)")
            quantize_nbits(FP32, VARIANTS[k], bits, external)
            log(k, os.path.getsize(VARIANTS[k]) // 2**20, "MB")


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
                   "size_mb": sum(os.path.getsize(f) for f in glob.glob(VARIANTS[k] + "*")) // 2**20}
               for k, v in report.items()}
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
    # Visitors choose the size; the species index comes from the more precise model and works with both.
    chosen = "q8"
    with open(os.path.join(OUT, "report.json"), "w") as f:
        json.dump(summary, f, indent=1)
    log("report", json.dumps({k: v for k, v in summary.items() if k != "_lengths_cm"}))
    species_index(sessions[chosen], chosen)
    log("DONE")
