import unittest

import numpy as np
from PIL import Image, ImageDraw, ImageFont

from scanner.exam_ink import apply_exam_ink, detect_exam_ink


PAPER = (246, 243, 230)
BLACK = (29, 27, 23)


def sample_exam() -> tuple[Image.Image, np.ndarray, np.ndarray, np.ndarray]:
    size = (720, 880)
    printed = Image.new("L", size)
    text = ImageDraw.Draw(printed)
    font = ImageFont.load_default(size=27)
    text.text((52, 48), "1. Solve the equation (x + 2) / 3 = 6.", fill=255, font=font)
    text.text((52, 330), "2. Record the results in the table.", fill=255, font=font)
    text.rectangle((57, 545, 665, 730), outline=255, width=3)
    text.line((57, 606, 665, 606), fill=255, width=3)
    text.line((321, 545, 321, 730), fill=255, width=3)
    text.text((74, 562), "x = 3", fill=255, font=font)

    isolated = Image.new("L", size)
    ImageDraw.Draw(isolated).line(
        ((434, 208), (457, 232), (484, 186), (502, 169)), fill=255, width=7,
    )
    touching = Image.new("L", size)
    ImageDraw.Draw(touching).line(
        ((282, 579), (310, 615), (361, 557)), fill=255, width=6,
    )

    output = Image.new("RGB", size, PAPER)
    for mask in (printed, isolated, touching):
        output.paste(BLACK, mask=mask)
    return output, *[np.asarray(mask) != 0 for mask in (printed, isolated, touching)]


def plan(*, regions=None, erase=None, protect=None) -> dict:
    return {"regions": regions or [], "erase": erase or [], "protect": protect or []}


class ExamInkTests(unittest.TestCase):
    def test_safe_candidate_erases_isolated_ink_and_preserves_print_and_crossing(self):
        exam, printed, isolated, touching = sample_exam()
        candidates = detect_exam_ink(exam)
        self.assertTrue(candidates)
        self.assertTrue(all(isinstance(candidate["review"], bool) for candidate in candidates))
        self.assertTrue(all(x >= 0 and y >= 0 and x + w <= 1 and y + h <= 1
                            for x, y, w, h in (candidate["box"] for candidate in candidates)))
        selected = [candidate["box"] for candidate in candidates if not candidate["review"]]
        self.assertTrue(selected)
        original = np.asarray(exam)
        fixed = np.asarray(apply_exam_ink(exam, plan(regions=selected)))
        paper_error = np.abs(fixed[isolated].astype(np.int16) - PAPER)
        self.assertGreater(np.mean(np.all(paper_error <= 5, axis=1)), 0.96)
        self.assertTrue(np.array_equal(fixed[printed | touching], original[printed | touching]))
        self.assertTrue(np.array_equal(fixed[~isolated], original[~isolated]))

    def test_a_box_crossing_component_boundary_does_not_allow_partial_erasure(self):
        exam, _, _, _ = sample_exam()
        width, height = exam.size
        region = [420 / width, 156 / height, 51 / width, 90 / height]
        fixed = apply_exam_ink(exam, plan(regions=[region]))
        self.assertTrue(np.array_equal(np.asarray(fixed), np.asarray(exam)))

    def test_oversized_user_box_does_not_erase_glyph_scale_or_connected_table_content(self):
        exam, printed, _, touching = sample_exam()
        fixed = np.asarray(apply_exam_ink(exam, plan(regions=[[0.0, 0.0, 1.0, 1.0]])))
        self.assertTrue(np.array_equal(fixed[printed | touching], np.asarray(exam)[printed | touching]))

    def test_an_ambiguous_closed_figure_is_review_only_even_inside_an_approved_region(self):
        exam = Image.new("RGB", (720, 880), PAPER)
        ImageDraw.Draw(exam).ellipse((225, 110, 310, 192), outline=BLACK, width=4)
        candidates = detect_exam_ink(exam)
        self.assertEqual(len(candidates), 1)
        self.assertTrue(candidates[0]["review"])
        fixed = apply_exam_ink(exam, plan(regions=[candidates[0]["box"]]))
        self.assertTrue(np.array_equal(np.asarray(fixed), np.asarray(exam)))

    def test_manual_brush_is_clipped_and_protection_takes_precedence(self):
        exam, _, _, _ = sample_exam()
        width, height = exam.size
        start = [145 / (width - 1), 606 / (height - 1)]
        end = [195 / (width - 1), 606 / (height - 1)]
        stroke = {"points": [start, end], "radius": 10 / width}
        preserve = {"points": [[171 / (width - 1), 608 / (height - 1)]], "radius": 7 / width}
        fixed = np.asarray(apply_exam_ink(exam, plan(erase=[stroke], protect=[preserve])))
        original = np.asarray(exam)
        self.assertLessEqual(np.abs(fixed[606, 145].astype(np.int16) - PAPER).max(), 5)
        self.assertEqual(tuple(fixed[606, 171]), BLACK)
        self.assertLessEqual(np.abs(fixed[606, 205].astype(np.int16) - PAPER).max(), 5)
        self.assertEqual(tuple(fixed[606, 206]), BLACK)
        self.assertTrue(np.array_equal(fixed[:595], original[:595]))
        self.assertTrue(np.array_equal(fixed[617:], original[617:]))

    def test_protection_skips_whole_region_candidate_and_blank_stays_unchanged(self):
        exam, _, _, _ = sample_exam()
        point = [457 / (exam.width - 1), 232 / (exam.height - 1)]
        protect = {"points": [point], "radius": 0.015}
        fixed = apply_exam_ink(exam, plan(regions=[[0, 0, 1, 1]], protect=[protect]))
        self.assertTrue(np.array_equal(np.asarray(fixed), np.asarray(exam)))

        blank = Image.new("RGB", (720, 880), PAPER)
        self.assertEqual(detect_exam_ink(blank), [])
        self.assertTrue(np.array_equal(np.asarray(apply_exam_ink(blank, plan(regions=[[0, 0, 1, 1]]))),
                                       np.asarray(blank)))


if __name__ == "__main__":
    unittest.main()
