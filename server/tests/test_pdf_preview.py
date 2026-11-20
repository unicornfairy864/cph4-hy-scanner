from io import BytesIO
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

from PIL import Image

from scanner.pdf_preview import (
    MAX_PDF_PREVIEW_BYTES, InvalidPreviewPdf, PdfPageOutOfRange, pdf_preview_available, render_pdf_page,
)


def sample_pdf(page_count: int = 2) -> bytes:
    objects = [b"<< /Type /Catalog /Pages 2 0 R >>"]
    children = " ".join(f"{3 + n * 2} 0 R" for n in range(page_count))
    objects.append(f"<< /Type /Pages /Count {page_count} /Kids [{children}] >>".encode())
    for page in range(page_count):
        stream_id = 4 + page * 2
        box = "/CropBox [30 40 230 140] /Rotate 90" if page % 2 else ""
        objects.append((
            f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] {box}"
            f" /Resources <<>> /Contents {stream_id} 0 R >>"
        ).encode())
        content = (b"0 0 1 rg 0 0 300 200 re f 0 1 0 rg 30 40 100 50 re f"
                   if page % 2 else b"1 0 0 rg 0 0 300 200 re f")
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode() + content + b"\nendstream")

    pdf = BytesIO()
    pdf.write(b"%PDF-1.4\n")
    offsets = []
    for index, obj in enumerate(objects, 1):
        offsets.append(pdf.tell())
        pdf.write(f"{index} 0 obj\n".encode() + obj + b"\nendobj\n")
    xref = pdf.tell()
    pdf.write(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets:
        pdf.write(f"{offset:010d} 00000 n \n".encode())
    pdf.write(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{xref}\n%%EOF".encode())
    return pdf.getvalue()


@unittest.skipUnless(pdf_preview_available(), "Poppler utilities are not installed")
class PdfPreviewTests(unittest.TestCase):
    def test_renders_selected_page_and_applies_crop_and_clockwise_rotation(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "preview.png"
            source.write_bytes(sample_pdf())
            render_pdf_page(source, output, 2, MAX_PDF_PREVIEW_BYTES)
            with Image.open(output) as image:
                self.assertEqual(image.size, (800, 1600))
                self.assertEqual(image.getpixel((200, 300)), (0, 255, 0))
                self.assertEqual(image.getpixel((600, 1200)), (0, 0, 255))

    def test_rejects_missing_page_and_long_or_corrupted_document(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.pdf"
            output = Path(directory) / "preview.png"
            source.write_bytes(sample_pdf())
            with self.assertRaises(PdfPageOutOfRange):
                render_pdf_page(source, output, 3, MAX_PDF_PREVIEW_BYTES)
            for data in (b"%PDF-1.4\ninvalid", sample_pdf(51)):
                source.write_bytes(data)
                with self.assertRaises(InvalidPreviewPdf):
                    render_pdf_page(source, output, 1, MAX_PDF_PREVIEW_BYTES)
            self.assertFalse(output.exists())
