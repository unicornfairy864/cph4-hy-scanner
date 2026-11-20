import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx
from PIL import Image

from scanner.exam_ink_ai import erase_ai_config, extract_ai_candidates
from scanner.exam_ink_protocol import MAX_PLAN_BYTES, InvalidInkPlan, parse_plan
from scanner.smart import SmartError


class ExamInkProtocolTests(unittest.TestCase):
    def test_accepts_normalized_fields_and_single_point_brush(self):
        plan = {
            "regions": [[0.8, 0.2, 0.200000000001, 0.1]],
            "erase": [{"points": [[0, 1]], "radius": 0.02}],
            "protect": [],
        }
        normalized = parse_plan(json.dumps(plan))
        self.assertEqual(normalized["erase"], plan["erase"])
        self.assertAlmostEqual(normalized["regions"][0][2], 0.2)
        self.assertLessEqual(sum(normalized["regions"][0][::2]), 1)

    def test_rejects_invalid_geometry_and_bounded_plan_overflow(self):
        plan = {"regions": [], "erase": [], "protect": []}
        stroke = {"points": [[0, 0]] * 128, "radius": 0.02}
        invalid = [
            {**plan, "regions": [[0.9, 0, 0.2, 0.3]]},
            {**plan, "regions": [[True, 0, 0.2, 0.3]]},
            {**plan, "regions": [[float("nan"), 0, 0.2, 0.3]]},
            {**plan, "regions": [[0, 0, 0, 0.3]]},
            {**plan, "erase": [{**stroke, "radius": 0}]},
            {**plan, "erase": [{**stroke, "radius": 0.11}]},
            {**plan, "erase": [{**stroke, "points": [[0, 0]] * 129}]},
            {**plan, "erase": [stroke] * 3, "protect": [{"points": [[0, 0]], "radius": 0.02}]},
            {**plan, "protect": [{**stroke, "points": [[-0.1, 0]]}]},
            {"regions": [], "erase": []},
        ]
        for value in invalid:
            with self.subTest(value=str(value)[:90]), self.assertRaises(InvalidInkPlan):
                parse_plan(json.dumps(value))
        with self.assertRaises(InvalidInkPlan):
            parse_plan(" " * MAX_PLAN_BYTES + json.dumps(plan))


class ExamInkAiTests(unittest.TestCase):
    def test_provider_config_is_dedicated_and_uses_official_deepseek_endpoint(self):
        complete = {
            "SCANNER_ERASE_AI_BASE_URL": "https://api.deepseek.com/",
            "SCANNER_ERASE_AI_API_KEY": "mock-key",
            "SCANNER_ERASE_AI_MODEL": "deepseek-flash",
        }
        with patch.dict("os.environ", complete):
            config = erase_ai_config()
            self.assertEqual(config.endpoint, "https://api.deepseek.com/chat/completions")
            self.assertEqual(config.model, "deepseek-flash")
        with patch.dict("os.environ", {**complete, "SCANNER_ERASE_AI_MODEL": "", "SCANNER_AI_MODEL": "generic"}):
            self.assertIsNone(erase_ai_config())

    def test_ai_candidates_bound_geometry_and_require_review(self):
        complete = {
            "SCANNER_ERASE_AI_BASE_URL": "https://api.deepseek.com",
            "SCANNER_ERASE_AI_API_KEY": "mock-key",
            "SCANNER_ERASE_AI_MODEL": "deepseek-flash",
        }
        model_result = {"candidates": [
            {"box": [2, 0, 0.1, 0.2], "review": False},
            {"box": [0, 0, 0, 0.2], "review": False},
            *({"box": [index / 100, 0.1, 0.02, 0.03], "review": False}
              for index in range(70)),
        ]}

        def respond(request: httpx.Request) -> httpx.Response:
            self.assertEqual(str(request.url), "https://api.deepseek.com/chat/completions")
            self.assertEqual(request.headers["authorization"], "Bearer mock-key")
            body = json.loads(request.content)
            self.assertEqual(body["model"], "deepseek-flash")
            self.assertEqual(body["thinking"], {"type": "disabled"})
            self.assertTrue(body["messages"][1]["content"][1]["image_url"]["url"].startswith(
                "data:image/jpeg;base64,"))
            return httpx.Response(200, json={"choices": [{
                "finish_reason": "stop", "message": {"content": json.dumps(model_result)},
            }]})

        with TemporaryDirectory() as directory, patch.dict("os.environ", complete):
            source = Path(directory) / "fixture.jpg"
            Image.new("RGB", (120, 90), "white").save(source)
            with httpx.Client(transport=httpx.MockTransport(respond)) as client:
                result = extract_ai_candidates(source, 120, 90, 6_000_000, erase_ai_config(), client)
        self.assertEqual((result["width"], result["height"]), (120, 90))
        self.assertEqual(len(result["candidates"]), 64)
        self.assertTrue(all(candidate["review"] for candidate in result["candidates"]))
        self.assertEqual(result["candidates"][0]["box"], [0, 0.1, 0.02, 0.03])

    def test_absent_candidate_list_is_reported_as_provider_failure(self):
        complete = {
            "SCANNER_ERASE_AI_BASE_URL": "https://provider.example/v1",
            "SCANNER_ERASE_AI_API_KEY": "mock-key",
            "SCANNER_ERASE_AI_MODEL": "mock-vision",
        }
        mock = httpx.MockTransport(lambda _: httpx.Response(200, json={"choices": [{
            "finish_reason": "stop", "message": {"content": "{}"},
        }]}))
        with TemporaryDirectory() as directory, patch.dict("os.environ", complete):
            source = Path(directory) / "fixture.jpg"
            Image.new("RGB", (120, 90), "white").save(source)
            with httpx.Client(transport=mock) as client, self.assertRaises(SmartError):
                extract_ai_candidates(source, 120, 90, 6_000_000, erase_ai_config(), client)
