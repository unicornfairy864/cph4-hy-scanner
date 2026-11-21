from pathlib import Path

import numpy as np
from PIL import Image
from scipy import ndimage, signal

try:
    import cv2
except ImportError:
    cv2 = None
else:
    cv2.setNumThreads(1)


class UnsuitablePage(ValueError):
    """The page lacks enough text structure for a reliable correction."""


def _analysis_image(image: Image.Image, longest: int) -> np.ndarray:
    width, height = image.size
    ratio = min(1.0, longest / max(width, height))
    size = (max(1, round(width * ratio)), max(1, round(height * ratio)))
    return np.asarray(image.convert("L").resize(size, Image.Resampling.LANCZOS))


def remove_shadow(image: Image.Image) -> Image.Image:
    gray = _analysis_image(image, 720)
    size = max(3, round(max(gray.shape) * 0.022)) | 1
    if cv2 is None:
        background = ndimage.grey_closing(gray, size=(size, size))
        background = ndimage.gaussian_filter(background, sigma=1.4)
    else:
        kernel = np.ones((size, size), dtype=np.uint8)
        background = cv2.morphologyEx(gray, cv2.MORPH_CLOSE, kernel)
        background = cv2.GaussianBlur(background, (0, 0), sigmaX=1.4)

    # Take a bright quantile of the estimated paper rather than forcing white.
    # Applying the same gain to all three channels retains colored annotations.
    target = min(246.0, float(np.percentile(background, 90)))
    light = np.asarray(
        Image.fromarray(background).resize(image.size, Image.Resampling.BILINEAR),
    )
    source = np.asarray(image)
    result = np.empty_like(source)
    for top in range(0, image.height, 256):
        bottom = min(top + 256, image.height)
        gain = target / np.maximum(light[top:bottom], 1)
        gain = np.clip(gain, 1.0, 2.6).astype(np.float32)
        result[top:bottom] = np.clip(source[top:bottom] * gain[..., None], 0, 255)
    return Image.fromarray(result)


def _text_signal(gray: np.ndarray, center: int, half_width: int) -> np.ndarray:
    strip = gray[:, center - half_width : center + half_width].astype(np.float32)
    smooth = ndimage.uniform_filter1d(strip, size=15, axis=0)
    ink = np.maximum(smooth - strip - 9, 0).mean(axis=1)
    ink = ndimage.gaussian_filter1d(ink, sigma=1.2)
    margin = max(2, len(ink) // 12)
    ink[:margin] = 0
    ink[-margin:] = 0
    peaks, _ = signal.find_peaks(ink, prominence=max(1.5, float(ink.max()) * 0.075), distance=5)
    if len(peaks) < 4:
        return np.zeros_like(ink)
    ink -= ink.mean()
    norm = np.linalg.norm(ink)
    return ink / norm if norm else ink


def _page_curve(gray: np.ndarray) -> tuple[np.ndarray, float, bool]:
    height, width = gray.shape
    if min(width, height) < 160:
        raise UnsuitablePage

    centers = np.round(np.linspace(width * 0.10, width * 0.90, 13)).astype(int)
    signals = [_text_signal(gray, center, max(10, width // 24)) for center in centers]
    max_step = max(3, min(20, round(height * 0.025)))
    offsets: dict[int, float] = {}
    current_run: dict[int, float] = {}
    run_score = 0.0
    best_score = 0.0
    shifts = np.arange(-max_step, max_step + 1)
    for index, profile in enumerate(signals):
        if not np.any(profile):
            current_run = {}
            run_score = 0.0
            continue
        if not current_run:
            current_run = {index: 0.0}
        else:
            previous = signals[index - 1]
            correlations = signal.correlate(profile, previous, mode="full")
            scores = correlations[height - 1 + shifts] - 0.011 * np.abs(shifts)
            best = int(np.argmax(scores))
            if scores[best] < 0.28 or abs(shifts[best]) == max_step:
                current_run = {index: 0.0}
                run_score = 0.0
            else:
                current_run[index] = current_run[index - 1] + float(shifts[best])
                run_score += float(scores[best])
        if len(current_run) > len(offsets) or (len(current_run) == len(offsets) and run_score > best_score):
            offsets = current_run.copy()
            best_score = run_score

    if len(offsets) < 7:
        raise UnsuitablePage
    indices = list(offsets)
    x = centers[indices] / width
    y = np.array(list(offsets.values()))
    polynomial = np.polynomial.Polynomial.fit(x, y, deg=2)
    residual = np.abs(polynomial(x) - y)
    accepted = residual <= max(2.5, float(np.median(residual)) * 2)
    if np.count_nonzero(accepted) < 7:
        raise UnsuitablePage
    polynomial = np.polynomial.Polynomial.fit(x[accepted], y[accepted], deg=2)
    if float(np.sqrt(np.mean((polynomial(x[accepted]) - y[accepted]) ** 2))) > 5:
        raise UnsuitablePage

    positions = np.linspace(0, 1, width)
    # Continue using the nearest reliable strip outside the detected text area.
    curve = polynomial(np.clip(positions, x[accepted].min(), x[accepted].max()))
    curve -= polynomial(0.5)
    if np.max(np.abs(curve)) > height * 0.14:
        raise UnsuitablePage
    left, right = x[accepted].min(), x[accepted].max()
    bend = abs(polynomial((left + right) / 2) - (polynomial(left) + polynomial(right)) / 2)
    return curve, best_score / (len(centers) - 1) * float(np.mean(accepted)), bool(bend >= 2.5)


def flatten_page(image: Image.Image) -> Image.Image:
    gray = _analysis_image(image, 900)
    selected = None
    selected_score = 0.0
    selected_bend = False
    sideways = False
    for candidate, transpose in ((gray, False), (gray.T, True)):
        try:
            curve, score, has_bend = _page_curve(candidate)
        except UnsuitablePage:
            continue
        # Columns of a regular layout can align as well as its actual text lines.
        # Favor a measured curve when the two directions have comparable support.
        if (selected is None or score > selected_score * 1.25
                or (has_bend and not selected_bend and score >= selected_score * 0.8)):
            selected = curve
            selected_score = score
            selected_bend = has_bend
            sideways = transpose
    if selected is None:
        raise UnsuitablePage

    source = np.asarray(image)
    if sideways:
        gray = gray.T
        source = source.swapaxes(0, 1)
        if cv2 is not None:
            source = np.ascontiguousarray(source)
    height, width = source.shape[:2]
    offset = np.interp(np.linspace(0, 1, width), np.linspace(0, 1, len(selected)), selected)
    offset = (offset * height / gray.shape[0]).astype(np.float32)
    result = np.empty_like(source)
    x = np.arange(width, dtype=np.float32)
    border = max(height * 0.045, float(np.max(np.abs(offset))) + 1)
    for top in range(0, height, 192):
        bottom = min(top + 192, height)
        y = np.arange(top, bottom, dtype=np.float32)
        taper = np.clip(np.minimum(y, height - 1 - y) / border, 0.0, 1.0)
        source_y = y[:, None] + taper[:, None] * offset
        source_x = np.broadcast_to(x, source_y.shape)
        if cv2 is None:
            for channel in range(source.shape[2]):
                result[top:bottom, :, channel] = ndimage.map_coordinates(
                    source[:, :, channel], (source_y, source_x), order=1, mode="nearest",
                )
        else:
            result[top:bottom] = cv2.remap(
                source, source_x, source_y, interpolation=cv2.INTER_LINEAR,
                borderMode=cv2.BORDER_REPLICATE,
            )
    return Image.fromarray(result.swapaxes(0, 1) if sideways else result)


def process_image(source: Path, output: Path, operation: str, pixel_limit: int) -> None:
    with Image.open(source, formats=["JPEG"]) as incoming:
        if incoming.width * incoming.height > pixel_limit or max(incoming.size) > 8192:
            raise ValueError("image dimensions exceed configured limits")
        image = incoming.convert("RGB")

    if operation == "deshadow":
        result = remove_shadow(image)
    else:
        result = flatten_page(image)
    result.save(output, format="JPEG", quality=90, optimize=False)
