from collections.abc import Awaitable, Callable
from contextlib import asynccontextmanager
from dataclasses import dataclass
import hashlib
import hmac
from io import BytesIO
import json
import logging
import os
from pathlib import Path
import re
from time import time

from fastapi import FastAPI, HTTPException, Request, Response
import httpx
import jwt
from PIL import Image, UnidentifiedImageError
from pydantic import BaseModel, Field
from starlette.datastructures import Headers, UploadFile
from starlette.formparsers import MultiPartException
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from scanner.exam_ink_ai import erase_ai_config
from scanner.exam_ink_protocol import APPLY_OPERATION, MAX_PLAN_BYTES, InvalidInkPlan, parse_plan
from scanner.jobs import JSON_OPERATIONS, OPERATIONS, Job, JobService, QueueFull, RequestConflict
from scanner.pdf_preview import (
    MAX_PDF_PREVIEW_BYTES, MAX_PDF_PREVIEW_PAGES, PDF_PREVIEW_OPERATION,
    has_pdf_header, pdf_preview_available,
)
from scanner.smart import SMART_OPERATIONS, ProviderConfig


@dataclass(frozen=True, slots=True)
class Settings:
    app_id: str
    app_secret: str
    token_secret: str
    data_dir: Path
    max_bytes: int = 8 * 1024 * 1024
    max_pixels: int = 6_000_000
    task_timeout: float = 25.0
    task_ttl: float = 600.0
    session_ttl: int = 3600

    @classmethod
    def from_env(cls) -> "Settings":
        values = {name: os.environ.get(name, "") for name in
                  ("WECHAT_APP_ID", "WECHAT_APP_SECRET", "SCANNER_TOKEN_SECRET")}
        missing = [name for name, content in values.items() if not content]
        if missing:
            raise RuntimeError(f"Missing environment variables: {', '.join(missing)}")
        if len(values["SCANNER_TOKEN_SECRET"].encode()) < 32:
            raise RuntimeError("SCANNER_TOKEN_SECRET must have at least 32 bytes")
        return cls(
            app_id=values["WECHAT_APP_ID"], app_secret=values["WECHAT_APP_SECRET"],
            token_secret=values["SCANNER_TOKEN_SECRET"],
            data_dir=Path(os.environ.get("SCANNER_DATA_DIR", "./data")).resolve(),
        )


class LoginBody(BaseModel):
    code: str = Field(min_length=1, max_length=256)


class RequestBodyLimits:
    def __init__(self, app: ASGIApp, settings: Settings) -> None:
        self.app = app
        self.settings = settings

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http" or scope["method"] != "POST":
            await self.app(scope, receive, send)
            return

        limit = (self.settings.max_bytes + 16 * 1024
                 if scope["path"] == "/v1/jobs" else 16 * 1024)
        length = Headers(scope=scope).get("content-length")
        if length is not None and (not length.isascii() or not length.isdecimal()):
            await Response(status_code=400)(scope, receive, send)
            return
        if length is not None and (len(length) > 16 or int(length) > limit):
            await Response(status_code=413)(scope, receive, send)
            return

        total = 0
        too_large = False

        async def bounded_receive() -> Message:
            nonlocal total, too_large
            message = await receive()
            total += len(message.get("body", b""))
            if total > limit:
                too_large = True
                raise MultiPartException("Request body exceeds upload limit")
            return message

        async def bounded_send(message: Message) -> None:
            if too_large and message["type"] == "http.response.start":
                message["status"] = 413
            await send(message)

        await self.app(scope, bounded_receive, bounded_send)


class WeChatExchange:
    def __init__(self, settings: Settings, client: httpx.AsyncClient) -> None:
        self.settings = settings
        self.client = client

    async def __call__(self, code: str) -> str:
        try:
            response = await self.client.get(
                "https://api.weixin.qq.com/sns/jscode2session",
                params={"appid": self.settings.app_id, "secret": self.settings.app_secret,
                        "js_code": code, "grant_type": "authorization_code"},
            )
            response.raise_for_status()
            data = response.json()
        except (httpx.HTTPError, ValueError):
            raise HTTPException(503, "WeChat login unavailable") from None
        if not isinstance(data, dict):
            raise HTTPException(503, "WeChat login unavailable")
        if data.get("errcode") == -1:
            raise HTTPException(503, "WeChat login unavailable")
        open_id = data.get("openid")
        if data.get("errcode") or not isinstance(open_id, str) or not open_id:
            raise HTTPException(401, "WeChat login rejected")
        return open_id


def issue_token(settings: Settings, open_id: str) -> str:
    owner = hmac.new(settings.token_secret.encode(), open_id.encode(), "sha256").hexdigest()
    return jwt.encode({"sub": owner, "exp": int(time()) + settings.session_ttl,
                       "aud": "scanner-api"}, settings.token_secret, algorithm="HS256")


def authenticate(request: Request, settings: Settings) -> str:
    scheme, _, token = request.headers.get("authorization", "").partition(" ")
    if scheme.lower() != "bearer" or not token or len(token) > 2048:
        raise HTTPException(401, "Authentication required", headers={"WWW-Authenticate": "Bearer"})
    try:
        payload = jwt.decode(token, settings.token_secret, algorithms=["HS256"],
                             audience="scanner-api", options={"require": ["sub", "exp", "aud"]})
        subject = payload["sub"]
        if not re.fullmatch(r"[a-f0-9]{64}", subject):
            raise jwt.InvalidTokenError
        return subject
    except jwt.InvalidTokenError:
        raise HTTPException(401, "Session invalid or expired",
                            headers={"WWW-Authenticate": "Bearer"}) from None


def validate_image(contents: bytes, settings: Settings) -> None:
    if len(contents) > settings.max_bytes:
        raise HTTPException(413, "JPEG exceeds the byte limit")
    try:
        with Image.open(BytesIO(contents), formats=["JPEG"]) as image:
            if (image.width * image.height > settings.max_pixels or max(image.size) > 8192):
                raise HTTPException(413, "JPEG exceeds the pixel limit")
            if min(image.size) < 64:
                raise HTTPException(422, "The JPEG has a side shorter than 64 pixels")
    except Image.DecompressionBombError:
        raise HTTPException(413, "JPEG exceeds the pixel limit") from None
    except (UnidentifiedImageError, OSError, ValueError, SyntaxError):
        raise HTTPException(422, "A valid JPEG image is required") from None


def create_app(
    settings: Settings | None = None,
    exchange: Callable[[str], Awaitable[str]] | None = None,
) -> FastAPI:
    settings = settings if settings is not None else Settings.from_env()
    # The outbound exchange URL contains app credentials in its query string.
    logging.getLogger("httpx").setLevel(logging.WARNING)
    jobs = JobService(
        settings.data_dir, settings.max_bytes, settings.max_pixels, settings.task_timeout,
        settings.task_ttl,
    )

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        async with httpx.AsyncClient(timeout=5.0, trust_env=False) as client:
            app.state.exchange = exchange or WeChatExchange(settings, client)
            await jobs.start()
            try:
                yield
            finally:
                await jobs.close()

    app = FastAPI(title="Document scanner enhancement", lifespan=lifespan)
    app.add_middleware(RequestBodyLimits, settings=settings)

    def get_owned_job(request: Request, job_id: str) -> Job:
        owner = authenticate(request, settings)
        job = jobs.get(owner, job_id)
        if job is None:
            raise HTTPException(404, "Task not found or expired")
        return job

    @app.get("/healthz")
    async def health() -> dict:
        return {"status": "ok"}

    @app.post("/v1/auth/wechat")
    async def login(payload: LoginBody, response: Response) -> dict:
        open_id = await app.state.exchange(payload.code)
        response.headers["Cache-Control"] = "private, no-store"
        return {"accessToken": issue_token(settings, open_id), "expiresIn": settings.session_ttl}

    @app.post("/v1/jobs", status_code=202)
    async def submit(request: Request) -> dict:
        owner = authenticate(request, settings)
        if request.headers.get("content-type", "").partition(";")[0].strip().lower() != "multipart/form-data":
            raise HTTPException(415, "Use multipart/form-data")
        plan = None
        page_number = None
        async with request.form(max_files=1, max_fields=3, max_part_size=MAX_PLAN_BYTES) as form:
            operation = form.get("operation")
            request_id = form.get("clientRequestId")
            file = form.get("file")
            expected_fields = {"file", "operation", "clientRequestId"}
            if "plan" in form and operation == APPLY_OPERATION:
                expected_fields.add("plan")
            if "pageNumber" in form and operation == PDF_PREVIEW_OPERATION:
                expected_fields.add("pageNumber")
            if (len(form.multi_items()) != len(expected_fields) or set(form.keys()) != expected_fields
                    or operation not in OPERATIONS or not isinstance(request_id, str)
                    or not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", request_id)
                    or not isinstance(file, UploadFile)):
                raise HTTPException(422, "Provide the required fields for this operation")
            if operation in SMART_OPERATIONS and ProviderConfig.from_env() is None:
                raise HTTPException(503, {"code": "smart_unavailable"})
            if operation == "exam_ink_ai_candidates" and erase_ai_config() is None:
                raise HTTPException(503, {"code": "exam_ink_ai_unavailable"})
            if operation == APPLY_OPERATION:
                try:
                    plan = json.dumps(parse_plan(form.get("plan")), separators=(",", ":")).encode()
                except InvalidInkPlan:
                    raise HTTPException(422, {"code": "invalid_exam_ink_plan"}) from None
            byte_limit = settings.max_bytes
            if operation == PDF_PREVIEW_OPERATION:
                page = form.get("pageNumber")
                if (not isinstance(page, str) or not re.fullmatch(r"[1-9][0-9]?", page)
                        or int(page) > MAX_PDF_PREVIEW_PAGES):
                    raise HTTPException(422, {"code": "pdf_page_out_of_range"})
                page_number = int(page)
                if not pdf_preview_available():
                    raise HTTPException(503, {"code": "pdf_preview_unavailable"})
                byte_limit = min(settings.max_bytes, MAX_PDF_PREVIEW_BYTES)
            contents = await file.read(byte_limit + 1)

        source_hash = hashlib.sha256(contents)
        if page_number is None:
            validate_image(contents, settings)
            digest = hashlib.sha256(source_hash.digest() + plan) if plan is not None else source_hash
        else:
            if len(contents) > byte_limit:
                raise HTTPException(413, "PDF exceeds the byte limit")
            if not has_pdf_header(contents):
                raise HTTPException(422, {"code": "invalid_pdf"})
            digest = hashlib.sha256(source_hash.digest() + page_number.to_bytes(1))

        try:
            return jobs.submit(
                owner, request_id, digest.hexdigest(), operation, contents,
                plan=plan, page_number=page_number,
            ).as_dict()
        except QueueFull:
            raise HTTPException(429, "Enhancement queue or retained task limit reached",
                                headers={"Retry-After": "5"}) from None
        except RequestConflict:
            raise HTTPException(409, "clientRequestId is already used for another input") from None

    @app.get("/v1/jobs/{job_id}")
    async def status(request: Request, job_id: str, response: Response) -> dict:
        response.headers["Cache-Control"] = "private, no-store"
        return get_owned_job(request, job_id).as_dict()

    @app.get("/v1/jobs/{job_id}/result")
    async def result(request: Request, job_id: str) -> Response:
        job = get_owned_job(request, job_id)
        if job.status != "succeeded":
            raise HTTPException(409, "Result unavailable")
        try:
            contents = job.output.read_bytes()
        except FileNotFoundError:
            raise HTTPException(404, "Result not found or expired") from None
        if job.operation == PDF_PREVIEW_OPERATION:
            return Response(content=contents, media_type="image/png",
                            headers={"Cache-Control": "private, no-store"})
        if job.operation in JSON_OPERATIONS:
            return Response(content=contents, media_type="application/json",
                            headers={"Cache-Control": "private, no-store"})
        return Response(content=contents, media_type="image/jpeg",
                        headers={"Cache-Control": "private, no-store",
                                 "Content-Disposition": "attachment; filename=enhanced.jpg"})

    @app.delete("/v1/jobs/{job_id}", status_code=204)
    async def delete(request: Request, job_id: str) -> Response:
        jobs.delete(get_owned_job(request, job_id))
        return Response(status_code=204)

    return app
