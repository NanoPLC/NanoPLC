import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { compileFbdToIr, compileProjectToIr } from "../compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../constants";
import { PlcSimulator } from "./PlcSimulator";
import type { FbdSource, NanoPlcProject } from "../types";

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

const baseProject: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "and_gate",
  device: { board: "esp32-s3", idf_target: "esp32s3" },
  scan: { period_ms: 10 },
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};

test("simulator and_gate: both inputs true → DO on", () => {
  const compiled = compileFbdToIr(baseProject, andFbd, "main");
  assert.ok(compiled.ir);
  const sim = new PlcSimulator(compiled.ir);
  sim.setDi(0, true);
  sim.setDi(1, true);
  const snap = sim.stepOnce();
  assert.equal(snap.do[0], true);
  assert.equal(snap.vars["DO_Lamp"], true);
});

test("simulator and_gate: one input false → DO off", () => {
  const compiled = compileFbdToIr(baseProject, andFbd, "main");
  assert.ok(compiled.ir);
  const sim = new PlcSimulator(compiled.ir);
  sim.setDi(0, true);
  sim.setDi(1, false);
  const snap = sim.stepOnce();
  assert.equal(snap.do[0], false);
});

test("simulator executes a CALL into another program", () => {
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
    blocks: [{ id: "call1", type: "CALL", params: { program: "aux" } }],
    wires: [],
  };
  const aux: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Aux",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_Start" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const compiled = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["aux", aux],
    ]),
    "main"
  );
  assert.ok(compiled.ok && compiled.ir);
  const sim = new PlcSimulator(compiled.ir);
  sim.setDiBySymbol("DI_Start", true);
  const snap = sim.stepOnce();
  assert.equal(snap.vars["DO_Lamp"], true);
});

test("examples/and_gate IR file compiles and simulates", () => {
  const root = join(__dirname, "..", "..", "..", "..", "examples", "and_gate");
  const project = JSON.parse(readFileSync(join(root, "nanoplc.project.json"), "utf8"));
  const fbd = JSON.parse(readFileSync(join(root, "src", "main.fbd.json"), "utf8"));
  const compiled = compileFbdToIr(project, fbd, "main");
  assert.ok(compiled.ok && compiled.ir);
  const sim = new PlcSimulator(compiled.ir);
  sim.setDiBySymbol("DI_Start", true);
  sim.setDiBySymbol("DI_Enable", true);
  assert.equal(sim.stepOnce().vars["DO_Lamp"], true);
});

test("simulator process image can be larger than compiled io_image", () => {
  const compiled = compileFbdToIr(baseProject, andFbd, "main");
  assert.ok(compiled.ir);
  const sim = new PlcSimulator(compiled.ir, { di: 8, do: 4, ai: 2 });
  sim.setDi(7, true);
  sim.setAi(1, 3.5);
  const snap = sim.stepOnce();
  assert.equal(snap.di.length, 8);
  assert.equal(snap.do.length, 4);
  assert.equal(snap.ai.length, 2);
  assert.equal(snap.di[7], true);
  assert.equal(snap.ai[1], 3.5);
});

test("simulator setVar writes a PROGRAM variable", () => {
  const project: NanoPlcProject = {
    ...baseProject,
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
  };
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    variables: [{ name: "Flag", class: "VAR", type: "BOOL", initial: false }],
    blocks: [
      { id: "loc", type: "LOCAL", params: { name: "Flag" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Lamp" } },
    ],
    wires: [{ from: { block: "loc", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const compiled = compileFbdToIr(project, fbd, "main");
  assert.ok(compiled.ok && compiled.ir, compiled.diagnostics.map((d) => d.message).join("; "));
  const sim = new PlcSimulator(compiled.ir);
  sim.setVar("main__Flag", true);
  const snap = sim.stepOnce();
  assert.equal(snap.vars["main__Flag"], true);
  assert.equal(snap.vars["DO_Lamp"], true);
});

function timerSim(type: "TON" | "TOF" | "TP", pt_ms: number): PlcSimulator {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_In" } },
      { id: "t1", type, params: { pt_ms } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Q" } },
    ],
    wires: [
      { from: { block: "di1", port: "Q" }, to: { block: "t1", port: "IN" } },
      { from: { block: "t1", port: "Q" }, to: { block: "do1", port: "IN" } },
    ],
  };
  const compiled = compileFbdToIr(baseProject, fbd, "main");
  assert.ok(compiled.ok && compiled.ir, compiled.diagnostics.map((d) => d.message).join("; "));
  return new PlcSimulator(compiled.ir);
}

/** Runs one 10 ms scan per entry of `inputs`; returns DO_Q after each scan. */
function trace(sim: PlcSimulator, inputs: boolean[]): boolean[] {
  return inputs.map((v) => {
    sim.setDi(0, v);
    return sim.stepOnce().do[0];
  });
}

test("TON: Q rises after IN held for PT; ET saturates at PT", () => {
  const sim = timerSim("TON", 30);
  assert.deepEqual(trace(sim, [true, true, true, true, false]), [false, false, true, true, false]);
  const snap = sim.stepOnce();
  assert.equal(snap.vars["t1.ET"], 0);
  const held = timerSim("TON", 30);
  trace(held, [true, true, true, true, true, true]);
  assert.equal(held.stepOnce().vars["t1.ET"], 30);
});

test("TOF: Q follows IN on, falls PT after IN goes false", () => {
  const sim = timerSim("TOF", 30);
  assert.deepEqual(
    trace(sim, [false, true, false, false, false, false, true, false, true]),
    [false, true, true, true, false, false, true, true, true]
  );
});

test("TP: fixed pulse on rising edge, not retriggerable", () => {
  const sim = timerSim("TP", 30);
  assert.deepEqual(
    trace(sim, [true, false, true, false, false, true, true, true, true]),
    [true, true, false, false, false, true, true, false, false]
  );
});

test("TP: new edge right after a pulse ended with IN false starts a new pulse", () => {
  const sim = timerSim("TP", 20);
  assert.deepEqual(trace(sim, [true, false, true, true]), [true, false, true, false]);
});

test("timers with PT = 0", () => {
  assert.deepEqual(trace(timerSim("TON", 0), [true, false]), [true, false]);
  assert.deepEqual(trace(timerSim("TOF", 0), [true, false]), [true, false]);
  assert.deepEqual(trace(timerSim("TP", 0), [true, false, true]), [false, false, false]);
});

type NumCase = [op: string, typeA: string, a: number, typeB: string | null, b: number | null];

/** Evaluates `op(a, b)` from CONST inputs in one scan, like the C runtime would. */
function evalNumeric([op, typeA, a, typeB, b]: NumCase): boolean | number {
  const second = typeB === null ? null : /BIT$/.test(op) ? "BIT" : /^(SH|RO)/.test(op) ? "N" : "IN2";
  const blocks: FbdSource["blocks"] = [
    { id: "a", type: "CONST", params: { data_type: typeA, value: a } },
    { id: "op", type: op },
  ];
  const wires: FbdSource["wires"] = [
    { from: { block: "a", port: "Q" }, to: { block: "op", port: second === "IN2" ? "IN1" : "IN" } },
  ];
  if (second && typeB !== null && b !== null) {
    blocks.push({ id: "b", type: "CONST", params: { data_type: typeB, value: b } });
    wires.push({ from: { block: "b", port: "Q" }, to: { block: "op", port: second } });
  }
  const fbd: FbdSource = { schema_version: FBD_SOURCE_SCHEMA_VERSION, name: "Main", blocks, wires };
  const compiled = compileFbdToIr(baseProject, fbd, "main");
  assert.ok(compiled.ok && compiled.ir, compiled.diagnostics.map((d) => d.message).join("; "));
  return new PlcSimulator(compiled.ir).stepOnce().vars["__op_Q"];
}

test("integer math wraps like two's-complement C types", () => {
  const cases: [NumCase, number][] = [
    [["ADD", "INT", 32767, "INT", 1], -32768],
    [["MUL", "INT", 300, "INT", 300], 24464],
    [["DIV", "INT", -32768, "INT", -1], -32768],
    [["DIV", "INT", -7, "INT", 2], -3],
    [["DIV", "INT", 7, "INT", 0], 0],
    [["ADD", "DINT", 2147483647, "DINT", 1], -2147483648],
    [["MUL", "DINT", 123456789, "DINT", 987654321], -67153019],
    [["SUB", "WORD", 0, "WORD", 1], 65535],
  ];
  for (const [c, expected] of cases) {
    assert.equal(evalNumeric(c), expected, c.join(" "));
  }
});

test("REAL math is rounded to float32", () => {
  assert.equal(evalNumeric(["ADD", "REAL", 0.1, "REAL", 0.2]), Math.fround(0.1 + 0.2));
  assert.equal(evalNumeric(["DIV", "REAL", 1, "REAL", 0]), 0);
});

test("bit ops keep the IN width and sign", () => {
  const cases: [NumCase, number][] = [
    [["SHR", "INT", -1, "INT", 4], 4095],
    [["SHL", "DINT", 1, "INT", 31], -2147483648],
    [["ROL", "DINT", 0x12345678, "INT", 0], 0x12345678],
    [["ROR", "INT", 1, "INT", 1], -32768],
    [["SETBIT", "INT", 0, "INT", 15], -32768],
    [["RESETBIT", "INT", -1, "INT", 15], 32767],
    [["SETBIT", "WORD", 1, "INT", 17], 3],
  ];
  for (const [c, expected] of cases) {
    assert.equal(evalNumeric(c), expected, c.join(" "));
  }
});

test("LOCAL write wraps UINT into INT like C", () => {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    variables: [{ name: "Acc", class: "VAR", type: "INT" }],
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "UINT", value: 40000 } },
      { id: "w", type: "LOCAL", params: { name: "Acc" } },
    ],
    wires: [{ from: { block: "c1", port: "Q" }, to: { block: "w", port: "IN" } }],
  };
  const compiled = compileFbdToIr(baseProject, fbd, "main");
  assert.ok(compiled.ok && compiled.ir, compiled.diagnostics.map((d) => d.message).join("; "));
  // 40000 as uint16 stored into int16_t → −25536
  assert.equal(new PlcSimulator(compiled.ir).stepOnce().vars["main__Acc"], -25536);
});

test("simulator CALL copies IN to callee and OUT back to caller", () => {
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
  const compiled = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["aux", aux],
    ]),
    "main"
  );
  assert.ok(compiled.ok && compiled.ir, compiled.diagnostics.map((d) => d.message).join("; "));
  const sim = new PlcSimulator(compiled.ir);
  assert.equal(sim.stepOnce().vars["DO_Lamp"], true);
});

test("sticky force pins a DI against later writes and a DO against the program", () => {
  const compiled = compileFbdToIr(baseProject, andFbd, "main");
  assert.ok(compiled.ir);
  const sim = new PlcSimulator(compiled.ir);
  sim.setDi(0, true);
  sim.setDi(1, true);
  sim.forceDi(0, false);
  sim.forceDo(0, true);
  const forced = sim.stepOnce();
  assert.equal(forced.di[0], false);
  assert.equal(forced.do[0], true);
  assert.equal(forced.vars["DO_Lamp"], true);
  assert.equal(forced.forces?.length, 2);

  sim.setDi(0, true);
  assert.equal(sim.currentSnapshot().di[0], false);

  sim.unforceDi(0);
  sim.unforceDo(0);
  sim.setDi(0, true);
  sim.setDi(1, true);
  const released = sim.stepOnce();
  assert.equal(released.di[0], true);
  assert.equal(released.do[0], true);
  assert.equal(released.forces, undefined);
});

test("sticky force on a program variable survives the scan", () => {
  const compiled = compileFbdToIr(baseProject, andFbd, "main");
  assert.ok(compiled.ir);
  const sim = new PlcSimulator(compiled.ir);
  sim.forceVar("DO_Lamp", true);
  const snap = sim.stepOnce();
  assert.equal(snap.vars["DO_Lamp"], true);
  assert.equal(snap.do[0], true);
  sim.unforceVar("DO_Lamp");
  assert.equal(sim.stepOnce().do[0], false);
});

test("sticky DI force wins over the virtual plant", () => {
  const compiled = compileFbdToIr(baseProject, andFbd, "main");
  assert.ok(compiled.ir);
  const sim = new PlcSimulator(compiled.ir, undefined, {
    devices: [{ id: "sw1", name: "Run", kind: "switch", di: 0 }],
  });
  sim.setPlantControl("sw1", true);
  assert.equal(sim.currentSnapshot().di[0], true);
  sim.forceDi(0, false);
  sim.setDi(1, true);
  const snap = sim.stepOnce();
  assert.equal(snap.di[0], false);
  assert.equal(snap.do[0], false);
});
