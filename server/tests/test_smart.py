import base64
from io import BytesIO
import json
from pathlib import Path
from tempfile import TemporaryDirectory
import unittest
from unittest.mock import patch

import httpx
from PIL import Image

from scanner.smart import (
    MAX_PROVIDER_RESPONSE, ProviderConfig, SmartError, extract_document, normalize_document,
)


def completion(document: dict, finish_reason: str = "stop") -> dict:
    return {"choices": [{
        "finish_reason": finish_reason,
        "message": {"content": json.dumps(document, ensure_ascii=False)},
    }]}


class SmartDocumentTests(unittest.TestCase):
    def test_provider_configuration_requires_all_values_and_normalizes_endpoint(self):
        environment = {"SCANNER_AI_BASE_URL": "https://example.test/",
                       "SCANNER_AI_API_KEY": "test", "SCANNER_AI_MODEL": "test-vision"}
        with patch.dict("os.environ", environment):
            self.assertEqual(ProviderConfig.from_env().endpoint,
                             "https://example.test/v1/chat/completions")
        for base in ("https://example.test/v1/", "https://example.test/v1/chat/completions"):
            with patch.dict("os.environ", {**environment, "SCANNER_AI_BASE_URL": base}):
                self.assertEqual(ProviderConfig.from_env().endpoint,
                                 "https://example.test/v1/chat/completions")
        for base in ("http://example.test/v1", "https://name:password@example.test/v1",
                     "https://example.test/v1?hidden=credentials"):
            with patch.dict("os.environ", {**environment, "SCANNER_AI_BASE_URL": base}):
                self.assertIsNone(ProviderConfig.from_env())
        with patch.dict("os.environ", {**environment, "SCANNER_AI_MODEL": ""}):
            self.assertIsNone(ProviderConfig.from_env())

    def test_receipt_request_contains_only_sanitized_page_and_result_has_uncertainty(self):
        def respond(request: httpx.Request) -> httpx.Response:
            self.assertEqual(str(request.url), "https://example.test/v1/chat/completions")
            self.assertEqual(request.headers["authorization"], "Bearer test-key")
            payload = json.loads(request.content)
            self.assertEqual(payload["model"], "test-vision")
            self.assertEqual(payload["max_tokens"], 2400)
            self.assertEqual(len(payload["messages"]), 2)
            data_url = payload["messages"][1]["content"][1]["image_url"]["url"]
            data = base64.b64decode(data_url.removeprefix("data:image/jpeg;base64,"), validate=True)
            with Image.open(BytesIO(data)) as forwarded:
                self.assertEqual(forwarded.size, (128, 96))
                self.assertFalse(forwarded.getexif())
            return httpx.Response(200, json=completion({
                "fields": [
                    {"label": "总金额", "value": "  ¥23.00  ", "uncertain": False},
                    {"label": "日期", "value": "", "uncertain": False},
                    {"label": "票据号码", "value": "12?7"},
                    {"label": "未请求字段", "value": "irrelevant"},
                ],
                "items": [],
                "warnings": [],
            }))

        with TemporaryDirectory() as directory:
            source = Path(directory) / "sample.jpg"
            photo = Image.new("RGB", (128, 96), "white")
            exif = photo.getexif()
            exif[0x010F] = "test metadata"
            photo.save(source, exif=exif)
            config = ProviderConfig("https://example.test/v1/chat/completions", "test-key", "test-vision")
            with httpx.Client(transport=httpx.MockTransport(respond)) as client:
                document = extract_document(source, "receipt", config, 6_000_000, client)
        self.assertEqual(document["operation"], "receipt")
        self.assertEqual(document["fields"], [
            {"label": "总金额", "value": "¥23.00", "uncertain": False},
            {"label": "日期", "value": "", "uncertain": True},
            {"label": "票据号码", "value": "12?7", "uncertain": True},
        ])
        self.assertTrue(document["warnings"])

    def test_identity_fields_are_limited_to_requested_visible_document_fields(self):
        result = normalize_document({
            "fields": [
                {"label": "姓名", "value": "示例姓名", "uncertain": False},
                {"label": "证件号码", "value": "123?", "uncertain": True},
                {"label": "证件真伪", "value": "真", "uncertain": False},
            ],
            "warnings": ["号码末位模糊。"],
        }, "identity")
        self.assertEqual([field["label"] for field in result["fields"]], ["姓名", "证件号码"])
        self.assertTrue(result["fields"][1]["uncertain"])
        self.assertEqual(result["items"], [])

    def test_exam_only_labels_marks_when_evidence_was_returned(self):
        result = normalize_document({
            "fields": [],
            "items": [
                {"number": "1", "studentAnswer": "A", "status": "incorrect"},
                {"number": "2", "studentAnswer": "B", "correction": "应选C",
                 "evidence": "题号旁有红色叉号", "status": "incorrect"},
                {"number": "3", "evidence": "题号旁有绿色勾号", "status": "correct"},
            ],
            "warnings": [],
        }, "exam")
        self.assertEqual([item["status"] for item in result["items"]],
                         ["uncertain", "incorrect", "correct"])
        self.assertEqual(result["items"][1]["referenceAnswer"], "")
        self.assertEqual(result["items"][1]["correction"], "应选C")

    def test_provider_response_limit_incomplete_results_and_redirect_are_rejected(self):
        responses = (
            httpx.Response(200, content=b"x" * (MAX_PROVIDER_RESPONSE + 1)),
            httpx.Response(200, json=completion({"fields": [], "warnings": []}, "length")),
            httpx.Response(307, headers={"Location": "https://different.example.test"}),
        )
        with TemporaryDirectory() as directory:
            source = Path(directory) / "sample.jpg"
            Image.new("RGB", (128, 96), "white").save(source)
            config = ProviderConfig("https://example.test/v1/chat/completions", "test-key", "test-vision")
            for response in responses:
                with self.subTest(status=response.status_code):
                    requests = []

                    def respond(request: httpx.Request) -> httpx.Response:
                        requests.append(request)
                        return response

                    with httpx.Client(transport=httpx.MockTransport(respond), follow_redirects=True) as client:
                        with self.assertRaises(SmartError):
                            extract_document(source, "receipt", config, 6_000_000, client)
                    self.assertEqual(len(requests), 1)
