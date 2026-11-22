import assert from "node:assert/strict";
import { test } from "node:test";

import { compileFbdToIr, compileProjectToIr } from "./compileFbd";
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

test("compileFbdToIr emits tof / tp steps and timer instances", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "tof1", type: "TOF", params: { pt_ms: 250 } },
      { id: "tp1", type: "TP", params: { pt_ms: "40" } },
    ],
    wires: [],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true, result.diagnostics.map((d) => d.message).join("; "));
  const tof = result.ir?.schedule.find((s) => s.block_id === "tof1");
  const tp = result.ir?.schedule.find((s) => s.block_id === "tp1");
  assert.equal(tof?.op, "tof");
  assert.equal(tof?.pt_ms, 250);
  assert.equal(tp?.op, "tp");
  assert.equal(tp?.pt_ms, 40);
  assert.deepEqual(
    result.ir?.instances.map((i) => i.type),
    ["TOF", "TP"]
  );
});

test("compileFbdToIr rejects invalid timer PT (NP-0220)", () => {
  for (const pt of [-5, 1.5, "abc"]) {
    const fbd: FbdSource = {
      schema_version: FBD_SOURCE_SCHEMA_VERSION,
      name: "Main",
      blocks: [{ id: "t1", type: "TON", params: { pt_ms: pt } }],
      wires: [],
    };
    const result = compileFbdToIr(baseProject, fbd, "main");
    assert.equal(result.ok, false, `PT ${pt} should be rejected`);
    assert.ok(result.diagnostics.some((d) => d.code === "NP-0220" && d.block_id === "t1"));
  }
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

test("compileFbdToIr ADD with INT constants produces INT output", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "INT", value: 5 } },
      { id: "c2", type: "CONST", params: { data_type: "INT", value: 3 } },
      { id: "add1", type: "ADD" },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "add1", port: "IN1" } },
      { from: { block: "c2", port: "Q" }, to: { block: "add1", port: "IN2" } },
    ],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule.find((s) => s.op === "add")?.value_type, "INT");
  assert.equal(result.ir?.variables.find((v) => v.name === "__add1_Q")?.type, "INT");
});

test("compileFbdToIr ADD promotes AI REAL over INT", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "ai1", type: "AI", params: { channel: 1, symbol: "AI_1" } },
      { id: "c1", type: "CONST", params: { data_type: "INT", value: 2 } },
      { id: "add1", type: "ADD" },
    ],
    wires: [
      { from: { block: "ai1", port: "Q" }, to: { block: "add1", port: "IN1" } },
      { from: { block: "c1", port: "Q" }, to: { block: "add1", port: "IN2" } },
    ],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule.find((s) => s.op === "add")?.value_type, "REAL");
});

test("compileFbdToIr SETBIT WORD produces WORD output", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "WORD", value: 0 } },
      { id: "c2", type: "CONST", params: { data_type: "INT", value: 3 } },
      { id: "sb1", type: "SETBIT" },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "sb1", port: "IN" } },
      { from: { block: "c2", port: "Q" }, to: { block: "sb1", port: "BIT" } },
    ],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule.find((s) => s.op === "setbit")?.value_type, "WORD");
});

test("compileFbdToIr rejects BOOL wired to ADD", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "BOOL", value: true } },
      { id: "add1", type: "ADD" },
    ],
    wires: [{ from: { block: "c1", port: "Q" }, to: { block: "add1", port: "IN1" } }],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0305"));
});

test("compileFbdToIr RS produces rs schedule step and instance", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di_set", type: "DI", params: { channel: 1, symbol: "DI_Set" } },
      { id: "di_rst", type: "DI", params: { channel: 2, symbol: "DI_Rst" } },
      { id: "rs1", type: "RS" },
    ],
    wires: [
      { from: { block: "di_set", port: "Q" }, to: { block: "rs1", port: "SET" } },
      { from: { block: "di_rst", port: "Q" }, to: { block: "rs1", port: "RESET1" } },
    ],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule.find((s) => s.op === "rs")?.block_id, "rs1");
  assert.equal(result.ir?.instances.find((i) => i.id === "rs1")?.type, "RS");
});

test("compileFbdToIr SHL compiles", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "WORD", value: 1 } },
      { id: "c2", type: "CONST", params: { data_type: "INT", value: 2 } },
      { id: "sh1", type: "SHL" },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "sh1", port: "IN" } },
      { from: { block: "c2", port: "Q" }, to: { block: "sh1", port: "N" } },
    ],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule.find((s) => s.op === "shl")?.value_type, "WORD");
});

test("compileFbdToIr CALL rejects self-call", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CALL", params: { program: "main" } }],
    wires: [],
  };
  const result = compileFbdToIr(baseProject, fbd, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0410"));
});

test("compileFbdToIr CALL rejects missing and unknown program", () => {
  const empty: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CALL", params: {} }],
    wires: [],
  };
  const missing = compileFbdToIr(baseProject, empty, "main");
  assert.equal(missing.ok, false);
  assert.ok(missing.diagnostics.some((d) => d.code === "NP-0412"));

  const unknown: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CALL", params: { program: "nope" } }],
    wires: [],
  };
  const result = compileFbdToIr(baseProject, unknown, "main");
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0413"));
});

test("compileProjectToIr inlines a CALL into pou_schedules", () => {
  const project: NanoPlcProject = {
    ...baseProject,
    programs: [
      { id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" },
      { id: "aux", name: "Aux", source: "src/aux.fbd.json", language: "fbd" },
    ],
  };
  const main: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_Start" } },
      { id: "call1", type: "CALL", params: { program: "aux" } },
    ],
    wires: [],
  };
  const aux: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Aux",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 2, symbol: "DI_Enable" } },
      { id: "and1", type: "AND" },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
    ],
    wires: [
      { from: { block: "di1", port: "Q" }, to: { block: "and1", port: "IN1" } },
      { from: { block: "di1", port: "Q" }, to: { block: "and1", port: "IN2" } },
      { from: { block: "and1", port: "Q" }, to: { block: "do1", port: "IN" } },
    ],
  };
  const result = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["aux", aux],
    ]),
    "main"
  );
  assert.equal(result.ok, true);
  assert.equal(result.ir?.schedule.some((s) => s.op === "call" && s.program === "aux"), true);
  assert.equal(result.ir?.pou_schedules?.length, 1);
  assert.equal(result.ir?.pou_schedules?.[0]?.id, "aux");
  assert.ok(result.ir?.pou_schedules?.[0]?.schedule.some((s) => s.op === "write_do"));
  assert.ok(result.ir?.variables.some((v) => v.name === "__aux_and1_Q"));
  assert.equal(result.ir?.variables.some((v) => v.name === "__and1_Q"), false);
  assert.ok(result.ir?.variables.some((v) => v.name === "DI_Enable"));
});

test("compileProjectToIr follows nested CALL", () => {
  const project: NanoPlcProject = {
    ...baseProject,
    programs: [
      { id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" },
      { id: "aux", name: "Aux", source: "src/aux.fbd.json", language: "fbd" },
      { id: "helper", name: "Helper", source: "src/helper.fbd.json", language: "fbd" },
    ],
  };
  const main: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CALL", params: { program: "aux" } }],
    wires: [],
  };
  const aux: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Aux",
    blocks: [{ id: "c1", type: "CALL", params: { program: "helper" } }],
    wires: [],
  };
  const helper: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Helper",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_Start" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const result = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["aux", aux],
      ["helper", helper],
    ]),
    "main"
  );
  assert.equal(result.ok, true);
  assert.equal(result.ir?.pou_schedules?.length, 2);
  assert.ok(result.ir?.pou_schedules?.some((p) => p.id === "aux" && p.schedule.some((s) => s.op === "call" && s.program === "helper")));
  assert.ok(result.ir?.pou_schedules?.some((p) => p.id === "helper" && p.schedule.some((s) => s.op === "write_do")));
});

test("compileProjectToIr detects a program call cycle", () => {
  const project: NanoPlcProject = {
    ...baseProject,
    programs: [
      { id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" },
      { id: "aux", name: "Aux", source: "src/aux.fbd.json", language: "fbd" },
    ],
  };
  const main: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [{ id: "c1", type: "CALL", params: { program: "aux" } }],
    wires: [],
  };
  const aux: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Aux",
    blocks: [{ id: "c1", type: "CALL", params: { program: "main" } }],
    wires: [],
  };
  const result = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["aux", aux],
    ]),
    "main"
  );
  assert.equal(result.ok, false);
  assert.ok(result.diagnostics.some((d) => d.code === "NP-0411"));
});

test("compileProjectToIr CALL copies IN and OUT ports", () => {
  const project: NanoPlcProject = {
    ...baseProject,
    programs: [
      { id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" },
      { id: "aux", name: "Aux", source: "src/aux.fbd.json", language: "fbd" },
    ],
  };
  const main: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "BOOL", value: true } },
      { id: "call1", type: "CALL", params: { program: "aux" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
    ],
    wires: [
      { from: { block: "c1", port: "Q" }, to: { block: "call1", port: "Enable" } },
      { from: { block: "call1", port: "Result" }, to: { block: "do1", port: "IN" } },
    ],
  };
  const aux: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Aux",
    variables: [
      { name: "Enable", class: "IN", type: "BOOL" },
      { name: "Result", class: "OUT", type: "BOOL" },
    ],
    blocks: [
      { id: "in1", type: "LOCAL", params: { name: "Enable" } },
      { id: "out1", type: "LOCAL", params: { name: "Result" } },
    ],
    wires: [{ from: { block: "in1", port: "Q" }, to: { block: "out1", port: "IN" } }],
  };
  const result = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["aux", aux],
    ]),
    "main"
  );
  assert.equal(result.ok, true, result.diagnostics.map((d) => d.message).join("; "));
  const call = result.ir?.schedule.find((s) => s.op === "call");
  assert.equal(call?.call_in?.Enable, "__main_c1_Q");
  assert.ok(call?.call_out?.Result);
  assert.ok(result.ir?.variables.some((v) => v.name === "aux__Enable"));
  assert.ok(result.ir?.variables.some((v) => v.name === "aux__Result"));
});
