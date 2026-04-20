#!/usr/bin/env python3
"""PaddleOCR worker for RewindOS daemon.
Long-lived process that communicates via JSON Lines on stdin/stdout.
Models are loaded once on startup and stay in memory.

Protocol:
  Request:  {"type": "health"}
  Response: {"status": "ok", "version": "...", "gpu": false}

  Request:  {"type": "ocr", "image_path": "/path/to/screenshot.webp"}
  Response: {"status": "ok", "full_text": "...", "bounding_boxes": [...], "word_count": N}

  Error:    {"status": "error", "message": "..."}
"""

import json
import logging
import os
import sys

import numpy as np
from PIL import Image

# Redirect all logging to stderr so stdout stays clean for JSONL protocol.
logging.basicConfig(stream=sys.stderr, level=logging.WARNING)

# Suppress PaddlePaddle's verbose C++ logging.
os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("FLAGS_minloglevel", "2")

# Skip slow model-hoster connectivity check on startup.
os.environ.setdefault("PADDLE_PDX_DISABLE_MODEL_SOURCE_CHECK", "True")

from paddleocr import PaddleOCR  # noqa: E402

# Read optional language from argv (default: en).
_LANG_MAP = {
    "eng": "en",
    "deu": "german",
    "fra": "fr",
    "spa": "es",
    "por": "pt",
    "ita": "it",
    "rus": "ru",
    "jpn": "japan",
    "kor": "korean",
    "chi_sim": "ch",
    "chi_tra": "chinese_cht",
    "ara": "ar",
}
_raw_lang = sys.argv[1] if len(sys.argv) > 1 else "en"
lang = _LANG_MAP.get(_raw_lang, _raw_lang)

# Load models once on startup.
ocr = PaddleOCR(use_textline_orientation=False, lang=lang, enable_mkldnn=True)

# Signal readiness to stderr.
print(f"paddleocr_worker ready (lang={lang})", file=sys.stderr, flush=True)


def process_ocr(image_path: str) -> dict:
    img = np.array(Image.open(image_path).convert("RGB"))
    results = ocr.predict(img)

    full_text_parts = []
    bounding_boxes = []
    word_count = 0

    for res in results:
        texts = res.get("rec_texts", [])
        scores = res.get("rec_scores", [])
        polys = res.get("rec_polys", [])

        for text, score, poly in zip(texts, scores, polys):
            xs = [p[0] for p in poly]
            ys = [p[1] for p in poly]
            x, y = int(min(xs)), int(min(ys))
            w = int(max(xs) - min(xs))
            h = int(max(ys) - min(ys))

            full_text_parts.append(text)
            word_count += len(text.split())
            bounding_boxes.append({
                "text_content": text,
                "x": x, "y": y, "width": w, "height": h,
                "confidence": round(float(score), 4),
            })

    return {
        "status": "ok",
        "full_text": "\n".join(full_text_parts),
        "bounding_boxes": bounding_boxes,
        "word_count": word_count,
    }


def handle_request(request: dict) -> dict:
    req_type = request.get("type")

    if req_type == "health":
        import paddleocr as _po
        return {"status": "ok", "version": getattr(_po, "VERSION", "unknown"), "gpu": False}
    elif req_type == "ocr":
        image_path = request.get("image_path")
        if not image_path:
            return {"status": "error", "message": "missing image_path"}
        return process_ocr(image_path)
    else:
        return {"status": "error", "message": f"unknown request type: {req_type}"}


while True:
    line = sys.stdin.readline()
    if not line:  # EOF — parent closed the pipe
        break
    line = line.strip()
    if not line:
        continue
    try:
        request = json.loads(line)
        response = handle_request(request)
    except json.JSONDecodeError as e:
        response = {"status": "error", "message": f"invalid JSON: {e}"}
    except Exception as e:
        response = {"status": "error", "message": str(e)}

    sys.stdout.write(json.dumps(response) + "\n")
    sys.stdout.flush()
