import argparse
from pathlib import Path

from scanner.imaging import UnsuitablePage, process_image


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("dewarp", "deshadow"))
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("pixel_limit", type=int)
    args = parser.parse_args()

    try:
        process_image(args.source, args.output, args.operation, args.pixel_limit)
    except UnsuitablePage:
        return 2
    except (OSError, ValueError):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
