from pathlib import Path

from PIL import Image

from chatbot_pipeline.documents import image_to_pdf


def test_image_to_pdf(tmp_path: Path) -> None:
    image_path = tmp_path / "graph.png"
    Image.new("RGBA", (64, 64), (255, 0, 0, 128)).save(image_path)

    pdf_path = image_to_pdf(image_path, tmp_path / "converted")

    assert pdf_path.exists()
    assert pdf_path.suffix == ".pdf"
