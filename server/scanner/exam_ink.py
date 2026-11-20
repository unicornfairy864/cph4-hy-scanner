from dataclasses import dataclass

import numpy as np
from PIL import Image, ImageDraw, ImageFilter
from scipy import ndimage

from scanner.restoration import _estimate_paper


ANALYSIS_EDGE = 1280
MAX_COMPONENTS = 25_000
MAX_CANDIDATES = 64


@dataclass(frozen=True, slots=True)
class Candidate:
    label: int
    box: tuple[int, int, int, int]
    review: bool


def _label_ink(image: Image.Image) -> tuple[np.ndarray, list[Candidate]]:
    scale = min(1.0, ANALYSIS_EDGE / max(image.size))
    size = tuple(max(1, round(side * scale)) for side in image.size)
    reduced = image.convert("RGB").resize(size, Image.Resampling.BILINEAR)
    gray = np.asarray(reduced.convert("L"))
    color = np.asarray(reduced)
    kernel = max(7, round(max(size) * 0.024)) | 1
    paper = ndimage.grey_closing(gray, size=(kernel, kernel))
    contrast = paper.astype(np.int16) - gray
    chroma = color.max(axis=2) - color.min(axis=2)
    ink = (contrast >= 23) & (gray < 196) & (chroma <= 48)
    labels, count = ndimage.label(ink, structure=np.ones((3, 3), dtype=np.uint8))
    if not count or count > MAX_COMPONENTS:
        return labels, []

    sizes = np.bincount(labels.ravel(), minlength=count + 1)
    bounds = ndimage.find_objects(labels)
    page_width, page_height = size
    max_glyph = max(12, max(size) * 0.04)
    glyph_ids = []
    glyph_heights = []
    for index, (rows, columns) in enumerate(bounds, 1):
        width = columns.stop - columns.start
        height = rows.stop - rows.start
        pixels = sizes[index]
        if (4 <= height <= max_glyph and 2 <= width <= max_glyph
                and width <= height * 2.5 and pixels >= 6 and pixels >= width * height * 0.24):
            glyph_ids.append(index)
            glyph_heights.append(height)

    glyph_height = max(7.0, float(np.median(glyph_heights))) if glyph_heights else max(7, max(size) * 0.014)
    glyph_width_limit = glyph_height * 2.5
    print_labels = np.zeros(count + 1, dtype=bool)
    for label in glyph_ids:
        rows, columns = bounds[label - 1]
        if rows.stop - rows.start <= glyph_height * 1.35 and columns.stop - columns.start <= glyph_width_limit:
            print_labels[label] = True
    print_pixels = print_labels[labels]

    candidates = []
    nearby = max(2, round(glyph_height * 0.6))
    for index, (rows, columns) in enumerate(bounds, 1):
        x0, y0, x1, y1 = columns.start, rows.start, columns.stop, rows.stop
        width, height = x1 - x0, y1 - y0
        density = sizes[index] / (width * height)
        # Locks out glyph-scale marks, rulers, large graphics and the page edge.
        if print_labels[index] or (height < glyph_height * 1.48 and width < glyph_height * 3.6):
            continue
        if (min(width, height) < 5 or not 0.027 <= density <= 0.56
                or max(width, height) > min(width, height) * 6
                or width > page_width * 0.32 or height > page_height * 0.20
                or min(x0, y0, page_width - x1, page_height - y1) < 2):
            continue
        area = print_pixels[max(0, y0 - nearby):min(page_height, y1 + nearby),
                            max(0, x0 - nearby):min(page_width, x1 + nearby)]
        # A component near ordinary glyphs or enclosing a large contour may
        # be a printed formula, a chart symbol or an empty field.
        review = bool(np.any(area))
        if not review:
            component = labels[rows, columns] == index
            enclosed = np.count_nonzero(ndimage.binary_fill_holes(component)) - sizes[index]
            review = bool(enclosed > width * height * 0.06)
        candidates.append(Candidate(index, (x0, y0, x1, y1), review))

    candidates.sort(key=lambda candidate: (candidate.review, candidate.box[1], candidate.box[0]))
    return labels, candidates[:MAX_CANDIDATES]


def detect_exam_ink(image: Image.Image) -> list[dict]:
    labels, candidates = _label_ink(image)
    height, width = labels.shape
    regions = []
    for candidate in candidates:
        x0, y0, x1, y1 = candidate.box
        left, top = max(0, x0 - 2), max(0, y0 - 2)
        right, bottom = min(width, x1 + 2), min(height, y1 + 2)
        regions.append({
            "box": [left / width, top / height, (right - left) / width, (bottom - top) / height],
            "review": candidate.review,
        })
    return regions


def _stroke_mask(size: tuple[int, int], strokes: list[dict]) -> Image.Image:
    width, height = size
    mask = Image.new("L", size)
    draw = ImageDraw.Draw(mask)
    for stroke in strokes:
        # The client and the job payload use a radius relative to the short edge.
        radius = max(1, round(stroke["radius"] * min(size)))
        points = [(round(x * (width - 1)), round(y * (height - 1))) for x, y in stroke["points"]]
        if len(points) > 1:
            draw.line(points, fill=255, width=radius * 2 + 1, joint="curve")
        for x, y in points:
            draw.ellipse((x - radius, y - radius, x + radius, y + radius), fill=255)
    return mask


def _pixels(box: list[float], width: int, height: int) -> tuple[int, int, int, int]:
    x, y, w, h = box
    return round(x * width), round(y * height), round((x + w) * width), round((y + h) * height)


def _region_mask(image: Image.Image, regions: list[list[float]], protection: Image.Image) -> np.ndarray:
    labels, candidates = _label_ink(image)
    height, width = labels.shape
    region_pixels = [_pixels(region, width, height) for region in regions]
    protected = np.asarray(protection.resize((width, height), Image.Resampling.BOX)) > 0
    label_allowed = np.zeros(int(labels.max()) + 1, dtype=np.uint8)

    for candidate in candidates:
        x0, y0, x1, y1 = candidate.box
        if candidate.review or np.any(protected[max(0, y0 - 1):y1 + 1, max(0, x0 - 1):x1 + 1]):
            continue
        # Approval authorizes a whole component. Its crossing a box edge is
        # evidence it might join surrounding printed content.
        if any(left < x0 and top < y0 and x1 < right and y1 < bottom
               for left, top, right, bottom in region_pixels):
            label_allowed[candidate.label] = 255

    if not np.any(label_allowed):
        return np.zeros((image.height, image.width), dtype=bool)
    ink = Image.fromarray(label_allowed[labels]).resize(image.size, Image.Resampling.NEAREST)
    # Include the anti-aliased edge of a selected stroke, clipped to its approved region.
    ink = np.asarray(ink.filter(ImageFilter.MaxFilter(3))) != 0
    allowed = np.zeros_like(ink)
    for region in regions:
        left, top, right, bottom = _pixels(region, image.width, image.height)
        allowed[top:bottom, left:right] = True
    return ink & allowed


def apply_exam_ink(image: Image.Image, plan: dict) -> Image.Image:
    rgb = image.convert("RGB")
    protection = _stroke_mask(rgb.size, plan["protect"])
    paint = np.array(_stroke_mask(rgb.size, plan["erase"]), dtype=bool)
    region = _region_mask(rgb, plan["regions"], protection) if plan["regions"] else None
    if not (np.any(paint) or (region is not None and np.any(region))):
        return rgb

    paper = _estimate_paper(rgb)
    result = np.array(rgb)
    protected = np.asarray(protection)
    # The automatic mask can include a projected margin on blank paper. Keep
    # those full-resolution pixels if there is no remaining dark ink signal.
    for top in range(0, rgb.height, 192):
        rows = slice(top, top + 192)
        mask = paint[rows].copy()
        if region is not None:
            shade = paper[rows].astype(np.int16) - result[rows]
            mask |= region[rows] & np.all(shade > 4, axis=2)
        mask &= protected[rows] == 0
        result[rows][mask] = paper[rows][mask]
    return Image.fromarray(result)
