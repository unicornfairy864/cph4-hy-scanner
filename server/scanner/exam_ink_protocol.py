import json


CANDIDATE_OPERATIONS = ("exam_ink_candidates", "exam_ink_ai_candidates")
APPLY_OPERATION = "exam_ink_apply"
MAX_REGIONS = 64
MAX_STROKES = 48
MAX_POINTS_PER_STROKE = 128
MAX_TOTAL_POINTS = 384
MAX_PLAN_BYTES = 12 * 1024
MAX_RADIUS = 0.10


class InvalidInkPlan(ValueError):
    """The edit plan is missing or outside its geometry and size limits."""


def _coordinate(value: object) -> float:
    if type(value) not in (int, float) or not 0 <= value <= 1:
        raise InvalidInkPlan
    return float(value) if value else 0.0


def normalized_box(value: object) -> list[float]:
    if not isinstance(value, list) or len(value) != 4:
        raise InvalidInkPlan
    x, y, width, height = (_coordinate(number) for number in value)
    if x + width > 1 + 1e-9 or y + height > 1 + 1e-9:
        raise InvalidInkPlan
    width, height = min(width, 1 - x), min(height, 1 - y)
    if width <= 0 or height <= 0:
        raise InvalidInkPlan
    return [x, y, width, height]


def _point(value: object) -> list[float]:
    if not isinstance(value, list) or len(value) != 2:
        raise InvalidInkPlan
    return [_coordinate(value[0]), _coordinate(value[1])]


def parse_plan(raw: object) -> dict:
    if not isinstance(raw, str):
        raise InvalidInkPlan
    try:
        if len(raw.encode("utf-8")) > MAX_PLAN_BYTES:
            raise InvalidInkPlan
        plan = json.loads(raw)
    except (ValueError, RecursionError) as error:
        raise InvalidInkPlan from error

    if not isinstance(plan, dict) or set(plan) != {"regions", "erase", "protect"}:
        raise InvalidInkPlan
    regions = plan["regions"]
    if not isinstance(regions, list) or len(regions) > MAX_REGIONS:
        raise InvalidInkPlan
    normalized = {"regions": [normalized_box(box) for box in regions], "erase": [], "protect": []}
    total_points = 0
    for kind in ("erase", "protect"):
        strokes = plan[kind]
        if not isinstance(strokes, list) or len(strokes) > MAX_STROKES:
            raise InvalidInkPlan
        for stroke in strokes:
            if not isinstance(stroke, dict) or set(stroke) != {"points", "radius"}:
                raise InvalidInkPlan
            points = stroke["points"]
            radius = _coordinate(stroke["radius"])
            if (not 0 < radius <= MAX_RADIUS or not isinstance(points, list)
                    or not 1 <= len(points) <= MAX_POINTS_PER_STROKE):
                raise InvalidInkPlan
            total_points += len(points)
            if total_points > MAX_TOTAL_POINTS:
                raise InvalidInkPlan
            normalized[kind].append({"points": [_point(point) for point in points], "radius": radius})
    return normalized


def candidate_result(width: int, height: int, candidates: list, *, review_all: bool = False) -> dict:
    usable = []
    for candidate in candidates[:MAX_REGIONS * 2]:
        if not isinstance(candidate, dict):
            continue
        try:
            box = normalized_box(candidate.get("box"))
        except InvalidInkPlan:
            continue
        usable.append({"box": box, "review": review_all or candidate.get("review") is not False})
        if len(usable) == MAX_REGIONS:
            break
    return {"width": width, "height": height, "candidates": usable}
