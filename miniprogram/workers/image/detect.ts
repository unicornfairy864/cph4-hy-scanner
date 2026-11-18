import type { CornerConfidences, Detection, Frame, Point, Quad } from './types';

function luminance(red: number, green: number, blue: number): number {
  return (77 * red + 150 * green + 29 * blue) >> 8;
}

function cross(a: Point, b: Point, c: Point): number {
  return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
}

function edgeStrength({ width, height, data }: Frame): Uint16Array {
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < gray.length; i++) {
    const offset = 4 * i;
    gray[i] = luminance(data[offset], data[offset + 1], data[offset + 2]);
  }

  const strengths = new Uint16Array(gray.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      const upper = index - width;
      const lower = index + width;
      const horizontal = gray[upper + 1] + 2 * gray[index + 1] + gray[lower + 1]
        - gray[upper - 1] - 2 * gray[index - 1] - gray[lower - 1];
      const vertical = gray[lower - 1] + 2 * gray[lower] + gray[lower + 1]
        - gray[upper - 1] - 2 * gray[upper] - gray[upper + 1];
      strengths[index] = Math.abs(horizontal) + Math.abs(vertical);
    }
  }
  return strengths;
}

function edgeThreshold(strengths: Uint16Array): number {
  const histogram = new Uint32Array(2041);
  for (const strength of strengths) histogram[strength]++;
  const target = strengths.length * 0.88;
  let cumulative = 0;
  for (let strength = 0; strength < histogram.length; strength++) {
    cumulative += histogram[strength];
    if (cumulative >= target) return Math.max(36, Math.min(240, strength));
  }
  return 36;
}

function hull(points: Point[]): Point[] {
  points.sort((a, b) => a.x - b.x || a.y - b.y);
  const lower: Point[] = [];
  const upper: Point[] = [];
  for (const point of points) {
    while (lower.length > 1 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) {
      lower.pop();
    }
    lower.push(point);
  }
  for (let i = points.length - 1; i >= 0; i--) {
    const point = points[i];
    while (upper.length > 1 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) {
      upper.pop();
    }
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  return lower.concat(upper);
}

function quadrilateral(points: Point[]): Quad | null {
  if (points.length < 4) return null;
  const outline = hull(points);
  if (outline.length < 4) return null;

  while (outline.length > 4) {
    let leastCost = Infinity;
    let leastIndex = 0;
    for (let i = 0; i < outline.length; i++) {
      const before = outline[(i + outline.length - 1) % outline.length];
      const after = outline[(i + 1) % outline.length];
      const cost = Math.abs(cross(before, outline[i], after));
      if (cost < leastCost) {
        leastCost = cost;
        leastIndex = i;
      }
    }
    outline.splice(leastIndex, 1);
  }

  let first = 0;
  for (let i = 1; i < 4; i++) {
    if (outline[i].x + outline[i].y < outline[first].x + outline[first].y) first = i;
  }
  return [outline[first], outline[(first + 1) % 4], outline[(first + 2) % 4], outline[(first + 3) % 4]];
}

function scoreQuad(
  corners: Quad,
  strengths: Uint16Array,
  width: number,
  height: number,
  threshold: number,
): number {
  const area = (cross(corners[0], corners[1], corners[2]) + cross(corners[0], corners[2], corners[3])) / 2;
  const coverage = area / (width * height);
  if (coverage < 0.14 || coverage > 0.97) return 0;

  const sampleCount = 26;
  let totalSupport = 0;
  let weakestSide = 1;
  for (let side = 0; side < 4; side++) {
    const start = corners[side];
    const end = corners[(side + 1) % 4];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    if (length < Math.min(width, height) * 0.12) return 0;
    let supported = 0;
    for (let sample = 1; sample <= sampleCount; sample++) {
      const proportion = sample / (sampleCount + 1);
      const x = Math.round(start.x + (end.x - start.x) * proportion);
      const y = Math.round(start.y + (end.y - start.y) * proportion);
      let peak = 0;
      for (let row = Math.max(1, y - 3); row <= Math.min(height - 2, y + 3); row++) {
        for (let column = Math.max(1, x - 3); column <= Math.min(width - 2, x + 3); column++) {
          peak = Math.max(peak, strengths[row * width + column]);
        }
      }
      if (peak >= threshold) supported++;
    }
    const support = supported / sampleCount;
    weakestSide = Math.min(weakestSide, support);
    totalSupport += support / 4;
  }
  if (weakestSide < 0.40) return 0;
  return 0.62 * totalSupport + 0.21 * weakestSide + 0.17 * Math.min(1, coverage / 0.7);
}

function refineCorners(corners: Quad, edges: Uint16Array, width: number, height: number, threshold: number): Quad {
  const lines = corners.map((start, index) => {
    const end = corners[(index + 1) % 4];
    const length = Math.hypot(end.x - start.x, end.y - start.y);
    const alongX = (end.x - start.x) / length;
    const alongY = (end.y - start.y) / length;
    const normalX = -alongY;
    const normalY = alongX;
    let positionSum = 0;
    let offsetSum = 0;
    let positionSquaredSum = 0;
    let productSum = 0;
    let count = 0;
    for (let sample = 4; sample <= 20; sample++) {
      const position = length * sample / 24;
      let bestStrength = threshold;
      let bestOffset: number | undefined;
      for (let offset = -8; offset <= 8; offset++) {
        const x = Math.round(start.x + alongX * position + normalX * offset);
        const y = Math.round(start.y + alongY * position + normalY * offset);
        if (x < 1 || x >= width - 1 || y < 1 || y >= height - 1) continue;
        const strength = edges[y * width + x] / (1 + Math.abs(offset) * 0.045);
        if (strength > bestStrength) {
          bestStrength = strength;
          bestOffset = offset;
        }
      }
      if (bestOffset === undefined) continue;
      positionSum += position;
      offsetSum += bestOffset;
      positionSquaredSum += position * position;
      productSum += position * bestOffset;
      count++;
    }
    const denominator = count * positionSquaredSum - positionSum * positionSum;
    const slope = count >= 7 ? (count * productSum - positionSum * offsetSum) / denominator : 0;
    const shift = count >= 7 ? (offsetSum - slope * positionSum) / count : 0;
    const a = normalX - slope * alongX;
    const b = normalY - slope * alongY;
    return { a, b, c: a * start.x + b * start.y + shift };
  });

  const refined = lines.map((next, index) => {
    const previous = lines[(index + 3) % 4];
    const determinant = previous.a * next.b - previous.b * next.a;
    return {
      x: (previous.c * next.b - previous.b * next.c) / determinant,
      y: (previous.a * next.c - previous.c * next.a) / determinant,
    };
  }) as Quad;
  const plausible = refined.every((point, index) => (
    point.x >= 0 && point.x <= width - 1 && point.y >= 0 && point.y <= height - 1
    && Math.hypot(point.x - corners[index].x, point.y - corners[index].y) <= 14
    && cross(point, refined[(index + 1) % 4], refined[(index + 2) % 4]) > 0
  ));
  return plausible ? refined : corners;
}

function searchEdges(
  strengths: Uint16Array,
  width: number,
  height: number,
  threshold: number,
): { corners: Quad | null; score: number } {
  const connected = new Uint8Array(strengths.length);
  for (let y = 1; y < height - 1; y++) {
    for (let x = 1; x < width - 1; x++) {
      const index = y * width + x;
      if (strengths[index] < threshold) continue;
      connected.fill(1, index - width - 1, index - width + 2);
      connected.fill(1, index - 1, index + 2);
      connected.fill(1, index + width - 1, index + width + 2);
    }
  }

  const queue = new Int32Array(connected.length);
  const rowLeft = new Int16Array(height);
  const rowRight = new Int16Array(height);
  const minSpan = Math.min(width, height) * 0.2;
  let best: { corners: Quad | null; score: number } = { corners: null, score: 0 };

  for (let start = 0; start < connected.length; start++) {
    if (connected[start] === 0) continue;
    let tail = 1;
    let minX = width;
    let maxX = 0;
    let minY = height;
    let maxY = 0;
    queue[0] = start;
    connected[start] = 0;
    for (let head = 0; head < tail; head++) {
      const index = queue[head];
      const x = index % width;
      const y = (index - x) / width;
      if (strengths[index] >= threshold) {
        minX = Math.min(minX, x);
        maxX = Math.max(maxX, x);
        minY = Math.min(minY, y);
        maxY = Math.max(maxY, y);
      }
      if (x > 0 && connected[index - 1]) {
        connected[index - 1] = 0;
        queue[tail++] = index - 1;
      }
      if (x < width - 1 && connected[index + 1]) {
        connected[index + 1] = 0;
        queue[tail++] = index + 1;
      }
      if (y > 0 && connected[index - width]) {
        connected[index - width] = 0;
        queue[tail++] = index - width;
      }
      if (y < height - 1 && connected[index + width]) {
        connected[index + width] = 0;
        queue[tail++] = index + width;
      }
    }
    if (maxX - minX < minSpan || maxY - minY < minSpan) continue;

    rowLeft.fill(width, minY, maxY + 1);
    rowRight.fill(-1, minY, maxY + 1);
    for (let i = 0; i < tail; i++) {
      const index = queue[i];
      if (strengths[index] < threshold) continue;
      const x = index % width;
      const y = (index - x) / width;
      rowLeft[y] = Math.min(rowLeft[y], x);
      rowRight[y] = Math.max(rowRight[y], x);
    }
    const extrema: Point[] = [];
    for (let y = minY; y <= maxY; y++) {
      if (rowRight[y] < 0) continue;
      extrema.push({ x: rowLeft[y], y });
      if (rowRight[y] > rowLeft[y]) extrema.push({ x: rowRight[y], y });
    }
    const corners = quadrilateral(extrema);
    if (!corners) continue;
    const score = scoreQuad(corners, strengths, width, height, threshold);
    if (score > best.score) best = { corners: refineCorners(corners, strengths, width, height, threshold), score };
  }
  return best;
}

interface SideLine {
  offset: number;
  slope: number;
  confidence: number;
  from: number;
  to: number;
}

const PROFILE_COUNT = 40;

function sideProfiles(frame: Frame, side: number, span: number, depth: number): Float32Array[] {
  const horizontal = side % 2 === 0;
  const reflected = side === 1 || side === 2;
  const last = (horizontal ? frame.height : frame.width) - 1;
  return Array.from({ length: PROFILE_COUNT }, (_, index) => {
    const along = Math.round(span * (0.04 + 0.92 * index / (PROFILE_COUNT - 1)));
    const luma = new Float32Array(depth + 17);
    const chroma = new Float32Array(depth + 17);
    for (let distance = 0; distance < luma.length; distance++) {
      const across = reflected ? last - distance : distance;
      for (let step = -2; step <= 2; step++) {
        const position = Math.max(0, Math.min(span, along + step));
        const x = horizontal ? position : across;
        const y = horizontal ? across : position;
        const pixel = 4 * (y * frame.width + x);
        const gray = luminance(frame.data[pixel], frame.data[pixel + 1], frame.data[pixel + 2]);
        luma[distance] += gray / 5;
        chroma[distance] += (frame.data[pixel + 2] - gray) / 5;
      }
    }
    const contrast = new Float32Array(depth + 1);
    for (let distance = 1; distance <= depth; distance++) {
      const near = Math.max(0, distance - 2);
      const far = Math.max(0, distance - 6);
      const closeContrast = luma[distance + 2] - luma[near];
      const innerPaper = Math.max(luma[distance + 6], luma[distance + 10], luma[distance + 13], luma[distance + 16]);
      const outerPaper = Math.max(luma[far], luma[Math.max(0, distance - 10)],
        luma[Math.max(0, distance - 13)], luma[Math.max(0, distance - 16)]);
      const spreadContrast = innerPaper - outerPaper;
      const chromaContrast = Math.abs(chroma[distance + 6] - chroma[far]);
      const signedEdge = 0.52 * closeContrast + 0.65 * spreadContrast;
      const pageContrast = Math.abs(spreadContrast) + 0.5 * chromaContrast;
      const edge = Math.sign(signedEdge) * (Math.abs(signedEdge) + 0.48 * chromaContrast);
      // Horizontal glyph strokes have a contrast peak but similar paper beyond the stroke.
      contrast[distance] = horizontal && pageContrast < 9 ? 0.3 * edge : edge;
    }
    return contrast;
  });
}

function detectSide(frame: Frame, side: number): SideLine | null {
  const horizontal = side % 2 === 0;
  const span = (horizontal ? frame.width : frame.height) - 1;
  const limit = Math.floor(0.29 * ((horizontal ? frame.height : frame.width) - 1));
  const profiles = sideProfiles(frame, side, span, limit);
  const positions = profiles.map((_, index) => span * (0.04 + 0.92 * index / (PROFILE_COUNT - 1)));
  let result: SideLine | null = null;
  let bestScore = 0;

  for (let angle = -22; angle <= 22; angle++) {
    const slope = angle * 0.025;
    const shifts = positions.map((position) => slope * (position - span / 2));
    for (let middle = -Math.floor(limit / 2); middle <= limit; middle += 2) {
      let count = 0;
      let observable = 0;
      let weight = 0;
      let polaritySum = 0;
      let meanDistance = 0;
      let first = -1;
      let last = -1;
      let runStart = -1;
      let longestRun = 0;

      for (let index = 0; index < profiles.length; index++) {
        const distance = Math.round(middle + shifts[index]);
        if (distance < 1 || distance > limit) continue;
        const profile = profiles[index];
        const before = 0.94 * profile[Math.max(0, distance - 1)];
        const after = 0.94 * profile[Math.min(limit, distance + 1)];
        let edge = profile[distance];
        if (Math.abs(before) > Math.abs(edge)) edge = before;
        if (Math.abs(after) > Math.abs(edge)) edge = after;
        const minimumContrast = distance <= 3 ? 18 : 11;
        if (distance > 3 || Math.abs(edge) >= minimumContrast) observable++;
        if (Math.abs(edge) < minimumContrast) continue;
        const support = Math.min(1, Math.abs(edge) / 38);
        weight += support;
        polaritySum += Math.sign(edge) * support;
        meanDistance += distance;
        count++;
        if (first < 0) first = index;
        if (last < 0 || index - last > 3) runStart = index;
        last = index;
        longestRun = Math.max(longestRun, index - runStart + 1);
      }
      if (count < 10 || longestRun < 9) continue;
      const coherence = Math.abs(polaritySum) / weight;
      const density = count / observable;
      if (density < 0.52 || coherence < 0.52) continue;
      // Prefer a credible exterior edge to a deeper line formed by printed text.
      const score = (weight + 0.62 * count + 0.18 * longestRun) / profiles.length
        - 1.55 * meanDistance / (count * limit) - 0.30 * (1 - coherence);
      if (score <= bestScore) continue;
      bestScore = score;
      result = {
        offset: middle - slope * span / 2,
        slope,
        confidence: Math.min(0.98, 0.47 + 0.27 * density + 0.24 * weight / profiles.length),
        from: positions[first],
        to: positions[last],
      };
    }
  }
  return bestScore >= 0.24 && result && result.confidence >= 0.68 ? result : null;
}

function sideConfidence(line: SideLine | null, along: number, span: number): number {
  if (!line) return 0.16;
  const gap = Math.max(line.from - along, along - line.to, 0);
  return line.confidence * Math.max(0.2, 1 - Math.max(0, gap / span - 0.07) * 3);
}

function intersectSides(horizontal: SideLine | null, vertical: SideLine | null,
  index: number, maxX: number, maxY: number): Point & { clipped: boolean } {
  const top = index < 2;
  const left = index === 0 || index === 3;
  const outsideX = left ? 0 : maxX;
  const outsideY = top ? 0 : maxY;
  const xSign = left ? 1 : -1;
  const ySign = top ? 1 : -1;
  // Move fitted sides slightly outwards to preserve content near rounded page corners.
  const hOffset = horizontal ? outsideY + ySign * (horizontal.offset - 2) : outsideY;
  const vOffset = vertical ? outsideX + xSign * (vertical.offset - 2) : outsideX;
  const hSlope = ySign * (horizontal?.slope ?? 0);
  const vSlope = xSign * (vertical?.slope ?? 0);
  let x = (vOffset + vSlope * hOffset) / (1 - hSlope * vSlope);
  let y = hOffset + hSlope * x;
  const clipped = x < 0 || x > maxX || y < 0 || y > maxY;
  if (y < 0 || y > maxY) {
    y = Math.max(0, Math.min(maxY, y));
    x = vOffset + vSlope * y;
  }
  if (x < 0 || x > maxX) {
    x = Math.max(0, Math.min(maxX, x));
    y = Math.max(0, Math.min(maxY, hOffset + hSlope * x));
  }
  return { x, y, clipped };
}

function inferredCorners(frame: Frame): { corners: Quad; cornerConfidences: CornerConfidences } | null {
  const [top, right, bottom, left] = [0, 1, 2, 3].map((side) => detectSide(frame, side));
  if ([top, right, bottom, left].filter(Boolean).length < 2) return null;

  const maxX = frame.width - 1;
  const maxY = frame.height - 1;
  const horizontal = [top, top, bottom, bottom];
  const vertical = [left, right, right, left];
  const frameMargin = Math.max(2, Math.min(maxX, maxY) * 0.018);
  const corners: Point[] = [];
  const confidences: number[] = [];
  for (let index = 0; index < 4; index++) {
    const h = horizontal[index];
    const v = vertical[index];
    const estimated = intersectSides(h, v, index, maxX, maxY);
    const horizontalConfidence = sideConfidence(h, estimated.x, maxX);
    const verticalConfidence = sideConfidence(v, estimated.y, maxY);
    const safeHorizontal = horizontalConfidence >= 0.5 ? h : null;
    const safeVertical = verticalConfidence >= 0.5 ? v : null;
    const { x, y } = intersectSides(safeHorizontal, safeVertical, index, maxX, maxY);
    const confidence = Math.min(horizontalConfidence, verticalConfidence);
    const frameX = index === 0 || index === 3 ? 0 : maxX;
    const frameY = index < 2 ? 0 : maxY;
    if (Math.abs(x - frameX) <= frameMargin && Math.abs(y - frameY) <= frameMargin) {
      corners.push({ x: frameX, y: frameY });
      confidences.push(Math.min(0.25, confidence));
      continue;
    }
    confidences.push(estimated.clipped ? Math.min(0.38, confidence) : confidence);
    corners.push({ x, y });
  }
  if (!corners.every((point, index) => cross(point, corners[(index + 1) % 4], corners[(index + 2) % 4]) > 0)) return null;
  const area = (cross(corners[0], corners[1], corners[2]) + cross(corners[0], corners[2], corners[3])) / 2;
  if (area < 0.36 * maxX * maxY || area > 0.995 * maxX * maxY) return null;
  return { corners: corners as Quad, cornerConfidences: confidences as CornerConfidences };
}

function detection(corners: Quad | null, width: number, height: number, confidence: number,
  cornerConfidences: CornerConfidences): Detection {
  const normalized = corners
    ? corners.map(({ x, y }) => ({ x: x / (width - 1), y: y / (height - 1) })) as Quad
    : null;
  return {
    corners: normalized,
    confidence,
    cornerConfidences,
  };
}

export function detectDocument(frame: Frame): Detection {
  const { width, height } = frame;
  if (width < 32 || height < 32) return detection(null, width, height, 0, [0, 0, 0, 0]);
  const edges = edgeStrength(frame);
  const threshold = edgeThreshold(edges);
  let best = searchEdges(edges, width, height, threshold);
  if (best.score < 0.82 && threshold > 45) {
    const lower = searchEdges(edges, width, height, Math.round(threshold * 0.62));
    if (lower.score > best.score) best = lower;
  }
  if (best.corners && best.score >= 0.65) {
    return detection(best.corners, width, height, best.score, [best.score, best.score, best.score, best.score]);
  }
  const inferred = inferredCorners(frame);
  if (inferred) {
    const confidence = inferred.cornerConfidences.reduce((sum, value) => sum + value, 0) / 4;
    return detection(inferred.corners, width, height, confidence, inferred.cornerConfidences);
  }
  return detection(null, width, height, best.score, [0, 0, 0, 0]);
}
