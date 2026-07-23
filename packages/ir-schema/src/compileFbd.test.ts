import assert from "node:assert/strict";
import { test } from "node:test";

import { compileFbdToIr } from "./compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, IO_MAP_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "./constants";
import type { FbdSource, NanoPlcProject } from "./types";

const baseProject: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "and_gate",
  device: { board: "esp32-s3", idf_target: "esp32s3" },
  scan: { period_ms: 10 },
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};

const andFbd: FbdSource = {
  schema_version: FBD_SOURCE_SCHEMA_VERSION,
  name: "Main",
  blocks: [
    { id: "di_start", type: "DI", params: { channel: 1, symbol: "DI_Start" } },
    { id: "di_en", type: "DI", params: { channel: 2, symbol: "DI_Enable" } },
    { id: "and1", type: "AND" },
    { id: "do_lamp", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
  ],
  wires: [
    { from: { block: "di_start", port: "Q" }, to: { block: "and1", port: "IN1" } },
    { from: { block: "di_en", port: "Q" }, to: { block: "and1", port: "IN2" } },
    { from: { block: "and1", port: "Q" }, to: { block: "do_lamp", port: "IN" } },
  ],
};

test("compileFbdToIr and_gate produces schedule", () => {
  const result = compileFbdToIr(baseProject, andFbd, "main");
  assert.equal(result.ok, true);
  assert.ok(result.ir);
  const ir = result.ir;
  assert.equal(ir.schedule.length, 4);
  assert.equal(ir.schedule[2]?.op, "and");
  assert.deepEqual(
    ir.io_image.di.map((d) => d.symbol),
    ["DI_Start", "DI_Enable"]
  );
});

test("compileFbdToIr detects cycle", () => {
  const cyclic: FbdSource = {
    ...andFbd,
    blocks: [
      { id: "a", type: "AND" },
      { id: "b", type: "AND" },
    ],
    wires: [
      { from: { block: "a", port: "Q" }, to: { block: "b", port: "IN1" } },
      { from: { block: "b", port: "Q" }, to: { block: "a", port: "IN1" } },
    ],
  };
  const result = compileFbdToIr(baseProject, cyclic, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0400"));
});

test("compileFbdToIr rejects duplicate DI symbols", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_1", moduleId: "onboard" } },
      { id: "di2", type: "DI", params: { channel: 2, symbol: "DI_1", moduleId: "expansion" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_1" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0213"));
});

test("compileFbdToIr maps channel to process-image index", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 3, symbol: "DI_3" } },
      { id: "do1", type: "DO", params: { channel: 2, symbol: "DO_2" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.io_image.di[0]?.index, 2);
  assert.equal(result.ir?.io_image.do[0]?.index, 1);
});

test("compileFbdToIr rejects DI/DO without symbol or channel", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: {} },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_1" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0214" && d.block_id === "di1"));
});

test("compileFbdToIr accepts DI with symbol only (module-local channel)", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { symbol: "DI_1", moduleId: "stamplc_io_exp1" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_5", moduleId: "stamplc_io_exp1" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
});

test("compileFbdToIr CONST feeds BOOL literal to DO", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "BOOL", value: true } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_1" } },
    ],
    wires: [{ from: { block: "c1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule[0]?.op, "const");
  assert.equal(result.ir?.schedule[0]?.value, true);
  assert.equal(result.ir?.schedule[0]?.value_type, "BOOL");
  assert.equal(result.ir?.schedule[0]?.out, "__c1_Q");
  assert.equal(result.ir?.schedule[1]?.in1, "__c1_Q");
});

test("compileFbdToIr CONST INT has typed variable", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CONST", params: { data_type: "INT", value: 42 } }],
    wires: [],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule[0]?.value, 42);
  assert.equal(result.ir?.schedule[0]?.value_type, "INT");
  assert.equal(result.ir?.variables.find((v) => v.name === "__c1_Q")?.type, "INT");
});

test("compileFbdToIr rejects INT CONST wired to BOOL input", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "INT", value: 1 } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_1" } },
    ],
    wires: [{ from: { block: "c1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0305"));
});

test("compileFbdToIr rejects WORD constant out of range", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CONST", params: { data_type: "WORD", value: 70000 } }],
    wires: [],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0215"));
});

test("compileFbdToIr maps Analog In to read_ai schedule step", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "ai1", type: "AI", params: { channel: 1, symbol: "AI_1" } }],
    wires: [],
  };
  const ioMap = {
    schema_version: IO_MAP_SCHEMA_VERSION,
    entries: [{ symbol: "AI_1", kind: "AI" as const, index: 0 }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main", ioMap);
  assert.equal(result.ok, true);
  assert.equal(result.ir?.io_image.ai.length, 1);
  assert.equal(result.ir?.schedule[0]?.op, "read_ai");
  assert.equal(result.ir?.variables.find((v) => v.name === "AI_1")?.type, "REAL");
});
