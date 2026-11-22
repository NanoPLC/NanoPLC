import * as net from "net";

import type { FieldbusAccess, FieldbusImage } from "./image";

/** DefaultBinary encoding NodeIds (namespace 0). */
const ID = {
  serviceFault: 397,
  openSecureChannelRequest: 446,
  openSecureChannelResponse: 449,
  closeSecureChannelRequest: 452,
  findServersRequest: 422,
  findServersResponse: 425,
  getEndpointsRequest: 428,
  getEndpointsResponse: 431,
  createSessionRequest: 461,
  createSessionResponse: 464,
  activateSessionRequest: 467,
  activateSessionResponse: 470,
  closeSessionRequest: 473,
  closeSessionResponse: 476,
  readRequest: 631,
  readResponse: 634,
  writeRequest: 673,
  writeResponse: 676,
  browseRequest: 527,
  browseResponse: 530,
} as const;

const SECURITY_NONE = "http://opcfoundation.org/UA/SecurityPolicy#None";
const TRANSPORT = "http://opcfoundation.org/UA-Profile/Transport/uatcp-uasc-uabinary";
const BAD_NODE_ID_UNKNOWN = 0x80340000;
const BAD_ATTRIBUTE_ID_INVALID = 0x80350000;
const ATTR_NODE_CLASS = 2;
const ATTR_BROWSE_NAME = 3;
const ATTR_DISPLAY_NAME = 4;
const ATTR_VALUE = 13;

interface UaNode {
  ns: number;
  numeric?: number;
  string?: string;
}

class UaWriter {
  private readonly parts: Buffer[] = [];

  u8(value: number): this {
    this.parts.push(Buffer.from([value & 0xff]));
    return this;
  }

  u16(value: number): this {
    const buf = Buffer.alloc(2);
    buf.writeUInt16LE(value, 0);
    this.parts.push(buf);
    return this;
  }

  u32(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeUInt32LE(value >>> 0, 0);
    this.parts.push(buf);
    return this;
  }

  i32(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(value, 0);
    this.parts.push(buf);
    return this;
  }

  u64(value: bigint): this {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64LE(value, 0);
    this.parts.push(buf);
    return this;
  }

  f32(value: number): this {
    const buf = Buffer.alloc(4);
    buf.writeFloatLE(value, 0);
    this.parts.push(buf);
    return this;
  }

  f64(value: number): this {
    const buf = Buffer.alloc(8);
    buf.writeDoubleLE(value, 0);
    this.parts.push(buf);
    return this;
  }

  bytes(value: Buffer): this {
    this.parts.push(value);
    return this;
  }

  str(value: string | undefined): this {
    if (value === undefined) {
      return this.i32(-1);
    }
    const body = Buffer.from(value, "utf8");
    this.i32(body.length);
    this.parts.push(body);
    return this;
  }

  byteString(value: Buffer | undefined): this {
    if (value === undefined) {
      return this.i32(-1);
    }
    this.i32(value.length);
    this.parts.push(value);
    return this;
  }

  /** Numeric NodeId, compact encoding. */
  nodeIdNumeric(id: number, ns = 0): this {
    if (ns === 0 && id >= 0 && id <= 0xff) {
      return this.u8(0x00).u8(id);
    }
    if (ns <= 0xff && id >= 0 && id <= 0xffff) {
      return this.u8(0x01).u8(ns).u16(id);
    }
    return this.u8(0x02).u16(ns).u32(id);
  }

  nodeIdString(ns: number, id: string): this {
    return this.u8(0x03).u16(ns).str(id);
  }

  nullExtension(): this {
    return this.u8(0x00).u8(0).u8(0x00);
  }

  localized(text: string): this {
    return this.u8(0x02).str(text);
  }

  build(): Buffer {
    return Buffer.concat(this.parts);
  }
}

class UaReader {
  pos = 0;

  constructor(private readonly buf: Buffer) {}

  private need(n: number): void {
    if (this.pos + n > this.buf.length) {
      throw new Error("truncated OPC UA message");
    }
  }

  u8(): number {
    this.need(1);
    return this.buf[this.pos++];
  }

  u16(): number {
    this.need(2);
    const value = this.buf.readUInt16LE(this.pos);
    this.pos += 2;
    return value;
  }

  u32(): number {
    this.need(4);
    const value = this.buf.readUInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  i32(): number {
    this.need(4);
    const value = this.buf.readInt32LE(this.pos);
    this.pos += 4;
    return value;
  }

  f32(): number {
    this.need(4);
    const value = this.buf.readFloatLE(this.pos);
    this.pos += 4;
    return value;
  }

  f64(): number {
    this.need(8);
    const value = this.buf.readDoubleLE(this.pos);
    this.pos += 8;
    return value;
  }

  skip(n: number): void {
    this.need(n);
    this.pos += n;
  }

  str(): string | undefined {
    const length = this.i32();
    if (length < 0) {
      return undefined;
    }
    this.need(length);
    const text = this.buf.subarray(this.pos, this.pos + length).toString("utf8");
    this.pos += length;
    return text;
  }

  byteString(): Buffer | undefined {
    const length = this.i32();
    if (length < 0) {
      return undefined;
    }
    this.need(length);
    const value = this.buf.subarray(this.pos, this.pos + length);
    this.pos += length;
    return value;
  }

  nodeId(): UaNode {
    const enc = this.u8();
    if (enc === 0x00) {
      return { ns: 0, numeric: this.u8() };
    }
    if (enc === 0x01) {
      return { ns: this.u8(), numeric: this.u16() };
    }
    if (enc === 0x02) {
      return { ns: this.u16(), numeric: this.u32() };
    }
    if (enc === 0x03) {
      return { ns: this.u16(), string: this.str() };
    }
    if (enc === 0x04) {
      this.u16();
      this.skip(16);
      return { ns: 0 };
    }
    if (enc === 0x05) {
      this.u16();
      this.byteString();
      return { ns: 0 };
    }
    throw new Error(`unsupported NodeId encoding ${enc}`);
  }

  extensionObject(): void {
    this.nodeId();
    const encoding = this.u8();
    if (encoding === 1 || encoding === 2) {
      this.byteString();
    }
  }

  requestHeader(): number {
    this.nodeId();
    this.skip(8);
    const handle = this.u32();
    this.u32();
    this.str();
    this.u32();
    this.extensionObject();
    return handle;
  }

  dataValue(): { boolean?: boolean; number?: number } {
    const mask = this.u8();
    const out: { boolean?: boolean; number?: number } = {};
    if ((mask & 0x01) !== 0) {
      const enc = this.u8();
      const builtin = enc & 0x3f;
      if (builtin === 0) {
        return out;
      }
      if ((enc & 0x80) !== 0) {
        const count = this.i32();
        for (let i = 0; i < count; i++) {
          this.skipVariantScalar(builtin);
        }
      } else {
        const scalar = this.readVariantScalar(builtin);
        if (typeof scalar === "boolean") {
          out.boolean = scalar;
        } else if (typeof scalar === "number") {
          out.number = scalar;
        }
      }
    }
    if ((mask & 0x02) !== 0) {
      this.u32();
    }
    if ((mask & 0x04) !== 0) {
      this.skip(8);
    }
    if ((mask & 0x08) !== 0) {
      this.u16();
    }
    if ((mask & 0x10) !== 0) {
      this.skip(8);
    }
    if ((mask & 0x20) !== 0) {
      this.u16();
    }
    return out;
  }

  private readVariantScalar(builtin: number): boolean | number | undefined {
    if (builtin === 1 || builtin === 3) {
      return builtin === 1 ? this.u8() !== 0 : this.u8();
    }
    if (builtin === 4) {
      return this.buf.readInt16LE(this.consume(2));
    }
    if (builtin === 5) {
      return this.buf.readUInt16LE(this.consume(2));
    }
    if (builtin === 6) {
      return this.i32();
    }
    if (builtin === 7) {
      return this.u32();
    }
    if (builtin === 10) {
      return this.f32();
    }
    if (builtin === 11) {
      return this.f64();
    }
    this.skipVariantScalar(builtin);
    return undefined;
  }

  private consume(n: number): number {
    this.need(n);
    const at = this.pos;
    this.pos += n;
    return at;
  }

  private skipVariantScalar(builtin: number): void {
    if (builtin === 1 || builtin === 2 || builtin === 3) {
      this.u8();
      return;
    }
    if (builtin === 4 || builtin === 5) {
      this.u16();
      return;
    }
    if (builtin === 6 || builtin === 7 || builtin === 10) {
      this.skip(4);
      return;
    }
    if (builtin === 8 || builtin === 9 || builtin === 11 || builtin === 13) {
      this.skip(8);
      return;
    }
    if (builtin === 12 || builtin === 15) {
      this.byteString();
      return;
    }
    if (builtin === 17) {
      this.nodeId();
      return;
    }
    throw new Error(`cannot skip variant type ${builtin}`);
  }
}

function frame(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 3, "ascii");
  head.write("F", 3, 1, "ascii");
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function responseHeader(handle: number): Buffer {
  return new UaWriter().u64(0n).u32(handle).u32(0).u8(0).i32(0).nullExtension().build();
}

function serviceResponse(typeId: number, handle: number, body: Buffer): Buffer {
  return Buffer.concat([new UaWriter().nodeIdNumeric(typeId).build(), responseHeader(handle), body]);
}

function endpointDescription(url: string): Buffer {
  const app = new UaWriter()
    .str("urn:nanoplc:virtual")
    .str("https://github.com/nanoplc/nanoplc")
    .localized("NanoPLC Virtual PLC")
    .u32(0)
    .str(undefined)
    .str(undefined)
    .i32(1)
    .str(url)
    .build();
  const token = new UaWriter()
    .str("anonymous")
    .u32(0)
    .str(undefined)
    .str(undefined)
    .str(SECURITY_NONE)
    .build();
  return new UaWriter()
    .str(url)
    .bytes(app)
    .byteString(undefined)
    .u32(1)
    .str(SECURITY_NONE)
    .i32(1)
    .bytes(token)
    .str(TRANSPORT)
    .u8(0)
    .build();
}

function dataValueGood(variant: Buffer): Buffer {
  return Buffer.concat([Buffer.from([0x01]), variant]);
}

function dataValueStatus(code: number): Buffer {
  return new UaWriter().u8(0x02).u32(code).build();
}

function boolVariant(value: boolean): Buffer {
  return new UaWriter().u8(1).u8(value ? 1 : 0).build();
}

function floatVariant(value: number): Buffer {
  return new UaWriter().u8(10).f32(value).build();
}

function intVariant(value: number): Buffer {
  return new UaWriter().u8(6).i32(value).build();
}

function qualifiedNameVariant(ns: number, name: string): Buffer {
  return new UaWriter().u8(20).u16(ns).str(name).build();
}

function localizedVariant(text: string): Buffer {
  return new UaWriter().u8(21).localized(text).build();
}

interface ProcNode {
  kind: "di" | "do" | "ai" | "object";
  index: number;
  name: string;
}

function processNode(node: UaNode, image: FieldbusImage): ProcNode | undefined {
  if (node.numeric === 85 && (node.ns === 0 || node.ns === undefined)) {
    return { kind: "object", index: 0, name: "Objects" };
  }
  const text = node.string;
  if (node.ns !== 1 || !text) {
    return undefined;
  }
  const match = /^(DI|DO|AI)(\d+)$/.exec(text);
  if (!match) {
    return undefined;
  }
  const index = Number(match[2]);
  const kind = match[1] === "DI" ? "di" : match[1] === "DO" ? "do" : "ai";
  const length = kind === "di" ? image.di.length : kind === "do" ? image.do.length : image.ai.length;
  if (index < 0 || index >= length) {
    return undefined;
  }
  return { kind, index, name: text };
}

function readAttribute(node: ProcNode, attr: number, image: FieldbusImage): Buffer {
  if (attr === ATTR_NODE_CLASS) {
    return dataValueGood(intVariant(node.kind === "object" ? 1 : 2));
  }
  if (attr === ATTR_BROWSE_NAME || attr === ATTR_DISPLAY_NAME) {
    return attr === ATTR_BROWSE_NAME
      ? dataValueGood(qualifiedNameVariant(node.kind === "object" ? 0 : 1, node.name))
      : dataValueGood(localizedVariant(node.name));
  }
  if (attr !== ATTR_VALUE) {
    return dataValueStatus(BAD_ATTRIBUTE_ID_INVALID);
  }
  if (node.kind === "object") {
    return dataValueStatus(BAD_ATTRIBUTE_ID_INVALID);
  }
  if (node.kind === "ai") {
    return dataValueGood(floatVariant(image.ai[node.index] ?? 0));
  }
  const bit = node.kind === "di" ? image.di[node.index] === true : image.do[node.index] === true;
  return dataValueGood(boolVariant(bit));
}

function reference(name: string): Buffer {
  return new UaWriter()
    .nodeIdNumeric(35)
    .u8(1)
    .nodeIdString(1, name)
    .u16(1)
    .str(name)
    .localized(name)
    .u32(2)
    .nodeIdNumeric(63)
    .build();
}

function browseResult(node: UaNode, image: FieldbusImage): Buffer {
  const proc = processNode(node, image);
  if (!proc) {
    return new UaWriter().u32(BAD_NODE_ID_UNKNOWN).byteString(undefined).i32(0).build();
  }
  if (proc.kind !== "object") {
    return new UaWriter().u32(0).byteString(undefined).i32(0).build();
  }
  const names: string[] = [];
  image.di.forEach((_, index) => names.push(`DI${index}`));
  image.do.forEach((_, index) => names.push(`DO${index}`));
  image.ai.forEach((_, index) => names.push(`AI${index}`));
  const w = new UaWriter().u32(0).byteString(undefined).i32(names.length);
  for (const name of names) {
    w.bytes(reference(name));
  }
  return w.build();
}

function applyWrite(node: ProcNode, value: { boolean?: boolean; number?: number }, access: FieldbusAccess): number {
  if (node.kind === "object") {
    return BAD_ATTRIBUTE_ID_INVALID;
  }
  if (node.kind === "ai") {
    const number = value.number ?? (value.boolean === undefined ? undefined : value.boolean ? 1 : 0);
    if (number === undefined || !Number.isFinite(number)) {
      return BAD_ATTRIBUTE_ID_INVALID;
    }
    access.writeAi(node.index, number);
    return 0;
  }
  const bit = value.boolean ?? (value.number !== undefined ? value.number !== 0 : undefined);
  if (bit === undefined) {
    return BAD_ATTRIBUTE_ID_INVALID;
  }
  if (node.kind === "di") {
    access.writeDi(node.index, bit);
  } else {
    access.writeDo(node.index, bit);
  }
  return 0;
}

function dispatchService(body: Buffer, access: FieldbusAccess, endpointUrl: string): Buffer {
  const reader = new UaReader(body);
  const type = reader.nodeId();
  const typeId = type.numeric ?? -1;
  const handle = reader.requestHeader();
  const image = () => access.read();

  if (typeId === ID.getEndpointsRequest || typeId === ID.findServersRequest) {
    const ep = endpointDescription(endpointUrl);
    const payload =
      typeId === ID.getEndpointsRequest
        ? new UaWriter().i32(1).bytes(ep).build()
        : new UaWriter()
            .i32(1)
            .str("urn:nanoplc:virtual")
            .str("https://github.com/nanoplc/nanoplc")
            .localized("NanoPLC Virtual PLC")
            .u32(0)
            .str(undefined)
            .str(undefined)
            .i32(1)
            .str(endpointUrl)
            .build();
    const responseId = typeId === ID.getEndpointsRequest ? ID.getEndpointsResponse : ID.findServersResponse;
    return serviceResponse(responseId, handle, payload);
  }

  if (typeId === ID.createSessionRequest) {
    const nonce = Buffer.alloc(32, 1);
    const payload = new UaWriter()
      .nodeIdNumeric(1, 1)
      .nodeIdNumeric(2, 1)
      .f64(60000)
      .byteString(nonce)
      .byteString(undefined)
      .i32(1)
      .bytes(endpointDescription(endpointUrl))
      .i32(0)
      .str(undefined)
      .byteString(undefined)
      .u32(65535)
      .build();
    return serviceResponse(ID.createSessionResponse, handle, payload);
  }

  if (typeId === ID.activateSessionRequest) {
    const payload = new UaWriter().byteString(Buffer.alloc(32, 2)).i32(1).u32(0).i32(0).build();
    return serviceResponse(ID.activateSessionResponse, handle, payload);
  }

  if (typeId === ID.closeSessionRequest || typeId === ID.closeSecureChannelRequest) {
    const responseId = typeId === ID.closeSessionRequest ? ID.closeSessionResponse : ID.openSecureChannelResponse;
    if (typeId === ID.closeSecureChannelRequest) {
      return serviceResponse(ID.serviceFault, handle, Buffer.alloc(0));
    }
    return serviceResponse(responseId, handle, Buffer.alloc(0));
  }

  if (typeId === ID.readRequest) {
    reader.f64();
    reader.u32();
    const count = reader.i32();
    const values: Buffer[] = [];
    const live = image();
    for (let i = 0; i < count; i++) {
      const node = reader.nodeId();
      const attr = reader.u32();
      reader.str();
      reader.u16();
      reader.str();
      const proc = processNode(node, live);
      values.push(proc ? readAttribute(proc, attr, live) : dataValueStatus(BAD_NODE_ID_UNKNOWN));
    }
    const payload = new UaWriter().i32(values.length);
    for (const value of values) {
      payload.bytes(value);
    }
    payload.i32(0);
    return serviceResponse(ID.readResponse, handle, payload.build());
  }

  if (typeId === ID.writeRequest) {
    const count = reader.i32();
    const codes: number[] = [];
    for (let i = 0; i < count; i++) {
      const node = reader.nodeId();
      const attr = reader.u32();
      reader.str();
      const value = reader.dataValue();
      const proc = processNode(node, image());
      if (!proc) {
        codes.push(BAD_NODE_ID_UNKNOWN);
      } else if (attr !== ATTR_VALUE) {
        codes.push(BAD_ATTRIBUTE_ID_INVALID);
      } else {
        codes.push(applyWrite(proc, value, access));
      }
    }
    const payload = new UaWriter().i32(codes.length);
    for (const code of codes) {
      payload.u32(code);
    }
    payload.i32(0);
    return serviceResponse(ID.writeResponse, handle, payload.build());
  }

  if (typeId === ID.browseRequest) {
    reader.nodeId();
    reader.skip(8);
    reader.u32();
    reader.u32();
    const count = reader.i32();
    const results: Buffer[] = [];
    const live = image();
    for (let i = 0; i < count; i++) {
      const node = reader.nodeId();
      reader.u32();
      reader.nodeId();
      reader.u8();
      reader.u32();
      reader.u32();
      results.push(browseResult(node, live));
    }
    const payload = new UaWriter().i32(results.length);
    for (const result of results) {
      payload.bytes(result);
    }
    payload.i32(0);
    return serviceResponse(ID.browseResponse, handle, payload.build());
  }

  return serviceResponse(ID.serviceFault, handle, Buffer.alloc(0));
}

function openChannelResponse(sequence: number, requestId: number, handle: number): Buffer {
  const token = new UaWriter().u32(1).u32(1).u64(0n).u32(3_600_000).build();
  const body = serviceResponse(
    ID.openSecureChannelResponse,
    handle,
    Buffer.concat([new UaWriter().u32(0).bytes(token).byteString(Buffer.alloc(32, 3)).build()])
  );
  const head = new UaWriter()
    .u32(1)
    .str(SECURITY_NONE)
    .byteString(undefined)
    .byteString(undefined)
    .u32(sequence)
    .u32(requestId)
    .build();
  return frame("OPN", Buffer.concat([head, body]));
}

function msgResponse(channelId: number, tokenId: number, sequence: number, requestId: number, body: Buffer): Buffer {
  const head = new UaWriter().u32(channelId).u32(tokenId).u32(sequence).u32(requestId).build();
  return frame("MSG", Buffer.concat([head, body]));
}

function handleChunk(type: string, payload: Buffer, access: FieldbusAccess, endpointUrl: string): Buffer | undefined {
  if (type === "HEL") {
    const reader = new UaReader(payload);
    reader.u32();
    const recv = reader.u32();
    const send = reader.u32();
    const ack = new UaWriter().u32(0).u32(Math.max(8192, recv || 65535)).u32(Math.max(8192, send || 65535)).u32(0).u32(0).build();
    return frame("ACK", ack);
  }
  if (type === "OPN") {
    const reader = new UaReader(payload);
    reader.u32();
    reader.str();
    reader.byteString();
    reader.byteString();
    const sequence = reader.u32();
    const requestId = reader.u32();
    const service = payload.subarray(reader.pos);
    const svc = new UaReader(service);
    const typeId = svc.nodeId().numeric;
    const handle = svc.requestHeader();
    if (typeId === ID.closeSecureChannelRequest) {
      return undefined;
    }
    return openChannelResponse(sequence, requestId, handle);
  }
  if (type === "CLO") {
    return undefined;
  }
  if (type === "MSG") {
    const reader = new UaReader(payload);
    const channelId = reader.u32();
    const tokenId = reader.u32();
    const sequence = reader.u32();
    const requestId = reader.u32();
    const body = dispatchService(payload.subarray(reader.pos), access, endpointUrl);
    return msgResponse(channelId || 1, tokenId || 1, sequence, requestId, body);
  }
  return undefined;
}

/**
 * OPC UA TCP subset: anonymous, SecurityPolicy None.
 * Nodes are `ns=1;s=DI0`, `DO0`, `AI0` (BOOL / BOOL / Float) under Objects.
 */
export class OpcUaServer {
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();
  private endpointUrl = "opc.tcp://127.0.0.1:54840";

  constructor(private readonly access: FieldbusAccess) {}

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buf: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        try {
          buf = this.consume(socket, buf);
        } catch {
          socket.destroy();
        }
      });
      socket.on("close", () => this.sockets.delete(socket));
      socket.on("error", () => socket.destroy());
    });
    return new Promise((resolve, reject) => {
      this.server?.once("error", reject);
      this.server?.listen(port, host, () => {
        const addr = this.server?.address();
        const bound = typeof addr === "object" && addr ? addr.port : port;
        this.endpointUrl = `opc.tcp://${host}:${bound}`;
        resolve(bound);
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

  private consume(socket: net.Socket, buf: Buffer): Buffer {
    for (;;) {
      if (buf.length < 8) {
        return buf;
      }
      const size = buf.readUInt32LE(4);
      if (size < 8 || size > 1_048_576) {
        socket.destroy();
        return Buffer.alloc(0);
      }
      if (buf.length < size) {
        return buf;
      }
      const type = buf.subarray(0, 3).toString("ascii");
      const payload = buf.subarray(8, size);
      buf = Buffer.from(buf.subarray(size));
      const response = handleChunk(type, payload, this.access, this.endpointUrl);
      if (response) {
        socket.write(response);
      }
    }
  }
}
