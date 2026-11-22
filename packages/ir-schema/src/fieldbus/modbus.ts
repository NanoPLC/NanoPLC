import * as net from "net";

import {
  analogToRegister,
  registerToAnalog,
  resolveAnalog,
  resolveCoil,
  resolveDiHolding,
  resolveDiscrete,
  type FieldbusAccess,
  type FieldbusImage,
} from "./image";

const EX_ILLEGAL_FUNCTION = 1;
const EX_ILLEGAL_ADDRESS = 2;
const EX_ILLEGAL_VALUE = 3;

/** Pull one Modbus TCP ADU out of a stream buffer. `length` counts bytes after the first 6. */
export function takeModbusFrame(buf: Buffer): { frame: Buffer; rest: Buffer } | undefined {
  if (buf.length < 7) {
    return undefined;
  }
  const length = buf.readUInt16BE(4);
  if (length < 2 || length > 260) {
    return undefined;
  }
  const total = 6 + length;
  if (buf.length < total) {
    return undefined;
  }
  return { frame: buf.subarray(0, total), rest: buf.subarray(total) };
}

function exception(frame: Buffer, code: number): Buffer {
  const pdu = Buffer.from([frame[7] | 0x80, code]);
  return adu(frame, pdu);
}

function adu(request: Buffer, pdu: Buffer): Buffer {
  const out = Buffer.alloc(7 + pdu.length);
  request.copy(out, 0, 0, 4);
  out.writeUInt16BE(1 + pdu.length, 4);
  out[6] = request[6];
  pdu.copy(out, 7);
  return out;
}

function readBits(
  frame: Buffer,
  start: number,
  count: number,
  bitAt: (address: number) => boolean | undefined
): Buffer {
  if (count < 1 || count > 2000) {
    return exception(frame, EX_ILLEGAL_VALUE);
  }
  const bits: boolean[] = [];
  for (let i = 0; i < count; i++) {
    const bit = bitAt(start + i);
    if (bit === undefined) {
      return exception(frame, EX_ILLEGAL_ADDRESS);
    }
    bits.push(bit);
  }
  const packed = Buffer.alloc(Math.ceil(count / 8));
  bits.forEach((bit, i) => {
    if (bit) {
      packed[i >> 3] |= 1 << (i & 7);
    }
  });
  const pdu = Buffer.concat([Buffer.from([frame[7], packed.length]), packed]);
  return adu(frame, pdu);
}

function readRegisters(
  frame: Buffer,
  start: number,
  count: number,
  wordAt: (address: number) => number | undefined
): Buffer {
  if (count < 1 || count > 125) {
    return exception(frame, EX_ILLEGAL_VALUE);
  }
  const words = Buffer.alloc(count * 2);
  for (let i = 0; i < count; i++) {
    const word = wordAt(start + i);
    if (word === undefined) {
      return exception(frame, EX_ILLEGAL_ADDRESS);
    }
    words.writeUInt16BE(word & 0xffff, i * 2);
  }
  const pdu = Buffer.concat([Buffer.from([frame[7], words.length]), words]);
  return adu(frame, pdu);
}

/**
 * Modbus TCP slave ADU. Coils 0+ are DO, coils 1000+ are DI.
 * Discrete inputs 0+ are DI. Input and holding registers 0+ are AI as int16.
 * Holding registers 1000+ write a DI as 0/1.
 */
export function handleModbusTcp(frame: Buffer, image: FieldbusImage, access: FieldbusAccess): Buffer {
  if (frame.length < 8 || frame.readUInt16BE(2) !== 0) {
    return exception(frame.length >= 8 ? frame : Buffer.alloc(8), EX_ILLEGAL_VALUE);
  }
  const fc = frame[7];
  const pduLen = frame.length - 7;
  const imageNow = () => access.read();

  if (fc === 1 || fc === 2) {
    if (pduLen < 5) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const start = frame.readUInt16BE(8);
    const count = frame.readUInt16BE(10);
    return readBits(frame, start, count, (address) => {
      const live = imageNow();
      if (fc === 2) {
        const index = resolveDiscrete(address, live);
        return index === undefined ? undefined : live.di[index] === true;
      }
      const coil = resolveCoil(address, live);
      if (!coil) {
        return undefined;
      }
      return coil.kind === "do" ? live.do[coil.index] === true : live.di[coil.index] === true;
    });
  }

  if (fc === 3 || fc === 4) {
    if (pduLen < 5) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const start = frame.readUInt16BE(8);
    const count = frame.readUInt16BE(10);
    return readRegisters(frame, start, count, (address) => {
      const live = imageNow();
      const ai = resolveAnalog(address, live);
      if (ai !== undefined) {
        return analogToRegister(live.ai[ai] ?? 0);
      }
      if (fc === 3) {
        const di = resolveDiHolding(address, live);
        if (di !== undefined) {
          return live.di[di] ? 1 : 0;
        }
      }
      return undefined;
    });
  }

  if (fc === 5) {
    if (pduLen < 5) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const address = frame.readUInt16BE(8);
    const raw = frame.readUInt16BE(10);
    if (raw !== 0xff00 && raw !== 0x0000) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const coil = resolveCoil(address, image);
    if (!coil) {
      return exception(frame, EX_ILLEGAL_ADDRESS);
    }
    const on = raw === 0xff00;
    if (coil.kind === "do") {
      access.writeDo(coil.index, on);
    } else {
      access.writeDi(coil.index, on);
    }
    return adu(frame, frame.subarray(7, 12));
  }

  if (fc === 6) {
    if (pduLen < 5) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const address = frame.readUInt16BE(8);
    const raw = frame.readUInt16BE(10);
    const ai = resolveAnalog(address, image);
    if (ai !== undefined) {
      access.writeAi(ai, registerToAnalog(raw));
      return adu(frame, frame.subarray(7, 12));
    }
    const di = resolveDiHolding(address, image);
    if (di !== undefined) {
      access.writeDi(di, raw !== 0);
      return adu(frame, frame.subarray(7, 12));
    }
    return exception(frame, EX_ILLEGAL_ADDRESS);
  }

  if (fc === 15) {
    if (pduLen < 6) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const start = frame.readUInt16BE(8);
    const count = frame.readUInt16BE(10);
    const byteCount = frame[12];
    if (count < 1 || count > 1968 || byteCount !== Math.ceil(count / 8) || pduLen < 6 + byteCount) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    for (let i = 0; i < count; i++) {
      const coil = resolveCoil(start + i, image);
      if (!coil) {
        return exception(frame, EX_ILLEGAL_ADDRESS);
      }
    }
    for (let i = 0; i < count; i++) {
      const on = (frame[13 + (i >> 3)] & (1 << (i & 7))) !== 0;
      const coil = resolveCoil(start + i, image);
      if (!coil) {
        continue;
      }
      if (coil.kind === "do") {
        access.writeDo(coil.index, on);
      } else {
        access.writeDi(coil.index, on);
      }
    }
    const echo = Buffer.alloc(5);
    echo[0] = 15;
    echo.writeUInt16BE(start, 1);
    echo.writeUInt16BE(count, 3);
    return adu(frame, echo);
  }

  if (fc === 16) {
    if (pduLen < 6) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const start = frame.readUInt16BE(8);
    const count = frame.readUInt16BE(10);
    const byteCount = frame[12];
    if (count < 1 || count > 123 || byteCount !== count * 2 || pduLen < 6 + byteCount) {
      return exception(frame, EX_ILLEGAL_VALUE);
    }
    const writes: { kind: "ai" | "di"; index: number; value: number }[] = [];
    for (let i = 0; i < count; i++) {
      const raw = frame.readUInt16BE(13 + i * 2);
      const ai = resolveAnalog(start + i, image);
      if (ai !== undefined) {
        writes.push({ kind: "ai", index: ai, value: registerToAnalog(raw) });
        continue;
      }
      const di = resolveDiHolding(start + i, image);
      if (di !== undefined) {
        writes.push({ kind: "di", index: di, value: raw });
        continue;
      }
      return exception(frame, EX_ILLEGAL_ADDRESS);
    }
    for (const w of writes) {
      if (w.kind === "ai") {
        access.writeAi(w.index, w.value);
      } else {
        access.writeDi(w.index, w.value !== 0);
      }
    }
    const echo = Buffer.alloc(5);
    echo[0] = 16;
    echo.writeUInt16BE(start, 1);
    echo.writeUInt16BE(count, 3);
    return adu(frame, echo);
  }

  return exception(frame, EX_ILLEGAL_FUNCTION);
}

export class ModbusTcpServer {
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();

  constructor(private readonly access: FieldbusAccess) {}

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buf: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        for (;;) {
          const next = takeModbusFrame(buf);
          if (!next) {
            if (buf.length >= 6 && (buf.readUInt16BE(4) < 2 || buf.readUInt16BE(4) > 260)) {
              socket.destroy();
            }
            break;
          }
          buf = Buffer.from(next.rest);
          const response = handleModbusTcp(next.frame, this.access.read(), this.access);
          socket.write(response);
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    });
    return new Promise((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => {
        const addr = this.server?.address();
        resolve(typeof addr === "object" && addr ? addr.port : port);
      });
    });
  }

  close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => server.close(() => resolve()));
  }
}
