import os
from pathlib import Path
import re
import shutil
import subprocess
from tempfile import TemporaryFile

from PIL import Image


PDF_PREVIEW_OPERATION = "pdf_page_preview"
MAX_PDF_PREVIEW_PAGES = 50
MAX_PDF_PREVIEW_BYTES = 8 * 1024 * 1024
MAX_PREVIEW_EDGE = 1600
MAX_PDF_INFO_BYTES = 128 * 1024


class PdfPreviewUnavailable(RuntimeError):
    """The VPS does not have Poppler's PDF command-line utilities."""


class InvalidPreviewPdf(ValueError):
    """The provided PDF is unsupported or could not be rendered."""


class PdfPageOutOfRange(ValueError):
    """The requested page does not exist in the uploaded PDF."""


def pdf_preview_available() -> bool:
    return bool(shutil.which("pdfinfo") and shutil.which("pdftoppm"))


def has_pdf_header(contents: bytes) -> bool:
    return b"%PDF-" in contents[:1024]


def render_pdf_page(source: Path, output: Path, page: int, byte_limit: int) -> None:
    pdfinfo, pdftoppm = shutil.which("pdfinfo"), shutil.which("pdftoppm")
    if pdfinfo is None or pdftoppm is None:
        raise PdfPreviewUnavailable
    environment = {key: os.environ[key] for key in ("PATH", "FONTCONFIG_PATH")
                   if key in os.environ}
    environment["LC_ALL"] = "C"
    try:
        with TemporaryFile(dir=source.parent) as report:
            info = subprocess.run(
                [pdfinfo, str(source)], stdin=subprocess.DEVNULL, stdout=report,
                stderr=subprocess.DEVNULL, env=environment, check=False,
            )
            report.seek(0)
            summary = report.read(MAX_PDF_INFO_BYTES + 1)
        count = re.findall(rb"^Pages:[ \t]+([0-9]{1,8})[ \t\r]*$", summary, re.MULTILINE)
        encrypted = re.findall(rb"^Encrypted:[ \t]+(yes|no)\b", summary, re.MULTILINE)
        if (info.returncode or len(summary) > MAX_PDF_INFO_BYTES or not count or not encrypted
                or encrypted[-1] != b"no"):
            raise InvalidPreviewPdf
        pages = int(count[-1])
        if not 1 <= pages <= MAX_PDF_PREVIEW_PAGES:
            raise InvalidPreviewPdf
        if not 1 <= page <= pages:
            raise PdfPageOutOfRange

        with output.open("wb") as image:
            result = subprocess.run(
                [pdftoppm, "-f", str(page), "-l", str(page), "-singlefile", "-cropbox",
                 "-scale-to", str(MAX_PREVIEW_EDGE), "-png", str(source)],
                stdin=subprocess.DEVNULL, stdout=image, stderr=subprocess.DEVNULL,
                env=environment, check=False,
            )
        if result.returncode or output.stat().st_size > byte_limit:
            raise InvalidPreviewPdf
        with Image.open(output, formats=["PNG"]) as preview:
            if max(preview.size) > MAX_PREVIEW_EDGE or min(preview.size) < 1:
                raise InvalidPreviewPdf
            preview.verify()
    except FileNotFoundError:
        raise PdfPreviewUnavailable from None
    except (Image.DecompressionBombError, OSError, SyntaxError):
        raise InvalidPreviewPdf from None
