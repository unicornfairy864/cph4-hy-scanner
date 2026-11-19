from pathlib import Path

import numpy as np
from PIL import Image, ImageFilter
from scipy import ndimage


TILE_ROWS = 192


def improve_clarity(image: Image.Image) -> Image.Image:
    """Boost existing luminance edges at two scales and limit overshoot."""
    luminance = image.convert("L")
    source = np.asarray(image)
    gray = np.asarray(luminance)
    radius = float(np.clip(max(image.size) / 1300, 0.9, 2.1))
    near = np.asarray(luminance.filter(ImageFilter.GaussianBlur(radius)))
    far = np.asarray(luminance.filter(ImageFilter.GaussianBlur(radius * 2.5)))
    result = np.empty_like(source)
    for top in range(0, image.height, TILE_ROWS):
        rows = slice(top, top + TILE_ROWS)
        center = gray[rows].astype(np.float32)
        detail = 1.25 * (center - near[rows]) + 0.65 * (center - far[rows])
        # A soft threshold avoids amplifying most paper grain and JPEG noise.
        amount = np.sign(detail) * np.clip(np.abs(detail) - 2.5, 0, 36)
        result[rows] = np.rint(np.clip(source[rows] + amount[..., None], 0, 255))
    return Image.fromarray(result)


def _estimate_paper(image: Image.Image) -> np.ndarray:
    scale = min(1.0, 680 / max(image.size))
    size = tuple(max(1, round(side * scale)) for side in image.size)
    small = np.asarray(image.resize(size, Image.Resampling.BILINEAR))
    kernel = max(5, round(max(size) * 0.030)) | 1
    paper = np.empty_like(small)
    for channel in range(3):
        background = ndimage.grey_closing(small[..., channel], size=(kernel, kernel))
        paper[..., channel] = ndimage.gaussian_filter(background, sigma=1.4)
    return np.asarray(Image.fromarray(paper).resize(image.size, Image.Resampling.BILINEAR))


def clear_color_marks(image: Image.Image) -> Image.Image:
    """Remove red and blue ink while retaining the dark under-stroke signal."""
    source = np.asarray(image)
    result = source.copy()
    paper = None
    for top in range(0, image.height, TILE_ROWS):
        rows = slice(top, top + TILE_ROWS)
        red, green, blue = source[rows].astype(np.int16).transpose(2, 0, 1)
        red_strength = np.minimum(red - green, red - blue)
        blue_strength = np.minimum(blue - red, blue - green)
        strength = np.maximum(red_strength, blue_strength)
        colored = strength >= 15
        if not np.any(colored):
            continue
        if paper is None:
            paper = _estimate_paper(image)

        peak = np.maximum(red, blue)[colored].astype(np.float32)
        local = paper[rows][colored].astype(np.float32)
        white = np.maximum(local.max(axis=1), peak)
        # Bright channel contrast carries any underlying dark print. Deep
        # shadows stay dark, while pen on open paper approaches the paper tone.
        relative = peak / np.maximum(white, 1)
        lift = np.clip((relative - 0.26) / 0.38, 0, 1)
        lift = lift * lift * (3 - 2 * lift)
        neutral = local * np.minimum(relative, 1)[:, None]
        replacement = neutral + lift[:, None] * (local - neutral)
        opacity = np.clip((strength[colored] - 13) / 13, 0, 1)[:, None]
        original = source[rows][colored]
        result[rows][colored] = np.rint(original + opacity * (replacement - original))
    return Image.fromarray(result)


def process_restoration(source: Path, output: Path, operation: str, pixel_limit: int) -> None:
    if operation == "clarify":
        restore = improve_clarity
    elif operation == "exam_restore":
        restore = clear_color_marks
    else:
        raise ValueError("Unknown restoration operation")

    with Image.open(source, formats=["JPEG"]) as incoming:
        if (incoming.width * incoming.height > pixel_limit or max(incoming.size) > 8192
                or min(incoming.size) < 64):
            raise ValueError("image dimensions exceed configured limits")
        image = incoming.convert("RGB")
    restore(image).save(output, format="JPEG", quality=90, optimize=False)
