import assert from "node:assert/strict";
import * as net from "net";
import { test } from "node:test";

import type { FieldbusAccess, FieldbusImage } from "./image";
import { DI_COIL_BASE, DI_HOLDING_BASE } from "./image";
import { handleModbusTcp, ModbusTcpServer } from "./modbus";
import { applyMqttSet, MqttBroker, mqttTopicMatch } from "./mqtt";
import { OpcUaServer } from "./opcua";
import { startFieldbusServers } from "./server";

function memoryAccess(initial: FieldbusImage): FieldbusAccess & { image: FieldbusImage } {
  const image: FieldbusImage = {
    di: [...initial.di],
    do: [...initial.do],
    ai: [...initial.ai],
  };
  return {
    image,
    read: () => ({ di: [...image.di], do: [...image.do], ai: [...image.ai] }),
    writeDi(index, value) {
      image.di[index] = value;
    },
    writeDo(index, value) {
      image.do[index] = value;
    },
    writeAi(index, value) {
      image.ai[index] = value;
    },
  };
}

function mbap(unit: number, pdu: Buffer): Buffer {
  const frame = Buffer.alloc(7 + pdu.length);
  frame.writeUInt16BE(1, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(1 + pdu.length, 4);
  frame[6] = unit;
  pdu.copy(frame, 7);
  return frame;
}

function readBits(fc: number, start: number, count: number): Buffer {
  const pdu = Buffer.alloc(5);
  pdu[0] = fc;
  pdu.writeUInt16BE(start, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

test("modbus maps DO coils, DI discrete inputs, and AI registers", () => {
  const access = memoryAccess({ di: [true, false], do: [false, true], ai: [12.6, -2] });
  const coils = handleModbusTcp(mbap(1, readBits(1, 0, 2)), access.image, access);
  assert.equal(coils[7], 1);
  assert.equal(coils[9] & 0b11, 0b10);

  const discrete = handleModbusTcp(mbap(1, readBits(2, 0, 2)), access.image, access);
  assert.equal(discrete[9] & 0b11, 0b01);

  const holding = handleModbusTcp(mbap(1, readBits(3, 0, 2)), access.image, access);
  assert.equal(holding.readInt16BE(9), 13);
  assert.equal(holding.readInt16BE(11), -2);

  const writeDo = Buffer.alloc(5);
  writeDo[0] = 5;
  writeDo.writeUInt16BE(0, 1);
  writeDo.writeUInt16BE(0xff00, 3);
  handleModbusTcp(mbap(1, writeDo), access.image, access);
  assert.equal(access.image.do[0], true);

  const writeDi = Buffer.alloc(5);
  writeDi[0] = 6;
  writeDi.writeUInt16BE(DI_HOLDING_BASE + 1, 1);
  writeDi.writeUInt16BE(1, 3);
  handleModbusTcp(mbap(1, writeDi), access.image, access);
  assert.equal(access.image.di[1], true);

  const writeAi = Buffer.alloc(5);
  writeAi[0] = 6;
  writeAi.writeUInt16BE(0, 1);
  writeAi.writeUInt16BE(0xffff, 3);
  handleModbusTcp(mbap(1, writeAi), access.image, access);
  assert.equal(access.image.ai[0], -1);

  const bad = handleModbusTcp(mbap(1, Buffer.from([0x63])), access.image, access);
  assert.equal(bad[7], 0x63 | 0x80);
  assert.equal(bad[8], 1);
});

test("modbus TCP roundtrip writes a DI coil in the high bank", async () => {
  const access = memoryAccess({ di: [false], do: [false], ai: [0] });
  const server = new ModbusTcpServer(access);
  const port = await server.listen(0);
  try {
    const pdu = Buffer.alloc(5);
    pdu[0] = 5;
    pdu.writeUInt16BE(DI_COIL_BASE, 1);
    pdu.writeUInt16BE(0xff00, 3);
    const response = await tcpExchange(port, mbap(1, pdu));
    assert.equal(response[7], 5);
    assert.equal(access.image.di[0], true);
  } finally {
    await server.close();
  }
});

test("mqtt topic match and set payloads", () => {
  assert.equal(mqttTopicMatch("nanoplc/#", "nanoplc/di/0"), true);
  assert.equal(mqttTopicMatch("nanoplc/+/0", "nanoplc/di/0"), true);
  assert.equal(mqttTopicMatch("nanoplc/di/0", "nanoplc/di/1"), false);
  const access = memoryAccess({ di: [false], do: [false], ai: [0] });
  assert.equal(applyMqttSet("nanoplc/di/0/set", "1", "nanoplc", access), true);
  assert.equal(access.image.di[0], true);
  assert.equal(applyMqttSet("nanoplc/ai/0/set", "3.5", "nanoplc", access), true);
  assert.equal(access.image.ai[0], 3.5);
  assert.equal(applyMqttSet("other/di/0/set", "1", "nanoplc", access), false);
});

test("mqtt broker delivers retained process values and applies a set", async () => {
  const access = memoryAccess({ di: [false], do: [true], ai: [4] });
  const servers = await startFieldbusServers(access);
  assert.equal(servers.errors.length, 0);
  assert.ok(servers.mqttPort);
  try {
    servers.publish(access.read());
    const received = await mqttSession(servers.mqttPort, async (client) => {
      await client.subscribe("nanoplc/#");
      await client.waitValue("nanoplc/do/0", "1");
      client.publish("nanoplc/di/0/set", "1");
      return client.waitValue("nanoplc/di/0", "1");
    });
    assert.equal(received, "1");
    assert.equal(access.image.di[0], true);
  } finally {
    await servers.close();
  }
});

test("opc ua anonymous session reads and writes DI0", async () => {
  const access = memoryAccess({ di: [false, true], do: [false], ai: [1.5] });
  const server = new OpcUaServer(access);
  const port = await server.listen(0);
  const socket = net.connect({ host: "127.0.0.1", port });
  const stream = new SocketBuffer(socket);
  try {
    await onceConnect(socket);
    socket.write(hel(`opc.tcp://127.0.0.1:${port}`));
    const ack = await stream.nextFrame();
    assert.equal(ack.type, "ACK");

    socket.write(openSecureChannel());
    const opn = await stream.nextFrame();
    assert.equal(opn.type, "OPN");

    socket.write(sessionMessage(createSessionBody(), 1));
    const created = await stream.nextFrame();
    assert.equal(created.type, "MSG");

    socket.write(sessionMessage(activateSessionBody(), 2));
    const activated = await stream.nextFrame();
    assert.equal(activated.type, "MSG");

    socket.write(sessionMessage(readNode("DI0"), 3));
    const read0 = await stream.nextFrame();
    assert.equal(dataValueBool(read0.payload), false);

    socket.write(sessionMessage(writeBool("DI0", true), 4));
    await stream.nextFrame();
    assert.equal(access.image.di[0], true);

    socket.write(sessionMessage(readNode("AI0"), 5));
    const readAi = await stream.nextFrame();
    assert.equal(dataValueFloat(readAi.payload), 1.5);

    socket.write(sessionMessage(browseObjects(), 6));
    const browsed = await stream.nextFrame();
    assert.ok(browsed.payload.includes(Buffer.from("DI0")));
    assert.ok(browsed.payload.includes(Buffer.from("AI0")));
  } finally {
    socket.destroy();
    await server.close();
  }
});

function tcpExchange(port: number, payload: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => socket.write(payload));
    const chunks: Buffer[] = [];
    socket.on("data", (chunk) => {
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (buf.length >= 6 && buf.length >= 6 + buf.readUInt16BE(4)) {
        socket.end();
        resolve(buf);
      }
    });
    socket.on("error", reject);
  });
}

function onceConnect(socket: net.Socket): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.once("connect", () => resolve());
    socket.once("error", reject);
  });
}

class SocketBuffer {
  private buf = Buffer.alloc(0);
  private waiters: ((frame: { type: string; payload: Buffer }) => void)[] = [];

  constructor(socket: net.Socket) {
    socket.on("data", (chunk) => {
      this.buf = Buffer.concat([this.buf, chunk]);
      this.flush();
    });
  }

  nextFrame(): Promise<{ type: string; payload: Buffer }> {
    const pending = this.pull();
    if (pending) {
      return Promise.resolve(pending);
    }
    return new Promise((resolve) => this.waiters.push(resolve));
  }

  private flush(): void {
    for (;;) {
      const frame = this.pull();
      if (!frame) {
        return;
      }
      const waiter = this.waiters.shift();
      if (!waiter) {
        this.buf = Buffer.concat([frameRaw(frame), this.buf]);
        return;
      }
      waiter(frame);
    }
  }

  private pull(): { type: string; payload: Buffer } | undefined {
    if (this.buf.length < 8) {
      return undefined;
    }
    const size = this.buf.readUInt32LE(4);
    if (this.buf.length < size) {
      return undefined;
    }
    const type = this.buf.subarray(0, 3).toString("ascii");
    const payload = this.buf.subarray(8, size);
    this.buf = this.buf.subarray(size);
    return { type, payload };
  }
}

function frameRaw(frame: { type: string; payload: Buffer }): Buffer {
  const head = Buffer.alloc(8);
  head.write(frame.type, 0, 3, "ascii");
  head.write("F", 3, 1, "ascii");
  head.writeUInt32LE(8 + frame.payload.length, 4);
  return Buffer.concat([head, frame.payload]);
}

function uaString(text: string | undefined): Buffer {
  if (text === undefined) {
    const buf = Buffer.alloc(4);
    buf.writeInt32LE(-1, 0);
    return buf;
  }
  const body = Buffer.from(text, "utf8");
  const buf = Buffer.alloc(4 + body.length);
  buf.writeInt32LE(body.length, 0);
  body.copy(buf, 4);
  return buf;
}

function uaFrame(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(8);
  head.write(type, 0, 3, "ascii");
  head.write("F", 3, 1, "ascii");
  head.writeUInt32LE(8 + body.length, 4);
  return Buffer.concat([head, body]);
}

function hel(url: string): Buffer {
  const urlBytes = uaString(url);
  const body = Buffer.alloc(20 + urlBytes.length);
  body.writeUInt32LE(0, 0);
  body.writeUInt32LE(65535, 4);
  body.writeUInt32LE(65535, 8);
  body.writeUInt32LE(0, 12);
  body.writeUInt32LE(0, 16);
  urlBytes.copy(body, 20);
  return uaFrame("HEL", body);
}

function nodeIdNumeric(id: number, ns = 0): Buffer {
  if (ns === 0 && id <= 0xff) {
    return Buffer.from([0x00, id]);
  }
  const buf = Buffer.alloc(4);
  buf[0] = 0x01;
  buf[1] = ns;
  buf.writeUInt16LE(id, 2);
  return buf;
}

function requestHeader(handle: number): Buffer {
  return Buffer.concat([
    nodeIdNumeric(0),
    Buffer.alloc(8),
    u32(handle),
    u32(0),
    uaString(undefined),
    u32(5000),
    Buffer.from([0x00, 0x00, 0x00]),
  ]);
}

function u32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeUInt32LE(value, 0);
  return buf;
}

function openSecureChannel(): Buffer {
  const service = Buffer.concat([
    nodeIdNumeric(446),
    requestHeader(1),
    u32(0),
    u32(0),
    u32(1),
    uaString(undefined),
    u32(3600000),
  ]);
  const policy = uaString("http://opcfoundation.org/UA/SecurityPolicy#None");
  const head = Buffer.concat([
    u32(0),
    policy,
    uaString(undefined),
    uaString(undefined),
    u32(1),
    u32(1),
    service,
  ]);
  return uaFrame("OPN", head);
}

function sessionMessage(serviceBody: Buffer, handle: number): Buffer {
  const service = Buffer.concat([serviceBody.subarray(0, 0), nodeIdFrom(serviceBody), requestHeader(handle), serviceRest(serviceBody)]);
  const chunk = Buffer.concat([u32(1), u32(1), u32(handle), u32(handle), service]);
  return uaFrame("MSG", chunk);
}

function nodeIdFrom(serviceBody: Buffer): Buffer {
  return serviceBody.subarray(0, serviceBody[0] === 0x00 ? 2 : 4);
}

function serviceRest(serviceBody: Buffer): Buffer {
  return serviceBody.subarray(serviceBody[0] === 0x00 ? 2 : 4);
}

function createSessionBody(): Buffer {
  return nodeIdNumeric(461);
}

function activateSessionBody(): Buffer {
  return nodeIdNumeric(467);
}

function stringNode(name: string): Buffer {
  return Buffer.concat([Buffer.from([0x03]), u16(1), uaString(name)]);
}

function u16(value: number): Buffer {
  const buf = Buffer.alloc(2);
  buf.writeUInt16LE(value, 0);
  return buf;
}

function readNode(name: string): Buffer {
  const maxAge = Buffer.alloc(8);
  return Buffer.concat([
    nodeIdNumeric(631),
    maxAge,
    u32(0),
    i32(1),
    stringNode(name),
    u32(13),
    uaString(undefined),
    u16(0),
    uaString(undefined),
  ]);
}

function writeBool(name: string, value: boolean): Buffer {
  return Buffer.concat([
    nodeIdNumeric(673),
    i32(1),
    stringNode(name),
    u32(13),
    uaString(undefined),
    Buffer.from([0x01, 0x01, value ? 1 : 0]),
  ]);
}

function browseObjects(): Buffer {
  const ts = Buffer.alloc(8);
  return Buffer.concat([
    nodeIdNumeric(527),
    nodeIdNumeric(0),
    ts,
    u32(0),
    u32(0),
    i32(1),
    nodeIdNumeric(85),
    u32(0),
    nodeIdNumeric(33),
    Buffer.from([1]),
    u32(0),
    u32(0),
  ]);
}

function i32(value: number): Buffer {
  const buf = Buffer.alloc(4);
  buf.writeInt32LE(value, 0);
  return buf;
}

function dataValueBool(payload: Buffer): boolean {
  const valueAt = payload.length - 5;
  assert.equal(payload[valueAt - 2], 0x01);
  assert.equal(payload[valueAt - 1], 0x01);
  return payload[valueAt] === 1;
}

function dataValueFloat(payload: Buffer): number {
  return payload.readFloatLE(payload.length - 8);
}

function mqttSession<T>(
  port: number,
  run: (client: {
    subscribe(filter: string): Promise<void>;
    publish(topic: string, payload: string): void;
    waitPublish(topic: string): Promise<string>;
    waitValue(topic: string, payload: string): Promise<string>;
  }) => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    const socket = net.connect({ host: "127.0.0.1", port }, () => {
      const clientId = uaStringMqtt("nanoplc-test");
      const proto = uaStringMqtt("MQTT");
      const variable = Buffer.concat([
        proto,
        Buffer.from([4, 0x02, 0x00, 0x3c]),
        clientId,
      ]);
      socket.write(Buffer.concat([Buffer.from([0x10]), encLen(variable.length), variable]));
    });
    let buf = Buffer.alloc(0);
    const queue: { topic: string; payload: string }[] = [];
    const waiters: ((msg: { topic: string; payload: string }) => void)[] = [];
    const fail = (error: Error) => {
      socket.destroy();
      reject(error);
    };
    socket.on("error", fail);
    socket.on("data", (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      for (;;) {
        if (buf.length < 2) {
          return;
        }
        let multiplier = 1;
        let value = 0;
        let index = 1;
        let done = false;
        for (let i = 0; i < 4; i++) {
          if (index >= buf.length) {
            return;
          }
          const digit = buf[index];
          index += 1;
          value += (digit & 0x7f) * multiplier;
          if ((digit & 0x80) === 0) {
            done = true;
            break;
          }
          multiplier *= 128;
        }
        if (!done) {
          return;
        }
        const total = index + value;
        if (buf.length < total) {
          return;
        }
        const type = buf[0] >> 4;
        const body = buf.subarray(index, total);
        buf = buf.subarray(total);
        if (type === 3 && body.length >= 2) {
          const len = body.readUInt16BE(0);
          const topic = body.subarray(2, 2 + len).toString("utf8");
          const payload = body.subarray(2 + len).toString("utf8");
          const waiter = waiters.shift();
          if (waiter) {
            waiter({ topic, payload });
          } else {
            queue.push({ topic, payload });
          }
        }
      }
    });

    const client = {
      subscribe(filter: string) {
        const topic = uaStringMqtt(filter);
        const body = Buffer.concat([Buffer.from([0x00, 0x01]), topic, Buffer.from([0])]);
        socket.write(Buffer.concat([Buffer.from([0x82]), encLen(body.length), body]));
        return Promise.resolve();
      },
      publish(topic: string, payload: string) {
        const body = Buffer.concat([uaStringMqtt(topic), Buffer.from(payload)]);
        socket.write(Buffer.concat([Buffer.from([0x30]), encLen(body.length), body]));
      },
      waitPublish(topic: string) {
        const existing = queue.findIndex((item) => item.topic === topic);
        if (existing >= 0) {
          const [found] = queue.splice(existing, 1);
          return Promise.resolve(found.payload);
        }
        return new Promise<string>((resolveWait) => {
          const check = (msg: { topic: string; payload: string }) => {
            if (msg.topic === topic) {
              resolveWait(msg.payload);
              return;
            }
            queue.push(msg);
            waiters.push(check);
          };
          waiters.push(check);
        });
      },
      waitValue(topic: string, payload: string) {
        const pull = async (): Promise<string> => {
          const got = await client.waitPublish(topic);
          if (got === payload) {
            return got;
          }
          return pull();
        };
        return pull();
      },
    };

    socket.once("connect", () => {
      setTimeout(() => {
        run(client).then(
          (value) => {
            socket.end();
            resolve(value);
          },
          (error) => {
            socket.destroy();
            reject(error);
          }
        );
      }, 30);
    });
  });
}

function uaStringMqtt(text: string): Buffer {
  const body = Buffer.from(text, "utf8");
  const buf = Buffer.alloc(2 + body.length);
  buf.writeUInt16BE(body.length, 0);
  body.copy(buf, 2);
  return buf;
}

function encLen(length: number): Buffer {
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
