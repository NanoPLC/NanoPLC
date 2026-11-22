/** Decoder for `#NP1` UART frames (`docs/DEBUG_PROTOCOL.md`). */

export type OnlineVarType = "BOOL" | "INT" | "UINT" | "WORD" | "DINT" | "REAL";

export interface OnlineSnapshot {
  magic: number;
  seq: number;
  scanIndex: number;
  di: boolean[];
  do: boolean[];
  ai: number[];
  vars: Record<string, boolean | number>;
  varTypes: Record<string, OnlineVarType>;
}

const TYPE_NAMES: OnlineVarType[] = ["BOOL", "INT", "UINT", "WORD", "DINT", "REAL"];

function readU16(buf: Uint8Array, off: number): number {
  return buf[off]! | (buf[off + 1]! << 8);
}

function readU32(buf: Uint8Array, off: number): number {
  return (
    (buf[off]! |
      (buf[off + 1]! << 8) |
      (buf[off + 2]! << 16) |
      (buf[off + 3]! << 24)) >>>
    0
  );
}

function readF32(buf: Uint8Array, off: number): number {
  const u = readU32(buf, off);
  const view = new DataView(new ArrayBuffer(4));
  view.setUint32(0, u, true);
  return view.getFloat32(0, true);
}

function readBits(buf: Uint8Array, off: number, count: number): { values: boolean[]; next: number } {
  const bytes = Math.ceil(count / 8);
  const values: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const byte = buf[off + Math.floor(i / 8)] ?? 0;
    values.push(((byte >> (i % 8)) & 1) === 1);
  }
  return { values, next: off + bytes };
}

function hexToBytes(hex: string): Uint8Array | undefined {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) {
    return undefined;
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Parse one console line. Returns undefined when the line is not a valid `#NP1` frame. */
export function parseNp1Line(line: string): OnlineSnapshot | undefined {
  const trimmed = line.trim();
  if (!trimmed.startsWith("#NP1 ")) {
    return undefined;
  }
  const hex = trimmed.slice(5).trim();
  const buf = hexToBytes(hex);
  if (!buf || buf.length < 18) {
    return undefined;
  }

  let x = 0;
  for (let i = 0; i < buf.length - 2; i++) {
    x ^= buf[i]!;
  }
  if (readU16(buf, buf.length - 2) !== x) {
    return undefined;
  }

  let off = 0;
  const magic = readU32(buf, off);
  off += 4;
  const seq = readU32(buf, off);
  off += 4;
  const scanIndex = readU32(buf, off);
  off += 4;
  const diCount = buf[off++]!;
  const doCount = buf[off++]!;
  const aiCount = buf[off++]!;
  const varCount = buf[off++]!;

  const di = readBits(buf, off, diCount);
  off = di.next;
  const dout = readBits(buf, off, doCount);
  off = dout.next;

  const ai: number[] = [];
  for (let i = 0; i < aiCount; i++) {
    if (off + 4 > buf.length - 2) {
      return undefined;
    }
    ai.push(readF32(buf, off));
    off += 4;
  }

  const vars: Record<string, boolean | number> = {};
  const varTypes: Record<string, OnlineVarType> = {};
  for (let i = 0; i < varCount; i++) {
    if (off >= buf.length - 2) {
      return undefined;
    }
    const nameLen = buf[off++]!;
    if (off + nameLen + 1 > buf.length - 2) {
      return undefined;
    }
    const name = String.fromCharCode(...buf.slice(off, off + nameLen));
    off += nameLen;
    const typeCode = buf[off++]!;
    const type = TYPE_NAMES[typeCode] ?? "BOOL";
    varTypes[name] = type;
    if (type === "BOOL") {
      vars[name] = (buf[off++] ?? 0) !== 0;
    } else if (type === "REAL") {
      vars[name] = readF32(buf, off);
      off += 4;
    } else if (type === "DINT") {
      vars[name] = readU32(buf, off) | 0;
      off += 4;
    } else {
      const raw = readU16(buf, off);
      off += 2;
      vars[name] = type === "INT" ? ((raw << 16) >> 16) : raw;
    }
  }

  return {
    magic,
    seq,
    scanIndex,
    di: di.values,
    do: dout.values,
    ai,
    vars,
    varTypes,
  };
}
