#!/usr/bin/env python3
"""Exercise the RPM-installed OCR executable against a known local fixture."""
from pathlib import Path
import subprocess
from PIL import Image, ImageDraw, ImageFont

home = Path(".build-home/ocr-smoke")
home.mkdir(parents=True, exist_ok=True)
font_path = next(Path("/usr/share/fonts").rglob("DejaVuSans.ttf"))
image = Image.new("RGB", (950, 150), "white")
ImageDraw.Draw(image).text((30, 35), "REWIND OCR TEST", fill="black",
                           font=ImageFont.truetype(str(font_path), 65))
fixture = home / "fixture.png"
image.save(fixture)
result = subprocess.run(["tesseract", str(fixture), "stdout", "-l", "eng", "--psm", "7"],
                        text=True, capture_output=True, check=True)
assert result.stdout.strip() == "REWIND OCR TEST", result
print(f"Tesseract OCR smoke passed: {result.stdout.strip()}")
