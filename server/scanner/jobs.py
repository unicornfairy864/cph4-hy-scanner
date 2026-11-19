import asyncio
from collections import deque
from dataclasses import dataclass
import fcntl
import logging
import os
from pathlib import Path
import shutil
import signal
import sys
from time import monotonic
from typing import Literal
from uuid import uuid4

from scanner.smart import AI_ENVIRONMENT, SMART_OPERATIONS


Operation = Literal["dewarp", "deshadow", "ocr", "receipt", "identity", "exam", "clarify", "exam_restore"]
RESTORATION_OPERATIONS = ("clarify", "exam_restore")
JSON_OPERATIONS = ("ocr", *SMART_OPERATIONS)
OPERATIONS = ("dewarp", "deshadow", *JSON_OPERATIONS, *RESTORATION_OPERATIONS)
Status = Literal["queued", "running", "succeeded", "failed"]
LOGGER = logging.getLogger(__name__)

ERRORS = {
    "unsupported_page": "This page does not have enough clear text lines for dewarping.",
    "invalid_image": "The uploaded JPEG could not be decoded.",
    "ocr_unavailable": "Install Tesseract and its Simplified Chinese and English language data.",
    "smart_unavailable": "Smart document recognition is not configured.",
    "smart_provider_error": "The document provider did not return a usable result.",
    "processing_error": "Enhancement could not be completed.",
    "processing_timeout": "Enhancement timed out.",
    "queue_timeout": "The queued task expired before processing.",
}


class QueueFull(Exception):
    pass


class RequestConflict(Exception):
    pass


@dataclass(slots=True)
class Job:
    id: str
    owner: str
    request_id: str
    digest: str
    operation: Operation
    directory: Path
    expires_at: float
    status: Status = "queued"
    error: str | None = None
    cancelled: bool = False

    @property
    def source(self) -> Path:
        return self.directory / "source.jpg"

    @property
    def output(self) -> Path:
        return self.directory / ("result.json" if self.operation in JSON_OPERATIONS else "result.jpg")

    def as_dict(self) -> dict:
        data = {"jobId": self.id, "status": self.status}
        if self.error:
            data["error"] = {"code": self.error, "message": ERRORS[self.error]}
        return data


class JobService:
    def __init__(
        self, root: Path, max_bytes: int, max_pixels: int, timeout: float, ttl: float,
        queue_limit: int = 8, owner_limit: int = 2,
    ) -> None:
        self.root = root
        self.max_bytes = max_bytes
        self.max_pixels = max_pixels
        self.timeout = timeout
        self.ttl = ttl
        self.queue_limit = queue_limit
        self.owner_limit = owner_limit
        self.jobs: dict[str, Job] = {}
        self.request_index: dict[tuple[str, str], str] = {}
        self.pending: deque[str] = deque()
        self.active: Job | None = None
        self.process: asyncio.subprocess.Process | None = None
        self.wake = asyncio.Event()
        self.stopping = False

    async def start(self) -> None:
        self.root.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.lock = (self.root / ".lock").open("a")
        try:
            fcntl.flock(self.lock.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            self.storage = self.root / "jobs"
            if self.storage.exists():
                shutil.rmtree(self.storage)
            self.storage.mkdir(mode=0o700)
        except BaseException:
            self.lock.close()
            raise
        self.dispatcher = asyncio.create_task(self._dispatch())
        self.reaper = asyncio.create_task(self._reap())

    async def close(self) -> None:
        self.stopping = True
        self.reaper.cancel()
        if self.active:
            self.delete(self.active)
        self.wake.set()
        try:
            await asyncio.gather(self.dispatcher, self.reaper, return_exceptions=True)
            shutil.rmtree(self.storage)
        finally:
            self.lock.close()

    def get(self, owner: str, job_id: str) -> Job | None:
        job = self.jobs.get(job_id)
        if job is None or job.owner != owner:
            return None
        if job.expires_at <= monotonic():
            self._expire(job)
            return self.jobs.get(job_id)
        return job

    def submit(
        self, owner: str, request_id: str, digest: str, operation: Operation, contents: bytes,
    ) -> Job:
        self._expire_jobs()
        request_key = (owner, request_id)
        existing_id = self.request_index.get(request_key)
        if existing_id:
            existing = self.jobs[existing_id]
            if existing.digest != digest or existing.operation != operation:
                raise RequestConflict
            return existing

        active_count = len(self.pending) + int(self.active is not None)
        owner_count = sum(1 for job in self.jobs.values()
                          if job.owner == owner and job.status in ("queued", "running"))
        if (self.stopping or active_count >= self.queue_limit or owner_count >= self.owner_limit
                or len(self.jobs) >= 128):
            raise QueueFull

        job_id = uuid4().hex
        job = Job(job_id, owner, request_id, digest, operation, self.storage / job_id,
                  monotonic() + 120)
        job.directory.mkdir(mode=0o700)
        try:
            job.source.write_bytes(contents)
        except BaseException:
            self._remove_files(job)
            raise
        self.jobs[job_id] = job
        self.request_index[request_key] = job_id
        self.pending.append(job_id)
        self.wake.set()
        return job

    def delete(self, job: Job) -> None:
        self.jobs.pop(job.id, None)
        self.request_index.pop((job.owner, job.request_id), None)
        job.cancelled = True
        if self.active is job:
            self._kill_process()
            return
        if job.status == "queued":
            self.pending.remove(job.id)
        self._remove_files(job)

    def _kill_process(self) -> None:
        if self.process:
            try:
                os.killpg(self.process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass

    def _remove_files(self, job: Job) -> None:
        try:
            shutil.rmtree(job.directory)
        except FileNotFoundError:
            pass
        except OSError:
            LOGGER.error("Could not remove an enhancement job directory")

    def _finish(self, job: Job, error: str | None = None) -> None:
        job.status = "failed" if error else "succeeded"
        job.error = error
        job.expires_at = monotonic() + self.ttl
        try:
            job.source.unlink(missing_ok=True)
            if error:
                job.output.unlink(missing_ok=True)
        except OSError:
            LOGGER.error("Could not immediately remove an enhancement job file")

    def _expire(self, job: Job) -> None:
        if job.status == "queued":
            self.pending.remove(job.id)
            self._finish(job, "queue_timeout")
        elif job.status != "running":
            self.delete(job)

    def _expire_jobs(self) -> None:
        now = monotonic()
        for job in list(self.jobs.values()):
            if now >= job.expires_at:
                self._expire(job)

    async def _reap(self) -> None:
        while True:
            await asyncio.sleep(min(1.0, self.ttl))
            self._expire_jobs()

    async def _dispatch(self) -> None:
        while not self.stopping:
            self._expire_jobs()
            if not self.pending:
                self.wake.clear()
                await self.wake.wait()
                continue
            self.active = self.jobs[self.pending.popleft()]
            self.active.status = "running"
            try:
                await self._process(self.active)
            except Exception:
                LOGGER.exception("Could not process an enhancement job")
                if not self.active.cancelled:
                    self._finish(self.active, "processing_error")
            finally:
                if self.active.cancelled:
                    self._remove_files(self.active)
                self.process = None
                self.active = None

    async def _process(self, job: Job) -> None:
        # Only pass runtime settings the image processor needs. It never inherits
        # WeChat credentials or the token signing key from the API.
        environment = {key: os.environ[key] for key in ("PATH", "PYTHONPATH", "LANG", "TESSDATA_PREFIX")
                       if key in os.environ}
        if job.operation in SMART_OPERATIONS:
            environment.update({key: os.environ[key] for key in AI_ENVIRONMENT if key in os.environ})
        environment.update(OPENBLAS_NUM_THREADS="1", OMP_NUM_THREADS="1", MKL_NUM_THREADS="1",
                           PYTHONDONTWRITEBYTECODE="1")
        self.process = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "scanner.worker", job.operation, str(job.source),
            str(job.output), str(self.max_pixels), "--byte-limit", str(self.max_bytes),
            stdin=asyncio.subprocess.DEVNULL, stdout=asyncio.subprocess.DEVNULL,
            stderr=asyncio.subprocess.DEVNULL, env=environment, start_new_session=True,
        )
        if job.cancelled:
            self._kill_process()
        try:
            code = await asyncio.wait_for(self.process.wait(), self.timeout)
        except TimeoutError:
            self._kill_process()
            await self.process.wait()
            if not job.cancelled:
                self._finish(job, "processing_timeout")
            return

        if job.cancelled:
            return
        if code == 0 and job.output.is_file() and job.output.stat().st_size <= self.max_bytes:
            self._finish(job)
        else:
            self._kill_process()
            errors = {
                2: "unsupported_page", 3: "invalid_image", 4: "ocr_unavailable",
                5: "smart_unavailable", 6: "smart_provider_error",
            }
            self._finish(job, errors.get(code, "processing_error"))
