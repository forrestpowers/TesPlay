// Minimal ISOBMFF reading for fragmented MP4 tracks as YouTube serves them over SABR:
// an initialisation segment (ftyp, moov), a `sidx` segment index, then moof+mdat pairs.
// The index gives every segment's byte size and duration, which is what makes a track
// that is still downloading addressable by byte range.

/** Top-level boxes in `buffer` that are complete; `rest` is the trailing partial box. */
export function splitBoxes(buffer) {
  const boxes = [];
  let offset = 0;
  while (offset + 8 <= buffer.length) {
    let size = buffer.readUInt32BE(offset);
    const type = buffer.toString('latin1', offset + 4, offset + 8);
    let header = 8;
    if (size === 1) {
      if (offset + 16 > buffer.length) break;
      size = Number(buffer.readBigUInt64BE(offset + 8));
      header = 16;
    } else if (size === 0) size = buffer.length - offset;
    if (size < header || offset + size > buffer.length) break;
    boxes.push({ type, size, header, data: buffer.subarray(offset, offset + size) });
    offset += size;
  }
  return { boxes, rest: buffer.subarray(offset) };
}

function children(box, headerLength = 8) {
  return splitBoxes(box.subarray(headerLength)).boxes;
}

/** Segment table from a `sidx` box: sizes and durations in order, plus the first segment's offset after the box. */
export function parseSidx(box) {
  const data = box.data ?? box;
  const version = data[8];
  let p = 12;
  const timescale = data.readUInt32BE(p + 4);
  p += 8;
  const earliest = version === 1 ? Number(data.readBigUInt64BE(p)) : data.readUInt32BE(p);
  p += version === 1 ? 8 : 4;
  const firstOffset = version === 1 ? Number(data.readBigUInt64BE(p)) : data.readUInt32BE(p);
  p += version === 1 ? 8 : 4;
  p += 2;
  const count = data.readUInt16BE(p);
  p += 2;
  const segments = [];
  for (let i = 0; i < count; i++) {
    const sizeField = data.readUInt32BE(p);
    const duration = data.readUInt32BE(p + 4);
    p += 12;
    if (sizeField >>> 31) continue; // a reference to another sidx, not media
    segments.push({ size: sizeField & 0x7fffffff, duration });
  }
  return { timescale, earliest, firstOffset, segments };
}

/** `baseMediaDecodeTime` of the first track fragment in a `moof` box, in the track's timescale. */
export function moofDecodeTime(box) {
  const data = box.data ?? box;
  for (const traf of children(data).filter(b => b.type === 'traf')) {
    for (const child of children(traf.data)) {
      if (child.type !== 'tfdt') continue;
      const version = child.data[8];
      return version === 1 ? Number(child.data.readBigUInt64BE(12)) : child.data.readUInt32BE(12);
    }
  }
  return null;
}

/**
 * Byte and time layout of a track: segment `i` occupies `offsets[i]` for `sizes[i]` bytes
 * and starts at `starts[i]` ticks. `total` is the complete file size.
 */
export function buildLayout(initLength, sidx) {
  const offsets = [], starts = [];
  let offset = initLength + sidx.firstOffset, time = sidx.earliest;
  for (const segment of sidx.segments) {
    offsets.push(offset); starts.push(time);
    offset += segment.size; time += segment.duration;
  }
  return { initLength, timescale: sidx.timescale, offsets, sizes: sidx.segments.map(s => s.size), starts, durations: sidx.segments.map(s => s.duration), total: offset, endTime: time };
}

/** Segment index containing byte `position`, or -1 inside the initialisation segment, or null past the end. */
export function segmentAtByte(layout, position) {
  if (position < layout.initLength) return -1;
  for (let i = 0; i < layout.offsets.length; i++) if (position < layout.offsets[i] + layout.sizes[i]) return i;
  return null;
}

/** Segment index whose decode time matches `ticks` (nearest at or before). */
export function segmentAtTime(layout, ticks) {
  let index = 0;
  for (let i = 0; i < layout.starts.length; i++) if (layout.starts[i] <= ticks) index = i; else break;
  return index;
}
