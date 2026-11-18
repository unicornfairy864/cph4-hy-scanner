import json
from pathlib import Path
import os
import shutil
import subprocess
from tempfile import TemporaryDirectory
import unittest

from PIL import Image, ImageDraw, ImageFont

from scanner.ocr import LANGUAGES, TSV_HEADER, parse_tsv, recognize_document


HEADER = "\t".join(TSV_HEADER)


class TsvTests(unittest.TestCase):
    def test_groups_words_by_paragraph_and_line_and_preserves_order(self):
        data = [
            HEADER,
            "4\t1\t1\t1\t1\t0\t0\t8\t320\t44\t-1\t",
            "5\t1\t1\t1\t1\t1\t-4\t12\t18\t17\t95\t简",
            "5\t1\t1\t1\t1\t2\t16\t10\t14\t20\t94\t体",
            "5\t1\t1\t1\t1\t3\t35\t10\t40\t18\t96\tChinese",
            "5\t1\t1\t1\t1\t4\t79\t15\t20\t12\t95\ttext",
            "5\t1\t1\t1\t2\t1\t104\t92\t35\t12\t89\tNext",
            "5\t1\t1\t1\t2\t2\t141\t89\t61\t20\t88\tline",
            "5\t1\t1\t2\t1\t1\t6\t110\t25\t17\t93\tSeparate",
            "5\t1\t1\t2\t1\t2\t1\t1\t1\t1\t95\t ",
            "5\t1\t1\t2\t1\t3\t300\t300\t1\t1\t95\tOutside",
        ]
        self.assertEqual(parse_tsv(data, 180, 120), {
            "text": "简体 Chinese text\nNext line\nSeparate",
            "width": 180,
            "height": 120,
            "lines": [
                {"text": "简体 Chinese text", "box": [0, 10, 99, 20]},
                {"text": "Next line", "box": [104, 89, 76, 20]},
                {"text": "Separate", "box": [6, 110, 25, 10]},
            ],
        })

    def test_blank_page_returns_valid_empty_result(self):
        self.assertEqual(parse_tsv([HEADER, "1\t1\t0\t0\t0\t0\t0\t0\t256\t256\t-1\t"], 256, 256),
                         {"text": "", "width": 256, "height": 256, "lines": []})


def available_languages() -> set[str]:
    executable = shutil.which("tesseract")
    if not executable:
        return set()
    return set(subprocess.run([executable, "--list-langs"], capture_output=True, text=True,
                              check=True, timeout=5).stdout.splitlines())


class RealOcrTests(unittest.TestCase):
    def require_language_data(self, languages: str) -> None:
        if set(languages.split("+")).issubset(available_languages()):
            return
        reason = f"Tesseract data for {languages} is required"
        if os.environ.get("SCANNER_REQUIRE_OCR_TESTS") == "1":
            self.fail(reason)
        self.skipTest(reason)

    def recognize_sample(
        self, lines: list[str], font: ImageFont.FreeTypeFont, languages: str, line_spacing: int = 86,
    ) -> dict:
        width, height = 1100, 760
        with TemporaryDirectory() as directory:
            source = Path(directory) / "sample.jpg"
            output = Path(directory) / "result.json"
            image = Image.new("RGB", (width, height), "white")
            draw = ImageDraw.Draw(image)
            for index, line in enumerate(lines):
                draw.text((78, 100 + index * line_spacing), line, font=font, fill="black")
            image.save(source, format="JPEG", quality=95, dpi=(300, 300))
            recognize_document(source, output, 6_000_000, 8 * 1024 * 1024, languages)
            result = json.loads(output.read_text())
        self.assertEqual((result["width"], result["height"]), (width, height))
        self.assertEqual(result["text"], "\n".join(line["text"] for line in result["lines"]))
        for line in result["lines"]:
            x, y, w, h = line["box"]
            self.assertTrue(0 <= x < x + w <= width and 0 <= y < y + h <= height)
        return result

    def test_real_english_ocr(self):
        self.require_language_data("eng")
        result = self.recognize_sample(
            ["Printed document in English", "Scanned text keeps each line"],
            ImageFont.load_default(size=50),
            "eng",
        )
        self.assertIn("printed document in english", result["text"].lower())
        self.assertIn("scanned text keeps each line", result["text"].lower())
        self.assertEqual(len(result["lines"]), 2)

    def test_real_simplified_chinese_and_english_ocr(self):
        self.require_language_data(LANGUAGES)
        font_path = Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc")
        if not font_path.is_file():
            reason = "Noto Sans CJK font is required to generate the bilingual OCR fixture"
            if os.environ.get("SCANNER_REQUIRE_OCR_TESTS") == "1":
                self.fail(reason)
            self.skipTest(reason)
        result = self.recognize_sample(
            [
                "简体中文印刷文字识别示例",
                "文档扫描保留清晰的文字和行序",
                "扫描后的文字可以复制和编辑",
                "本页包含中文与英文两段文字",
                "",
                "Printed document in English",
                "Scanned text keeps each line readable",
                "Each paragraph contains several lines",
            ],
            ImageFont.truetype(str(font_path), size=52, index=2),
            LANGUAGES,
            line_spacing=65,
        )
        text = result["text"].lower()
        expected = ["简体中文", "文档扫描", "printed document in english", "scanned text keeps each line readable"]
        for phrase in expected:
            self.assertIn(phrase, text)
        positions = [text.index(phrase) for phrase in expected]
        self.assertEqual(positions, sorted(positions))
        self.assertGreaterEqual(len(result["lines"]), 7)
