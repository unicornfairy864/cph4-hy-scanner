import asyncio
from io import BytesIO
import json
import os
from pathlib import Path
import sys
from tempfile import TemporaryDirectory
import time
import unittest
from unittest.mock import patch

from fastapi import HTTPException
import httpx
import numpy as np
from PIL import Image, ImageDraw, ImageFont

from scanner.app import Settings, WeChatExchange, create_app
from scanner.imaging import flatten_page, remove_shadow
from scanner.jobs import JobService, QueueFull
from scanner.ocr import TSV_HEADER
from scanner.pdf_preview import pdf_preview_available
from test_pdf_preview import sample_pdf


def sample_page() -> Image.Image:
    image = Image.new("RGB", (660, 800), (236, 236, 233))
    draw = ImageDraw.Draw(image)
    font = ImageFont.load_default(size=20)
    lines = [
        "Convert clear printed pages to a readable document.",
        "A curved book page may distort its lines of text.",
        "Paper color and handwritten annotations are kept.",
        "Multiple batches can include varied layouts and text.",
    ]
    for index, y in enumerate(range(72, 725, 32)):
        draw.text((52, y), lines[index % len(lines)], fill=(32, 32, 32), font=font)
    return image


def shadowed_page() -> Image.Image:
    pixels = np.asarray(sample_page()).astype(np.float32)
    pixels[:, :300] *= 0.54
    return Image.fromarray(np.uint8(pixels))


def curved_page() -> Image.Image:
    pixels = np.asarray(sample_page())
    curved = pixels.copy()
    height, width = pixels.shape[:2]
    x = np.linspace(-1, 1, width)
    offsets = np.rint(x * x * 68 + x * 8).astype(int)
    for column, offset in enumerate(offsets):
        curved[:, column] = pixels[np.clip(np.arange(height) - offset, 0, height - 1), column]
    return Image.fromarray(curved)


def jpeg(image: Image.Image) -> bytes:
    output = BytesIO()
    image.save(output, format="JPEG")
    return output.getvalue()


class AlgorithmTests(unittest.TestCase):
    def test_shadow_removal_reduces_paper_brightness_difference(self):
        initial = np.asarray(shadowed_page())
        corrected = np.asarray(remove_shadow(shadowed_page()))
        self.assertLess(abs(int(corrected[30, 30, 0]) - int(corrected[30, 500, 0])), 12)
        self.assertGreater(int(initial[30, 500, 0]) - int(initial[30, 30, 0]), 80)
        self.assertGreater(np.count_nonzero(corrected[:, :250, 0] < 120), 2000)

    def test_dewarp_improves_horizontal_alignment_of_text(self):
        input_page = curved_page()
        def rows_with_ink(image: Image.Image) -> float:
            ink = np.asarray(image.convert("L"))[60:740, 85:520] < 120
            return float(ink.sum(axis=1).std())

        for angle in (0, 90, 180, 270):
            with self.subTest(angle=angle):
                source = input_page.rotate(angle, expand=True)
                result = flatten_page(source)
                self.assertEqual(result.size, source.size)
                upright = result.rotate(-angle, expand=True)
                self.assertGreater(rows_with_ink(upright), rows_with_ink(input_page) * 1.25)


class ApiTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp = TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.settings = Settings("id", "secret", "x" * 40, Path(self.temp.name),
                                 task_timeout=7, task_ttl=2)
        app = create_app(self.settings, self.fake_login)
        await self.enterAsyncContext(app.router.lifespan_context(app))
        self.client = await self.enterAsyncContext(httpx.AsyncClient(
            transport=httpx.ASGITransport(app=app), base_url="http://test",
        ))

    async def fake_login(self, code: str) -> str:
        if code not in ("alice", "bob"):
            raise HTTPException(401)
        return code

    async def headers(self, code: str = "alice") -> dict[str, str]:
        response = await self.client.post("/v1/auth/wechat", json={"code": code})
        self.assertEqual(response.status_code, 200)
        return {"Authorization": "Bearer " + response.json()["accessToken"]}

    async def submit(self, headers, request_id="example", operation="deshadow", source=None, plan=None,
                     page_number=None):
        data = {"operation": operation, "clientRequestId": request_id}
        if plan is not None:
            data["plan"] = plan
        if page_number is not None:
            data["pageNumber"] = page_number
        filename = ("page.pdf", "application/pdf") if operation == "pdf_page_preview" else ("page.jpg", "image/jpeg")
        return await self.client.post(
            "/v1/jobs", headers=headers, data=data,
            files={"file": (filename[0], jpeg(shadowed_page()) if source is None else source, filename[1])},
        )

    async def wait_for_job(self, headers, path):
        end = time.monotonic() + 8
        while time.monotonic() < end:
            response = await self.client.get(path, headers=headers)
            self.assertEqual(response.status_code, 200)
            status = response.json()["status"]
            if status not in ("queued", "running"):
                return response
            await asyncio.sleep(0.03)
        self.fail("The test enhancement did not finish")

    async def test_owner_retries_result_and_delete(self):
        alice = await self.headers()
        bob = await self.headers("bob")
        submit = await self.submit(alice)
        self.assertEqual(submit.status_code, 202, submit.text)
        job_id = submit.json()["jobId"]
        path = f"/v1/jobs/{job_id}"
        self.assertEqual((await self.submit(alice)).json()["jobId"], job_id)
        self.assertEqual((await self.submit(alice, operation="dewarp")).status_code, 409)
        self.assertEqual((await self.client.get(path, headers=bob)).status_code, 404)
        self.assertEqual((await self.client.delete(path, headers=bob)).status_code, 404)
        self.assertEqual((await self.client.get(path + "/result", headers=bob)).status_code, 404)
        self.assertEqual((await self.client.get(path)).status_code, 401)
        self.assertEqual((await self.wait_for_job(alice, path)).json()["status"], "succeeded")
        result = await self.client.get(path + "/result", headers=alice)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.headers["content-type"], "image/jpeg")
        self.assertEqual(result.headers["cache-control"], "private, no-store")
        with Image.open(BytesIO(result.content)) as image:
            self.assertEqual(image.size, (660, 800))
        directory = self.settings.data_dir / "jobs" / job_id
        self.assertFalse((directory / "source.jpg").exists())
        self.assertEqual((await self.client.delete(path, headers=alice)).status_code, 204)
        self.assertFalse(directory.exists())
        self.assertEqual((await self.client.get(path, headers=alice)).status_code, 404)

    async def test_invalid_input_and_limits(self):
        token = await self.headers()
        self.assertEqual((await self.submit(token, source=b"not a jpeg")).status_code, 422)
        big = Image.new("RGB", (3000, 2200), "white")
        self.assertEqual((await self.submit(token, source=jpeg(big))).status_code, 413)
        self.assertEqual((await self.submit(token, source=b"x" * (8 * 2**20 + 1))).status_code, 413)
        self.assertEqual((await self.submit(token, request_id="invalid id")).status_code, 422)
        self.assertEqual((await self.submit(token, operation="unknown")).status_code, 422)

    async def test_unsupported_page_fails_without_persisting_input(self):
        token = await self.headers()
        data = jpeg(Image.new("RGB", (300, 400), "white"))
        submit = await self.submit(token, operation="dewarp", source=data)
        self.assertEqual(submit.status_code, 202)
        job_id = submit.json()["jobId"]
        path = f"/v1/jobs/{job_id}"
        result = (await self.wait_for_job(token, path)).json()
        self.assertEqual(result["status"], "failed")
        self.assertEqual(result["error"]["code"], "unsupported_page")
        self.assertFalse((self.settings.data_dir / "jobs" / job_id / "source.jpg").exists())
        self.assertEqual((await self.client.get(path + "/result", headers=token)).status_code, 409)

    async def test_delete_revokes_immediately_and_removes_files(self):
        token = await self.headers()
        submit = await self.submit(token)
        job_id = submit.json()["jobId"]
        path = f"/v1/jobs/{job_id}"
        self.assertEqual((await self.client.delete(path, headers=token)).status_code, 204)
        self.assertEqual((await self.client.get(path, headers=token)).status_code, 404)
        directory = self.settings.data_dir / "jobs" / job_id
        deadline = time.monotonic() + 3
        while directory.exists() and time.monotonic() < deadline:
            await asyncio.sleep(0.025)
        self.assertFalse(directory.exists())

    async def test_result_expires_and_files_are_removed(self):
        token = await self.headers()
        submit = await self.submit(token)
        job_id = submit.json()["jobId"]
        path = f"/v1/jobs/{job_id}"
        await self.wait_for_job(token, path)
        await asyncio.sleep(self.settings.task_ttl + 0.1)
        self.assertEqual((await self.client.get(path, headers=token)).status_code, 404)
        self.assertFalse((self.settings.data_dir / "jobs" / job_id).exists())

    def use_fake_tesseract(self, body: str, languages: tuple[str, ...] = ("chi_sim", "eng")):
        executable = self.settings.data_dir / "tesseract"
        language_output = "\n".join(languages)
        executable.write_text(
            f"#!{sys.executable}\n"
            "import os, sys\n"
            "if sys.argv[1:] == ['--list-langs']:\n"
            f"    print({language_output!r})\n"
            "    raise SystemExit(0)\n"
            "assert sys.argv[2:] == ['stdout', '-l', 'chi_sim+eng', '--psm', '3', 'tsv']\n"
            "assert os.environ['OMP_THREAD_LIMIT'] == os.environ['OMP_NUM_THREADS'] == '1'\n"
            + body,
            encoding="utf-8",
        )
        executable.chmod(0o700)
        return patch.dict(os.environ, {"PATH": f"{executable.parent}{os.pathsep}{os.environ.get('PATH', '')}"})

    async def test_ocr_result_is_private_and_cleans_up_source_and_result(self):
        header = "\t".join(TSV_HEADER)
        row = "5\t1\t1\t1\t1\t1\t20\t30\t90\t25\t99\t扫描"
        with self.use_fake_tesseract(f"print({header!r})\nprint({row!r})\n"):
            alice = await self.headers()
            bob = await self.headers("bob")
            submit = await self.submit(alice, operation="ocr")
            self.assertEqual(submit.status_code, 202, submit.text)
            job_id = submit.json()["jobId"]
            path = f"/v1/jobs/{job_id}"
            result_path = path + "/result"
            self.assertEqual((await self.submit(alice, operation="ocr")).json()["jobId"], job_id)
            self.assertEqual((await self.client.get(result_path)).status_code, 401)
            self.assertEqual((await self.client.get(result_path, headers=bob)).status_code, 404)
            self.assertEqual((await self.client.delete(path, headers=bob)).status_code, 404)
            self.assertEqual((await self.wait_for_job(alice, path)).json()["status"], "succeeded")
            result = await self.client.get(result_path, headers=alice)
            self.assertEqual(result.status_code, 200)
            self.assertEqual(result.headers["content-type"], "application/json")
            self.assertEqual(result.headers["cache-control"], "private, no-store")
            self.assertEqual(result.json(), {
                "text": "扫描", "width": 660, "height": 800,
                "lines": [{"text": "扫描", "box": [20, 30, 90, 25]}],
            })
            directory = self.settings.data_dir / "jobs" / job_id
            self.assertEqual([file.name for file in directory.iterdir()], ["result.json"])
            self.assertEqual((await self.client.delete(path, headers=alice)).status_code, 204)
            self.assertFalse(directory.exists())

    async def test_ocr_missing_language_does_not_disable_jpeg_jobs(self):
        token = await self.headers()
        with self.use_fake_tesseract("raise SystemExit(1)\n", languages=("eng",)):
            submit = await self.submit(token, operation="ocr")
            self.assertEqual(submit.status_code, 202, submit.text)
            job_id = submit.json()["jobId"]
            path = f"/v1/jobs/{job_id}"
            self.assertEqual((await self.wait_for_job(token, path)).json()["error"]["code"],
                             "ocr_unavailable")
            self.assertEqual((await self.client.get(path + "/result", headers=token)).status_code, 409)
            self.assertEqual(list((self.settings.data_dir / "jobs" / job_id).iterdir()), [])
            enhancement = await self.submit(token, operation="deshadow", request_id="jpeg")
            path = "/v1/jobs/" + enhancement.json()["jobId"]
            self.assertEqual((await self.wait_for_job(token, path)).json()["status"], "succeeded")

    async def test_ocr_cancellation_also_stops_descendants(self):
        token = await self.headers()
        started = self.settings.data_dir / "ocr-started"
        escaped = self.settings.data_dir / "ocr-escaped"
        child_source = f"from pathlib import Path; import time; time.sleep(0.9); Path({str(escaped)!r}).touch()"
        body = (
            "from pathlib import Path\n"
            "import subprocess\n"
            f"process = subprocess.Popen([sys.executable, '-c', {child_source!r}])\n"
            f"Path({str(started)!r}).touch()\n"
            "process.wait()\n"
        )
        with self.use_fake_tesseract(body):
            submit = await self.submit(token, operation="ocr")
            self.assertEqual(submit.status_code, 202, submit.text)
            job_id = submit.json()["jobId"]
            path = f"/v1/jobs/{job_id}"
            deadline = time.monotonic() + 5
            while not started.exists() and time.monotonic() < deadline:
                await asyncio.sleep(0.02)
            self.assertTrue(started.exists())
            self.assertEqual((await self.client.delete(path, headers=token)).status_code, 204)
            self.assertEqual((await self.client.get(path, headers=token)).status_code, 404)
            await asyncio.sleep(1.05)
            self.assertFalse(escaped.exists())
            self.assertFalse((self.settings.data_dir / "jobs" / job_id).exists())

    async def test_exam_ink_local_candidates_and_apply_require_no_provider(self):
        alice = await self.headers()
        bob = await self.headers("bob")
        with patch.dict(os.environ, {"SCANNER_ERASE_AI_MODEL": ""}):
            candidate_job = await self.submit(alice, operation="exam_ink_candidates")
            self.assertEqual(candidate_job.status_code, 202, candidate_job.text)
            path = "/v1/jobs/" + candidate_job.json()["jobId"]
            self.assertEqual((await self.wait_for_job(alice, path)).json()["status"], "succeeded")
            result = await self.client.get(path + "/result", headers=alice)
            self.assertEqual(result.headers["content-type"], "application/json")
            self.assertEqual(result.headers["cache-control"], "private, no-store")
            result = result.json()
            self.assertEqual((result["width"], result["height"]), (660, 800))
            self.assertIsInstance(result["candidates"], list)
            self.assertEqual((await self.client.get(path + "/result", headers=bob)).status_code, 404)

            plan = {"regions": [], "erase": [{"points": [[0.1, 0.12]], "radius": 0.02}], "protect": []}
            submit = await self.submit(alice, request_id="apply", operation="exam_ink_apply", plan=json.dumps(plan))
            self.assertEqual(submit.status_code, 202, submit.text)
            job_id = submit.json()["jobId"]
            path = f"/v1/jobs/{job_id}"
            same = await self.submit(alice, request_id="apply", operation="exam_ink_apply",
                                     plan=json.dumps(plan, sort_keys=True, separators=(",", ":")))
            self.assertEqual(same.json()["jobId"], job_id)
            plan["erase"][0]["radius"] = 0.03
            different = await self.submit(alice, request_id="apply", operation="exam_ink_apply", plan=json.dumps(plan))
            self.assertEqual(different.status_code, 409)
            self.assertEqual((await self.wait_for_job(alice, path)).json()["status"], "succeeded")
            result = await self.client.get(path + "/result", headers=alice)
            self.assertEqual(result.headers["content-type"], "image/jpeg")
            with Image.open(BytesIO(result.content)) as image:
                self.assertEqual(image.size, (660, 800))
            directory = self.settings.data_dir / "jobs" / job_id
            self.assertEqual([file.name for file in directory.iterdir()], ["result.jpg"])
            self.assertEqual((await self.client.delete(path, headers=alice)).status_code, 204)
            self.assertFalse(directory.exists())

    async def test_ink_apply_rejects_missing_or_invalid_plan_and_ai_requires_config(self):
        token = await self.headers()
        for plan in (None, '{}', '{"regions":[],"erase":[{"points":[],"radius":0.04}],"protect":[]}'):
            response = await self.submit(token, operation="exam_ink_apply", plan=plan)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["detail"]["code"], "invalid_exam_ink_plan")
        response = await self.submit(token, operation="exam_ink_candidates", plan="{}")
        self.assertEqual(response.status_code, 422)
        with patch.dict(os.environ, {"SCANNER_ERASE_AI_MODEL": ""}):
            response = await self.submit(token, operation="exam_ink_ai_candidates")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"]["code"], "exam_ink_ai_unavailable")
        self.assertEqual(list((self.settings.data_dir / "jobs").iterdir()), [])

    async def test_ink_ai_uses_only_dedicated_credentials(self):
        token = await self.headers()
        provider = {"SCANNER_ERASE_AI_BASE_URL": "https://api.deepseek.com",
                    "SCANNER_ERASE_AI_API_KEY": "ink-mock-key", "SCANNER_ERASE_AI_MODEL": "deepseek-flash"}

        class CompletedWorker:
            async def wait(self):
                return 0

        async def worker(*args, env, **kwargs):
            self.assertEqual(args[3], "exam_ink_ai_candidates")
            for key, value in provider.items():
                self.assertEqual(env[key], value)
            self.assertNotIn("SCANNER_AI_API_KEY", env)
            self.assertNotIn("WECHAT_APP_SECRET", env)
            Path(args[5]).write_text('{"width":660,"height":800,"candidates":[]}')

            return CompletedWorker()

        with patch.dict(os.environ, {**provider, "SCANNER_AI_API_KEY": "unrelated-mock-key"}), patch(
            "scanner.jobs.asyncio.create_subprocess_exec", worker,
        ):
            submit = await self.submit(token, operation="exam_ink_ai_candidates")
            self.assertEqual(submit.status_code, 202)
            path = "/v1/jobs/" + submit.json()["jobId"]
            self.assertEqual((await self.wait_for_job(token, path)).json()["status"], "succeeded")
        result = await self.client.get(path + "/result", headers=token)
        self.assertEqual(result.headers["content-type"], "application/json")
        self.assertEqual(result.json(), {"width": 660, "height": 800, "candidates": []})

    @unittest.skipUnless(pdf_preview_available(), "Poppler utilities are not installed")
    async def test_pdf_preview_is_private_verifies_page_idempotency_and_cleans_source(self):
        alice, bob = await self.headers(), await self.headers("bob")
        source = sample_pdf()
        submit = await self.submit(alice, operation="pdf_page_preview", source=source, page_number="2")
        self.assertEqual(submit.status_code, 202, submit.text)
        job_id = submit.json()["jobId"]
        path = f"/v1/jobs/{job_id}"
        retry = await self.submit(alice, operation="pdf_page_preview", source=source, page_number="2")
        self.assertEqual(retry.json()["jobId"], job_id)
        wrong_page = await self.submit(alice, operation="pdf_page_preview", source=source, page_number="1")
        self.assertEqual(wrong_page.status_code, 409)
        self.assertEqual((await self.client.get(path + "/result", headers=bob)).status_code, 404)
        self.assertEqual((await self.wait_for_job(alice, path)).json()["status"], "succeeded")
        result = await self.client.get(path + "/result", headers=alice)
        self.assertEqual(result.status_code, 200)
        self.assertEqual(result.headers["content-type"], "image/png")
        self.assertEqual(result.headers["cache-control"], "private, no-store")
        with Image.open(BytesIO(result.content), formats=["PNG"]) as image:
            self.assertEqual(image.size, (800, 1600))
        directory = self.settings.data_dir / "jobs" / job_id
        self.assertEqual([file.name for file in directory.iterdir()], ["result.png"])
        self.assertEqual((await self.client.delete(path, headers=alice)).status_code, 204)
        self.assertFalse(directory.exists())

    async def test_pdf_preview_enforces_operation_and_page_limit_and_has_clear_missing_tool_error(self):
        token = await self.headers()
        source = sample_pdf()
        self.assertEqual((await self.submit(token, source=source)).status_code, 422)
        for page in (None, "-1", "0", "51", "2.0"):
            response = await self.submit(token, operation="pdf_page_preview", source=source, page_number=page)
            self.assertEqual(response.status_code, 422)
            self.assertEqual(response.json()["detail"]["code"], "pdf_page_out_of_range")
        with patch("scanner.app.pdf_preview_available", return_value=False):
            response = await self.submit(token, operation="pdf_page_preview", source=source, page_number="1")
            self.assertEqual(response.status_code, 503)
            self.assertEqual(response.json()["detail"]["code"], "pdf_preview_unavailable")
        self.assertEqual(list((self.settings.data_dir / "jobs").iterdir()), [])

    async def test_smart_jobs_without_configuration_do_not_create_task_files(self):
        token = await self.headers()
        with patch.dict(os.environ, {"SCANNER_AI_MODEL": ""}):
            for operation in ("receipt", "identity", "exam"):
                response = await self.submit(token, operation=operation)
                self.assertEqual(response.status_code, 503)
                self.assertEqual(response.json(), {"detail": {"code": "smart_unavailable"}})
        self.assertEqual(list((self.settings.data_dir / "jobs").iterdir()), [])

    async def test_configured_smart_job_returns_private_json_using_worker_environment(self):
        token = await self.headers()
        bob = await self.headers("bob")
        document = '{"operation":"exam","title":"试卷识别","fields":[],"items":[],"warnings":[]}'
        ai = {"SCANNER_AI_BASE_URL": "https://example.test/v1",
              "SCANNER_AI_API_KEY": "test-only", "SCANNER_AI_MODEL": "test-vision"}

        class CompletedWorker:
            async def wait(self):
                return 0

        async def worker(*args, env, **kwargs):
            self.assertEqual(args[3], "exam")
            for key, value in ai.items():
                self.assertEqual(env[key], value)
            self.assertNotIn("WECHAT_APP_SECRET", env)
            self.assertNotIn("SCANNER_TOKEN_SECRET", env)
            Path(args[5]).write_text(document, encoding="utf-8")
            return CompletedWorker()

        with patch.dict(os.environ, ai), patch("scanner.jobs.asyncio.create_subprocess_exec", worker):
            response = await self.submit(token, operation="exam")
            self.assertEqual(response.status_code, 202)
            path = "/v1/jobs/" + response.json()["jobId"]
            self.assertEqual((await self.wait_for_job(token, path)).json()["status"], "succeeded")
            self.assertEqual((await self.client.get(path + "/result", headers=bob)).status_code, 404)
            result = await self.client.get(path + "/result", headers=token)
            self.assertEqual(result.headers["content-type"], "application/json")
            self.assertEqual(result.headers["cache-control"], "private, no-store")
            self.assertEqual(result.text, document)

    async def test_restoration_jobs_return_jpeg_without_provider_configuration(self):
        token = await self.headers()
        with patch.dict(os.environ, {"SCANNER_AI_MODEL": ""}):
            for operation in ("clarify", "exam_restore"):
                response = await self.submit(token, request_id=operation, operation=operation)
                self.assertEqual(response.status_code, 202)
                path = "/v1/jobs/" + response.json()["jobId"]
                self.assertEqual((await self.wait_for_job(token, path)).json()["status"], "succeeded")
                result = await self.client.get(path + "/result", headers=token)
                self.assertEqual(result.headers["content-type"], "image/jpeg")
                with Image.open(BytesIO(result.content)) as image:
                    self.assertEqual(image.size, (660, 800))

    async def test_wechat_exchange_sends_expected_fields(self):
        def respond(request: httpx.Request) -> httpx.Response:
            self.assertEqual(request.url.host, "api.weixin.qq.com")
            self.assertEqual(request.url.path, "/sns/jscode2session")
            self.assertEqual(request.url.params["js_code"], "some-code")
            self.assertEqual(request.url.params["appid"], self.settings.app_id)
            self.assertEqual(request.url.params["secret"], self.settings.app_secret)
            return httpx.Response(200, json={"openid": "wechat-user", "session_key": "secret"})

        async def check():
            async with httpx.AsyncClient(transport=httpx.MockTransport(respond)) as client:
                self.assertEqual(await WeChatExchange(self.settings, client)("some-code"),
                                 "wechat-user")

        await check()


class QueueTests(unittest.IsolatedAsyncioTestCase):
    async def test_capacity_and_serial_dispatch_after_worker_timeout(self):
        with TemporaryDirectory() as directory:
            jobs = JobService(Path(directory), 1024, 100_000, 0.01, 10,
                              queue_limit=2, owner_limit=1)
            await jobs.start()
            try:
                first = jobs.submit("alice", "first", "a", "deshadow", b"file")
                with self.assertRaises(QueueFull):
                    jobs.submit("alice", "second", "b", "deshadow", b"file")
                second = jobs.submit("bob", "first", "c", "deshadow", b"file")
                with self.assertRaises(QueueFull):
                    jobs.submit("carl", "first", "d", "deshadow", b"file")

                deadline = time.monotonic() + 6
                while second.status != "failed" and time.monotonic() < deadline:
                    if second.status == "running":
                        self.assertEqual(first.status, "failed")
                    await asyncio.sleep(0.005)
                self.assertEqual(first.error, "processing_timeout")
                self.assertEqual(second.error, "processing_timeout")
                self.assertFalse(first.source.exists())
                self.assertFalse(second.source.exists())
                self.assertIsNone(jobs.active)
            finally:
                await jobs.close()


if __name__ == "__main__":
    unittest.main()
