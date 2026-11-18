import json
import os
from pathlib import Path
import shutil
import subprocess
from tempfile import TemporaryFile
from typing import Iterable

from PIL import Image


LANGUAGES = "chi_sim+eng"
OCR_MEMORY_LIMIT = 1024 * 1024 * 1024
OCR_UNAVAILABLE_EXIT = 4
TSV_HEADER = (
    "level", "page_num", "block_num", "par_num", "line_num", "word_num",
    "left", "top", "width", "height", "conf", "text",
)
LineKey = tuple[int, int, int, int]
Bounds = tuple[int, int, int, int]


class InvalidOcrImage(ValueError):
    """The submitted JPEG cannot be read for OCR."""


class OcrUnavailable(RuntimeError):
    """The OCR executable or an installed language is missing."""


def _is_cjk(character: str) -> bool:
    return "\u3400" <= character <= "\u9fff" or character in "，。！？；：、（）《》‘’“”"


def _line_text(words: list[str]) -> str:
    parts = [words[0]]
    for previous, current in zip(words, words[1:]):
        if not (_is_cjk(previous[-1]) and _is_cjk(current[0])):
            parts.append(" ")
        parts.append(current)
    return "".join(parts)


def parse_tsv(rows: Iterable[str], width: int, height: int) -> dict:
    stream = iter(rows)
    header = next(stream, "").rstrip("\r\n").split("\t")
    if tuple(header) != TSV_HEADER:
        raise RuntimeError("Unrecognized OCR output format")

    groups: dict[LineKey, tuple[list[str], Bounds]] = {}
    for row in stream:
        columns = row.rstrip("\r\n").split("\t", 11)
        if len(columns) != 12 or columns[0] != "5":
            continue
        token = " ".join(columns[11].split())
        if not token:
            continue
        try:
            page, block, paragraph, line = (int(column) for column in columns[1:5])
            x, y, word_width, word_height = (int(column) for column in columns[6:10])
        except ValueError:
            continue
        x0, y0 = max(0, x), max(0, y)
        x1, y1 = min(width, x + word_width), min(height, y + word_height)
        if x0 >= x1 or y0 >= y1:
            continue

        key = page, block, paragraph, line
        if key in groups:
            words, (left, top, right, bottom) = groups[key]
            words.append(token)
            groups[key] = words, (min(left, x0), min(top, y0), max(right, x1), max(bottom, y1))
        else:
            groups[key] = [token], (x0, y0, x1, y1)

    lines = [
        {"text": _line_text(words), "box": [left, top, right - left, bottom - top]}
        for words, (left, top, right, bottom) in groups.values()
    ]
    return {
        "text": "\n".join(line["text"] for line in lines),
        "width": width,
        "height": height,
        "lines": lines,
    }


def recognize_document(
    source: Path, output: Path, pixel_limit: int, byte_limit: int, languages: str = LANGUAGES,
) -> None:
    try:
        with Image.open(source, formats=["JPEG"]) as image:
            width, height = image.size
            if width * height > pixel_limit or max(image.size) > 8192:
                raise ValueError("image dimensions exceed configured limits")
            image.load()
    except (Image.DecompressionBombError, OSError, SyntaxError, ValueError):
        raise InvalidOcrImage from None

    executable = shutil.which("tesseract")
    if executable is None:
        raise OcrUnavailable
    environment = {key: os.environ[key] for key in ("PATH", "LANG", "TESSDATA_PREFIX")
                   if key in os.environ}
    environment.update(OMP_NUM_THREADS="1", OMP_THREAD_LIMIT="1")
    try:
        installed = subprocess.run(
            [executable, "--list-langs"], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL, env=environment, check=False,
        )
    except OSError:
        raise OcrUnavailable from None
    if installed.returncode or not set(languages.split("+")).issubset(
        installed.stdout.decode("utf-8", errors="replace").splitlines()
    ):
        raise OcrUnavailable

    # Keep intermediate text private and let the OS remove it even after a hard cancellation.
    with TemporaryFile(mode="w+", encoding="utf-8", errors="replace", dir=source.parent) as tsv:
        try:
            result = subprocess.run(
                [executable, str(source), "stdout", "-l", languages, "--psm", "3", "tsv"],
                stdin=subprocess.DEVNULL, stdout=tsv, stderr=subprocess.DEVNULL,
                env=environment, check=False,
            )
        except OSError:
            raise OcrUnavailable from None
        if result.returncode or os.fstat(tsv.fileno()).st_size > byte_limit:
            raise RuntimeError("OCR could not produce a bounded result")
        tsv.seek(0)
        document = parse_tsv(tsv, width, height)

    contents = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    if len(contents) > byte_limit:
        raise RuntimeError("OCR result exceeds the configured size limit")
    output.write_bytes(contents)
