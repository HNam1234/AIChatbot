from __future__ import annotations

import hashlib
import shutil
from pathlib import Path

from PIL import Image, ImageSequence

PDF_EXTENSIONS = {".pdf"}
IMAGE_EXTENSIONS = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".tif", ".tiff"}
SUPPORTED_EXTENSIONS = PDF_EXTENSIONS | IMAGE_EXTENSIONS


class UnsupportedDocumentError(ValueError):
    pass


def assert_supported(path: Path) -> None:
    if path.suffix.lower() not in SUPPORTED_EXTENSIONS:
        supported = ", ".join(sorted(SUPPORTED_EXTENSIONS))
        raise UnsupportedDocumentError(f"Unsupported input type '{path.suffix}'. Use one of: {supported}")


def stable_file_name(path: Path) -> str:
    digest = hashlib.sha256(path.read_bytes()).hexdigest()[:12]
    safe_stem = "".join(c if c.isalnum() or c in {"-", "_"} else "_" for c in path.stem)
    return f"{safe_stem}-{digest}{path.suffix.lower()}"


def copy_to_uploads(path: Path, upload_dir: Path) -> Path:
    path = path.resolve()
    if not path.exists():
        raise FileNotFoundError(path)
    assert_supported(path)
    target = upload_dir / stable_file_name(path)
    if not target.exists():
        shutil.copy2(path, target)
    return target


def prepare_for_pageindex(path: Path, converted_dir: Path) -> Path:
    """Return a PDF path ready for PageIndex.

    PageIndex's public document-processing SDK currently accepts PDFs. Image inputs,
    including graph screenshots, are converted into one-page or multi-page PDFs first.
    """
    path = path.resolve()
    assert_supported(path)
    if path.suffix.lower() in PDF_EXTENSIONS:
        return path
    return image_to_pdf(path, converted_dir)


def image_to_pdf(path: Path, converted_dir: Path) -> Path:
    converted_dir.mkdir(parents=True, exist_ok=True)
    pdf_path = converted_dir / f"{path.stem}-{hashlib.sha256(path.read_bytes()).hexdigest()[:12]}.pdf"
    if pdf_path.exists():
        return pdf_path

    with Image.open(path) as image:
        frames = [_to_rgb(frame.copy()) for frame in ImageSequence.Iterator(image)]
        if not frames:
            raise UnsupportedDocumentError(f"No readable image frames found in {path}")
        first, *rest = frames
        first.save(pdf_path, "PDF", resolution=150.0, save_all=True, append_images=rest)
    return pdf_path


def _to_rgb(image: Image.Image) -> Image.Image:
    if image.mode == "RGB":
        return image
    if image.mode in {"RGBA", "LA"} or "transparency" in image.info:
        background = Image.new("RGB", image.size, "white")
        alpha = image.convert("RGBA").split()[-1]
        background.paste(image.convert("RGB"), mask=alpha)
        return background
    return image.convert("RGB")
