export type Transform = [number, number, number, number, number, number];

export function orientationTransform(orientation: number, width: number, height: number): Transform {
  switch (orientation) {
    case 2: return [-1, 0, 0, 1, width, 0];
    case 3: return [-1, 0, 0, -1, width, height];
    case 4: return [1, 0, 0, -1, 0, height];
    case 5: return [0, 1, 1, 0, 0, 0];
    case 6: return [0, 1, -1, 0, height, 0];
    case 7: return [0, -1, -1, 0, height, width];
    case 8: return [0, -1, 1, 0, 0, width];
    default: return [1, 0, 0, 1, 0, 0];
  }
}

/** Replace the EXIF orientation before decoding to avoid platform-dependent auto-rotation. */
export function resetJpegOrientation(bytes: ArrayBuffer): number | null {
  const view = new DataView(bytes);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;

  let marker = 2;
  while (marker + 4 <= view.byteLength) {
    if (view.getUint8(marker) !== 0xff) return null;
    const type = view.getUint8(marker + 1);
    if (type === 0xda || type === 0xd9) return null;
    if (type === 0xff) {
      marker++;
      continue;
    }
    const length = view.getUint16(marker + 2);
    const end = marker + 2 + length;
    if (length < 2 || end > view.byteLength) return null;
    const start = marker + 4;
    marker = end;
    if (type !== 0xe1 || length < 16 || view.getUint32(start) !== 0x45786966
      || view.getUint16(start + 4) !== 0) continue;

    const tiff = start + 6;
    const byteOrder = view.getUint16(tiff);
    if (byteOrder !== 0x4949 && byteOrder !== 0x4d4d) continue;
    const littleEndian = byteOrder === 0x4949;
    if (view.getUint16(tiff + 2, littleEndian) !== 42) continue;
    const directory = tiff + view.getUint32(tiff + 4, littleEndian);
    if (directory < tiff + 8 || directory + 2 > end) continue;

    const count = view.getUint16(directory, littleEndian);
    if (directory + 2 + count * 12 > end) continue;
    for (let i = 0; i < count; i++) {
      const entry = directory + 2 + 12 * i;
      if (view.getUint16(entry, littleEndian) !== 0x0112
        || view.getUint16(entry + 2, littleEndian) !== 3
        || view.getUint32(entry + 4, littleEndian) !== 1) continue;
      const orientation = view.getUint16(entry + 8, littleEndian);
      if (orientation < 1 || orientation > 8) return null;
      view.setUint16(entry + 8, 1, littleEndian);
      return orientation;
    }
  }
  return null;
}
