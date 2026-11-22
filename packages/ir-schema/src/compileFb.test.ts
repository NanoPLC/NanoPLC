import assert from "node:assert/strict";
import { test } from "node:test";

import { codegenC } from "./codegen/cGenerator";
import { compileProjectToIr } from "./compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "./constants";
import { PlcSimulator } from "./simulator/PlcSimulator";
import type { FbdSource, NanoPlcProject } from "./types";

const gate: FbdSource = {
  schema_version: FBD_SOURCE_SCHEMA_VERSION,
  name: "Gate",
  variables: [
    { name: "A", class: "IN", type: "BOOL" },
    { name: "Q", class: "OUT", type: "BOOL" },
  ],
  blocks: [
    { id: "inA", type: "LOCAL", params: { name: "A" } },
    { id: "ton1", type: "TON", params: { pt_ms: 50 } },
    { id: "outQ", type: "LOCAL", params: { name: "Q" } },
  ],
  wires: [
    { from: { block: "inA", port: "Q" }, to: { block: "ton1", port: "IN" } },
    { from: { block: "ton1", port: "Q" }, to: { block: "outQ", port: "IN" } },
  ],
};

const main: FbdSource = {
  schema_version: FBD_SOURCE_SCHEMA_VERSION,
  name: "Main",
  blocks: [
    { id: "di0", type: "DI", params: { channel: 1, symbol: "DI_A" } },
    { id: "di1", type: "DI", params: { channel: 2, symbol: "DI_B" } },
    { id: "fb1", type: "FB", params: { fb: "gate" } },
    { id: "fb2", type: "FB", params: { fb: "gate" } },
    { id: "do0", type: "DO", params: { channel: 1, symbol: "DO_A" } },
    { id: "do1", type: "DO", params: { channel: 2, symbol: "DO_B" } },
  ],
  wires: [
    { from: { block: "di0", port: "Q" }, to: { block: "fb1", port: "A" } },
    { from: { block: "fb1", port: "Q" }, to: { block: "do0", port: "IN" } },
    { from: { block: "di1", port: "Q" }, to: { block: "fb2", port: "A" } },
    { from: { block: "fb2", port: "Q" }, to: { block: "do1", port: "IN" } },
  ],
};

const project: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "fb_gate",
  device: { board: "esp32-s3", idf_target: "esp32s3" },
  scan: { period_ms: 10 },
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
  function_blocks: [{ id: "gate", name: "Gate", source: "src/gate.fbd.json", language: "fbd" }],
};

test("function block instances keep separate timers", () => {
  const compiled = compileProjectToIr(
    project,
    new Map<string, unknown>([
      ["main", main],
      ["gate", gate],
    ]),
    "main"
  );
  assert.equal(compiled.ok, true, compiled.diagnostics.map((d) => d.message).join("; "));
  assert.equal(compiled.ir?.fb_defs?.length, 1);
  assert.equal(compiled.ir?.fb_instances?.length, 2);
  assert.ok(compiled.ir?.schedule.some((step) => step.op === "fb" && step.block_id === "fb1"));

  const sim = new PlcSimulator(compiled.ir!);
  sim.setDi(0, true);
  sim.setDi(1, false);
  let snap = sim.currentSnapshot();
  for (let i = 0; i < 6; i++) {
    snap = sim.stepOnce();
  }
  assert.equal(snap.do[0], true);
  assert.equal(snap.do[1], false);

  const c = codegenC(compiled.ir!, "abcd").plc_program_c;
  assert.match(c, /npgen_fb_fb1/);
  assert.match(c, /npgen_fb_fb2/);
});
