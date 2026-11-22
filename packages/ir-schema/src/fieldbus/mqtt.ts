import * as net from "net";

import type { FieldbusAccess, FieldbusImage } from "./image";

interface Subscription {
  socket: net.Socket;
  filters: string[];
}

function encodeRemaining(length: number): Buffer {
  const bytes: number[] = [];
  let value = length;
  do {
    let digit = value % 128;
    value = Math.floor(value / 128);
    if (value > 0) {
      digit |= 0x80;
    }
    bytes.push(digit);
  } while (value > 0);
  return Buffer.from(bytes);
}

function decodeRemaining(buf: Buffer, offset: number): { value: number; next: number } | undefined {
  let multiplier = 1;
  let value = 0;
  let index = offset;
  for (let i = 0; i < 4; i++) {
    if (index >= buf.length) {
      return undefined;
    }
    const digit = buf[index];
    index += 1;
    value += (digit & 0x7f) * multiplier;
    if ((digit & 0x80) === 0) {
      return { value, next: index };
    }
    multiplier *= 128;
  }
  return undefined;
}

function mqttString(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const out = Buffer.alloc(2 + body.length);
  out.writeUInt16BE(body.length, 0);
  body.copy(out, 2);
  return out;
}

function readMqttString(buf: Buffer, offset: number): { text: string; next: number } | undefined {
  if (offset + 2 > buf.length) {
    return undefined;
  }
  const length = buf.readUInt16BE(offset);
  const end = offset + 2 + length;
  if (end > buf.length) {
    return undefined;
  }
  return { text: buf.subarray(offset + 2, end).toString("utf8"), next: end };
}

function packet(type: number, flags: number, payload: Buffer): Buffer {
  const head = Buffer.from([(type << 4) | flags]);
  return Buffer.concat([head, encodeRemaining(payload.length), payload]);
}

/** MQTT topic filter match. Supports `+` (one level) and a trailing `#`. */
export function mqttTopicMatch(filter: string, topic: string): boolean {
  if (filter === "#") {
    return true;
  }
  const f = filter.split("/");
  const t = topic.split("/");
  for (let i = 0; i < f.length; i++) {
    if (f[i] === "#") {
      return i === f.length - 1;
    }
    if (i >= t.length) {
      return false;
    }
    if (f[i] !== "+" && f[i] !== t[i]) {
      return false;
    }
  }
  return f.length === t.length;
}

export function fieldbusStateTopics(prefix: string, image: FieldbusImage): { topic: string; payload: string }[] {
  const root = prefix.replace(/\/+$/, "") || "nanoplc";
  const out: { topic: string; payload: string }[] = [];
  image.di.forEach((value, index) => out.push({ topic: `${root}/di/${index}`, payload: value ? "1" : "0" }));
  image.do.forEach((value, index) => out.push({ topic: `${root}/do/${index}`, payload: value ? "1" : "0" }));
  image.ai.forEach((value, index) => out.push({ topic: `${root}/ai/${index}`, payload: String(value) }));
  return out;
}

/**
 * Apply `prefix/(di|do|ai)/<index>/set`. Returns true when the topic was a write.
 * Payload is `0`/`1`/`false`/`true` or a number.
 */
export function applyMqttSet(topic: string, payload: string, prefix: string, access: FieldbusAccess): boolean {
  const root = prefix.replace(/\/+$/, "") || "nanoplc";
  const match = new RegExp(`^${root.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/(di|do|ai)/(\\d+)/set$`).exec(topic);
  if (!match) {
    return false;
  }
  const kind = match[1];
  const index = Number(match[2]);
  const text = payload.trim().toLowerCase();
  if (kind === "ai") {
    const value = Number(text);
    if (!Number.isFinite(value)) {
      return true;
    }
    access.writeAi(index, value);
    return true;
  }
  const on = text === "1" || text === "true" || text === "on";
  if (kind === "di") {
    access.writeDi(index, on);
  } else {
    access.writeDo(index, on);
  }
  return true;
}

interface Retained {
  topic: string;
  payload: Buffer;
}

/** MQTT 3.1.1 broker, QoS 0. Enough for a SCADA client to subscribe to the process image. */
export class MqttBroker {
  private server: net.Server | undefined;
  private sockets = new Set<net.Socket>();
  private subs: Subscription[] = [];
  private retained = new Map<string, Buffer>();
  onClientPublish: ((topic: string, payload: Buffer) => void) | undefined;

  listen(port = 0, host = "127.0.0.1"): Promise<number> {
    this.server = net.createServer((socket) => {
      this.sockets.add(socket);
      let buf: Buffer = Buffer.alloc(0);
      socket.on("data", (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        buf = this.consume(socket, buf);
      });
      const drop = () => {
        this.sockets.delete(socket);
        this.subs = this.subs.filter((sub) => sub.socket !== socket);
      };
      socket.on("close", drop);
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

  publish(topic: string, payload: string | Buffer, retain = true): void {
    const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload, "utf8");
    if (retain) {
      this.retained.set(topic, body);
    }
    const packetBytes = this.publishPacket(topic, body);
    for (const sub of this.subs) {
      if (sub.filters.some((filter) => mqttTopicMatch(filter, topic))) {
        sub.socket.write(packetBytes);
      }
    }
  }

  close(): Promise<void> {
    for (const socket of this.sockets) {
      socket.destroy();
    }
    this.sockets.clear();
    this.subs = [];
    const server = this.server;
    this.server = undefined;
    if (!server) {
      return Promise.resolve();
    }
    return new Promise((resolve) => server.close(() => resolve()));
  }

  private publishPacket(topic: string, payload: Buffer): Buffer {
    return packet(3, 0, Buffer.concat([mqttString(topic), payload]));
  }

  private consume(socket: net.Socket, buf: Buffer): Buffer {
    for (;;) {
      if (buf.length < 2) {
        return buf;
      }
      const remaining = decodeRemaining(buf, 1);
      if (!remaining) {
        return buf;
      }
      if (remaining.value > 1_048_576) {
        socket.destroy();
        return Buffer.alloc(0);
      }
      const total = remaining.next + remaining.value;
      if (buf.length < total) {
        return buf;
      }
      const header = buf[0];
      const body = buf.subarray(remaining.next, total);
      buf = Buffer.from(buf.subarray(total));
      this.dispatch(socket, header >> 4, header & 0x0f, body);
    }
  }

  private dispatch(socket: net.Socket, type: number, _flags: number, body: Buffer): void {
    if (type === 1) {
      socket.write(packet(2, 0, Buffer.from([0x00, 0x00])));
      return;
    }
    if (type === 8) {
      this.subscribe(socket, body);
      return;
    }
    if (type === 3) {
      this.incomingPublish(body);
      return;
    }
    if (type === 12) {
      socket.write(packet(13, 0, Buffer.alloc(0)));
      return;
    }
    if (type === 14) {
      socket.end();
    }
  }

  private subscribe(socket: net.Socket, body: Buffer): void {
    if (body.length < 2) {
      return;
    }
    const packetId = body.readUInt16BE(0);
    let offset = 2;
    const filters: string[] = [];
    const codes: number[] = [];
    while (offset < body.length) {
      const topic = readMqttString(body, offset);
      if (!topic || topic.next >= body.length) {
        break;
      }
      filters.push(topic.text);
      codes.push(0);
      offset = topic.next + 1;
    }
    let sub = this.subs.find((item) => item.socket === socket);
    if (!sub) {
      sub = { socket, filters: [] };
      this.subs.push(sub);
    }
    for (const filter of filters) {
      if (!sub.filters.includes(filter)) {
        sub.filters.push(filter);
      }
    }
    socket.write(packet(9, 0, Buffer.concat([Buffer.from([(packetId >> 8) & 0xff, packetId & 0xff]), Buffer.from(codes)])));
    for (const [topic, payload] of this.retained) {
      if (filters.some((filter) => mqttTopicMatch(filter, topic))) {
        socket.write(this.publishPacket(topic, payload));
      }
    }
  }

  private incomingPublish(body: Buffer): void {
    const topic = readMqttString(body, 0);
    if (!topic) {
      return;
    }
    const payload = body.subarray(topic.next);
    this.onClientPublish?.(topic.text, payload);
  }
}

/** Publishes the process image and applies `.../set` writes. */
export class MqttProcessBridge {
  private last = "";

  constructor(
    private readonly broker: MqttBroker,
    private readonly prefix: string,
    private readonly access: FieldbusAccess
  ) {
    broker.onClientPublish = (topic, payload) => {
      if (applyMqttSet(topic, payload.toString("utf8"), this.prefix, this.access)) {
        this.last = "";
        this.publish(this.access.read());
      }
    };
  }

  publish(image: FieldbusImage): void {
    const topics = fieldbusStateTopics(this.prefix, image);
    const key = topics.map((item) => `${item.topic}=${item.payload}`).join("\n");
    if (key === this.last) {
      return;
    }
    this.last = key;
    for (const item of topics) {
      this.broker.publish(item.topic, item.payload, true);
    }
  }
}
