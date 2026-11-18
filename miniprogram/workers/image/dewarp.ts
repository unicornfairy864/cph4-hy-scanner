import type { Frame } from './types';

interface TextBand {
  center: number;
  first: number;
  offsets: number[];
  quality: number;
}

const ANALYSIS_EDGE = 640;
const STRIP_COUNT = 19;
const FIRST_STRIP = 0.075;
const STRIP_STEP = (0.958 - FIRST_STRIP) / (STRIP_COUNT - 1);

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function textProfiles(frame: Frame, width: number, height: number): Float32Array[] {
  const gray = new Uint8Array(width * height);
  const dark = new Float32Array(gray.length);
  const { data } = frame;
  for (let y = 0; y < height; y++) {
    const sourceY = Math.min(frame.height - 1, Math.floor((y + 0.5) * frame.height / height));
    for (let x = 0; x < width; x++) {
      const sourceX = Math.min(frame.width - 1, Math.floor((x + 0.5) * frame.width / width));
      const index = (sourceY * frame.width + sourceX) * 4;
      gray[y * width + x] = (77 * data[index] + 150 * data[index + 1] + 29 * data[index + 2]) >> 8;
    }
  }

  const radius = Math.max(4, Math.round(height * 0.01));
  const sum = new Uint32Array(height + 1);
  for (let x = 0; x < width; x++) {
    for (let y = 0; y < height; y++) sum[y + 1] = sum[y] + gray[y * width + x];
    for (let y = 0; y < height; y++) {
      const top = Math.max(0, y - radius);
      const bottom = Math.min(height, y + radius + 1);
      const background = (sum[bottom] - sum[top]) / (bottom - top);
      dark[y * width + x] = Math.max(0, background - gray[y * width + x] - 8);
    }
  }

  return Array.from({ length: STRIP_COUNT }, (_, column) => {
    const center = FIRST_STRIP + STRIP_STEP * column;
    // Narrow the margin strips so a sharp gutter turn stays in the text profile.
    const halfWidth = Math.min(0.038, 0.7 * Math.min(center, 1 - center));
    const left = Math.floor((center - halfWidth) * width);
    const right = Math.max(left + 1, Math.floor((center + halfWidth) * width));
    const rows = new Float32Array(height);
    for (let y = 0; y < height; y++) {
      for (let x = left; x < right; x++) rows[y] += dark[y * width + x];
      rows[y] /= right - left;
    }
    const smoothed = new Float32Array(height);
    for (let y = 2; y < height - 2; y++) {
      smoothed[y] = (rows[y - 2] + 4 * rows[y - 1] + 6 * rows[y]
        + 4 * rows[y + 1] + rows[y + 2]) / 16;
    }
    return smoothed;
  });
}

function hasText(profile: Float32Array, start: number, end: number): boolean {
  let peak = 0;
  for (let y = start; y < end; y++) peak = Math.max(peak, profile[y]);
  if (peak < 1.3) return false;

  let previous = -6;
  let count = 0;
  for (let y = start + 5; y < end - 5; y++) {
    if (profile[y] < profile[y - 1] || profile[y] <= profile[y + 1] || y - previous < 5) continue;
    const leftLow = Math.min(profile[y - 2], profile[y - 3], profile[y - 4], profile[y - 5]);
    const rightLow = Math.min(profile[y + 2], profile[y + 3], profile[y + 4], profile[y + 5]);
    const prominence = profile[y] - Math.max(leftLow, rightLow);
    if (prominence < Math.max(0.55, peak * 0.08)) continue;
    previous = y;
    if (++count === 2) return true;
  }
  return false;
}

function correlation(
  left: Float32Array, right: Float32Array, start: number, end: number, lag: number,
): number {
  const first = start + Math.max(0, -lag);
  const last = end - Math.max(0, lag);
  let sumLeft = 0;
  let sumRight = 0;
  let squareLeft = 0;
  let squareRight = 0;
  let product = 0;
  for (let y = first; y < last; y++) {
    const a = left[y];
    const b = right[y + lag];
    sumLeft += a;
    sumRight += b;
    squareLeft += a * a;
    squareRight += b * b;
    product += a * b;
  }
  const length = last - first;
  const varianceLeft = squareLeft - sumLeft * sumLeft / length;
  const varianceRight = squareRight - sumRight * sumRight / length;
  const denominator = Math.sqrt(Math.max(0, varianceLeft * varianceRight));
  if (denominator < 0.01) return -1;
  return (product - sumLeft * sumRight / length) / denominator - 0.014 * Math.abs(lag);
}

function stripShift(
  left: Float32Array, right: Float32Array, start: number, end: number, limit: number,
): { shift: number; score: number } | null {
  let bestLag = 0;
  let bestScore = -1;
  const scores = new Float32Array(limit * 2 + 1);
  for (let lag = -limit; lag <= limit; lag++) {
    const score = correlation(left, right, start, end, lag);
    scores[lag + limit] = score;
    if (score <= bestScore) continue;
    bestLag = lag;
    bestScore = score;
  }
  if (bestScore < 0.45 || Math.abs(bestLag) === limit) return null;

  // Refine the peak by a fraction of a pixel to avoid accumulating rounded shifts.
  const index = bestLag + limit;
  const before = scores[index - 1];
  const after = scores[index + 1];
  const curvature = before + after - 2 * bestScore;
  const fraction = curvature < -0.001 ? clamp((before - after) / (2 * curvature), -0.5, 0.5) : 0;
  return { shift: bestLag + fraction, score: bestScore };
}

function offsetAt(band: TextBand, x: number): number {
  const position = (x - FIRST_STRIP) / STRIP_STEP - band.first;
  const end = band.offsets.length - 1;
  // Extend the measured curve by one strip at most, then hold the edge constant.
  const limited = clamp(position, -1, end + 1);
  const index = clamp(Math.floor(limited), 0, end - 1);
  const fraction = limited - index;
  return band.offsets[index] * (1 - fraction) + band.offsets[index + 1] * fraction;
}

function textBand(
  profiles: Float32Array[], center: number, radius: number, limit: number,
): TextBand | null {
  const start = Math.max(1, center - radius);
  const end = Math.min(profiles[0].length - 1, center + radius);
  let first = 0;
  let shifts: number[] = [];
  let scores = 0;
  let best: TextBand | undefined;
  for (let strip = 0; strip < profiles.length; strip++) {
    const profile = profiles[strip];
    if (!hasText(profile, start, end)) {
      shifts = [];
      continue;
    }
    const estimate = shifts.length ? stripShift(profiles[strip - 1], profile, start, end, limit) : null;
    if (estimate) {
      shifts.push(shifts[shifts.length - 1] + estimate.shift);
      scores += estimate.score;
    } else {
      first = strip;
      shifts = [0];
      scores = 0;
    }
    if (shifts.length < 9) continue;
    const quality = scores / (shifts.length - 1);
    if (quality < 0.55 || (best && shifts.length <= best.offsets.length)) continue;
    best = { center, first, offsets: shifts.slice(), quality };
  }
  if (!best) return null;

  const last = best.offsets.length - 1;
  const offsets = best.offsets.map((value, index, values) => (
    index === 0 || index === last ? value : 0.2 * values[index - 1] + 0.6 * value + 0.2 * values[index + 1]
  ));
  const slope = (offsets[last] - offsets[0]) / last;
  let bend = 0;
  for (let index = 1; index < last; index++) {
    bend = Math.max(bend, Math.abs(offsets[index] - offsets[0] - index * slope));
  }
  // A uniformly tilted or flat page has no curve to correct.
  if (bend < 2.6) return null;
  best.offsets = offsets;
  const middle = offsetAt(best, 0.5);
  best.offsets = offsets.map((offset) => offset - middle);
  return best;
}

function agreeingBands(bands: TextBand[], step: number): TextBand[] {
  return bands.filter((band) => bands.some((neighbor) => {
    if (neighbor === band || Math.abs(neighbor.center - band.center) > step + 1) return false;
    let squaredError = 0;
    let largest = 0;
    for (const x of [0.18, 0.3, 0.42, 0.58, 0.7, 0.82, 0.93]) {
      const a = offsetAt(band, x);
      const b = offsetAt(neighbor, x);
      squaredError += (a - b) ** 2;
      largest = Math.max(largest, Math.abs(a), Math.abs(b));
    }
    return Math.sqrt(squaredError / 7) < Math.max(2.5, largest * 0.32);
  }));
}

function applyBands(frame: Frame, bands: TextBand[], analysisHeight: number, radius: number): Frame {
  const { width, height, data } = frame;
  const result = new Uint8ClampedArray(data.length);
  const scale = height / analysisHeight;
  const maxOffset = analysisHeight * 0.10;
  const columns = bands.map((band) => Float32Array.from({ length: width }, (_, x) => (
    scale * clamp(offsetAt(band, x / (width - 1)), -maxOffset, maxOffset)
  )));
  const previousSourceY = new Float32Array(width).fill(-1);
  const weights = new Float32Array(bands.length);

  for (let y = 0; y < height; y++) {
    let total = 0;
    for (let index = 0; index < bands.length; index++) {
      const band = bands[index];
      const proximity = clamp(1 - Math.abs(y / scale - band.center) / radius, 0, 1);
      const weight = proximity * proximity * (3 - 2 * proximity) * band.quality * 1.7;
      weights[index] = weight;
      total += weight;
    }
    const normalization = 1 / Math.max(1, total);
    const edgeWeight = clamp(Math.min(y, height - 1 - y) / (20 * scale), 0, 1);

    for (let x = 0; x < width; x++) {
      let offset = 0;
      for (let index = 0; index < weights.length; index++) {
        if (weights[index] !== 0) offset += weights[index] * columns[index][x];
      }
      // Keep source rows ordered even where adjacent bands fade into different curves.
      const sourceY = clamp(
        y + offset * normalization * edgeWeight,
        Math.max(0, previousSourceY[x] + 0.35),
        height - 1 - (height - 1 - y) * 0.35,
      );
      previousSourceY[x] = sourceY;
      const top = Math.floor(sourceY);
      const bottom = Math.min(height - 1, top + 1);
      const blend = sourceY - top;
      const output = (y * width + x) * 4;
      const topPixel = (top * width + x) * 4;
      const bottomPixel = (bottom * width + x) * 4;
      for (let channel = 0; channel < 4; channel++) {
        result[output + channel] = data[topPixel + channel] * (1 - blend) + data[bottomPixel + channel] * blend;
      }
    }
  }
  return { width, height, data: result };
}

export function flattenBookPage(frame: Frame): Frame {
  const { width, height } = frame;
  if (width < 180 || height < 240) return frame;
  const analysisHeight = Math.min(ANALYSIS_EDGE, height);
  const analysisWidth = Math.min(ANALYSIS_EDGE, Math.round(width * analysisHeight / height));
  if (analysisWidth < 150) return frame;

  const profiles = textProfiles(frame, analysisWidth, analysisHeight);
  const radius = Math.round(analysisHeight * 0.074);
  const step = Math.max(10, Math.round(analysisHeight * 0.047));
  const shiftLimit = Math.max(5, Math.round(analysisHeight * 0.02));
  const candidates: TextBand[] = [];
  for (let center = radius + 3; center < analysisHeight - radius / 2; center += step) {
    const band = textBand(profiles, center, radius, shiftLimit);
    if (band) candidates.push(band);
  }
  const bands = agreeingBands(candidates, step);
  if (bands.length === 0) return frame;
  return applyBands(frame, bands, analysisHeight, radius);
}
