import argparse
from pathlib import Path
import resource

from scanner.jobs import OPERATIONS, RESTORATION_OPERATIONS
from scanner.ocr import (
    OCR_MEMORY_LIMIT, OCR_UNAVAILABLE_EXIT, InvalidOcrImage, OcrUnavailable, recognize_document,
)


from scanner.smart import (
    SMART_OPERATIONS, InvalidSmartImage, ProviderConfig, SmartError, process_smart_document,
)


def lower_resource_limit(kind: int, maximum: int) -> None:
    bounded = [value for value in resource.getrlimit(kind) if value != resource.RLIM_INFINITY]
    limit = min([maximum, *bounded])
    resource.setrlimit(kind, (limit, limit))


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=OPERATIONS)
    parser.add_argument("source", type=Path)
    parser.add_argument("output", type=Path)
    parser.add_argument("pixel_limit", type=int)
    parser.add_argument("--byte-limit", type=int, default=8 * 1024 * 1024)
    args = parser.parse_args()

    if args.operation == "ocr":
        lower_resource_limit(resource.RLIMIT_AS, OCR_MEMORY_LIMIT)
        lower_resource_limit(resource.RLIMIT_FSIZE, args.byte_limit)
        try:
            recognize_document(args.source, args.output, args.pixel_limit, args.byte_limit)
        except OcrUnavailable:
            return OCR_UNAVAILABLE_EXIT
        except InvalidOcrImage:
            return 3
        except (OSError, RuntimeError):
            return 1
        return 0

    if args.operation in SMART_OPERATIONS:
        config = ProviderConfig.from_env()
        if config is None:
            return 5
        lower_resource_limit(resource.RLIMIT_AS, 768 * 1024 * 1024)
        lower_resource_limit(resource.RLIMIT_FSIZE, args.byte_limit)
        try:
            process_smart_document(args.source, args.output, args.operation, config,
                                   args.pixel_limit, args.byte_limit)
        except InvalidSmartImage:
            return 3
        except SmartError:
            return 6
        return 0

    if args.operation in RESTORATION_OPERATIONS:
        from scanner.restoration import process_restoration

        try:
            process_restoration(args.source, args.output, args.operation, args.pixel_limit)
        except (OSError, ValueError):
            return 3
        return 0

    from scanner.imaging import UnsuitablePage, process_image

    try:
        process_image(args.source, args.output, args.operation, args.pixel_limit)
    except UnsuitablePage:
        return 2
    except (OSError, ValueError):
        return 3
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
