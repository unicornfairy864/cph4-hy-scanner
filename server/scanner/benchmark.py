import argparse
from pathlib import Path
import resource
import subprocess
import sys
from tempfile import TemporaryDirectory
from time import monotonic


def main() -> int:
    parser = argparse.ArgumentParser(description="Measure one enhancement child on this host")
    parser.add_argument("operation", choices=("dewarp", "deshadow"))
    parser.add_argument("jpeg", type=Path)
    args = parser.parse_args()
    with TemporaryDirectory() as data_dir:
        started = monotonic()
        result = subprocess.run([
            sys.executable, "-m", "scanner.worker", args.operation, str(args.jpeg),
            str(Path(data_dir) / "output.jpg"), "6000000",
        ], check=False, timeout=25)
        seconds = monotonic() - started
        peak_mib = resource.getrusage(resource.RUSAGE_CHILDREN).ru_maxrss / 1024
        print(f"exit={result.returncode} wall_seconds={seconds:.3f} child_peak_mib={peak_mib:.1f}")
        return result.returncode


if __name__ == "__main__":
    raise SystemExit(main())
