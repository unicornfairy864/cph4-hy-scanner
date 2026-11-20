from pathlib import Path
from tempfile import TemporaryDirectory
import unittest

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageFont

from scanner.restoration import clear_color_marks, improve_clarity, process_restoration


class RestorationTests(unittest.TestCase):
    def test_clarity_strengthens_existing_blurred_text_without_changing_flat_paper(self):
        original = Image.new("RGB", (700, 1000), (235, 232, 220))
        draw = ImageDraw.Draw(original)
        draw.text((60, 100), "Printed document for clarity repair", font=ImageFont.load_default(size=32),
                  fill=(150, 145, 137))
        blurred = original.filter(ImageFilter.GaussianBlur(2))
        corrected = improve_clarity(blurred)
        before = np.asarray(blurred.convert("L"), dtype=np.float32)
        after = np.asarray(corrected.convert("L"), dtype=np.float32)
        area = np.s_[80:160, 40:640]
        before_detail = np.abs(np.diff(before[area], axis=1)).sum()
        after_detail = np.abs(np.diff(after[area], axis=1)).sum()
        self.assertGreater(after_detail, before_detail * 1.12)
        self.assertTrue(np.array_equal(np.asarray(corrected)[200:], np.asarray(blurred)[200:]))
        self.assertEqual(corrected.size, original.size)

    def test_marks_clear_from_paper_without_erasing_dark_print_under_translucent_ink(self):
        base = Image.new("RGB", (640, 800), (243, 240, 227))
        draw = ImageDraw.Draw(base)
        draw.text((36, 53), "Question 1  Explain your answer", font=ImageFont.load_default(size=27),
                  fill=(51, 49, 41))
        draw.line((42, 200, 598, 200), fill=(76, 73, 65), width=6)
        clean = np.asarray(base).copy()
        marked = clean.copy()
        for (x0, x1), transmission in [
            ((140, 151), (0.94, 0.29, 0.39)),
            ((498, 509), (0.27, 0.39, 0.93)),
        ]:
            marked[150:250, x0:x1] = np.rint(clean[150:250, x0:x1] * transmission)
        corrected = np.asarray(clear_color_marks(Image.fromarray(marked)))
        for x in (145, 502):
            self.assertLess(np.abs(corrected[160, x].astype(int) - clean[160, x]).max(), 12)
            self.assertLess(corrected[200, x].mean(), 105)
        self.assertTrue(np.array_equal(corrected[:, :125], clean[:, :125]))

    def test_jpeg_operations_preserve_page_dimensions_and_validate_input(self):
        with TemporaryDirectory() as directory:
            source = Path(directory) / "source.jpg"
            output = Path(directory) / "result.jpg"
            Image.new("RGB", (64, 80), "white").save(source, format="JPEG")
            for operation in ("clarify", "exam_restore"):
                process_restoration(source, output, operation, pixel_limit=6000)
                with Image.open(output) as result:
                    self.assertEqual((result.format, result.size), ("JPEG", (64, 80)))
                with self.assertRaises(ValueError):
                    process_restoration(source, output, operation, pixel_limit=5000)
            with self.assertRaises(ValueError):
                process_restoration(source, output, "unknown", pixel_limit=6000)


if __name__ == "__main__":
    unittest.main()
