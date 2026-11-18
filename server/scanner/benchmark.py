import argparse
import os
from pathlib import Path
import resource
import signal
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure one enhancement child on this host")
    parser.add_argument("operation", choices=("dewarp", "deshadow", "ocr"))
    parser.add_argument("jpeg", type=Path)
    args = parser.parse_args()
    with TemporaryDirectory() as data_dir:
        started = monotonic()
        output = Path(data_dir) / ("output.json" if args.operation == "ocr" else "output.jpg")
        with subprocess.Popen([
            sys.executable, "-m", "scanner.worker", args.operation, str(args.jpeg.resolve()),
            str(output), "6000000",
        ], start_new_session=True) as worker:
            try:
                status = worker.wait(timeout=25)
            except (subprocess.TimeoutExpired, KeyboardInterrupt):
                try:
                    os.killpg(worker.pid, signal.SIGKILL)
                except ProcessLookupError:
                    pass
                raise
        seconds = monotonic() - started
        peak_mib = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
        print(f"exit={status} wall_seconds={seconds:.3f} child_peak_mib={peak_mib:.1f}")
        return status


if __name__ == "__main__":
    raise SystemExit(main())
