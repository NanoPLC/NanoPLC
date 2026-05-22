import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { compileFbdToIr } from "../compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../constants";
import { PlcSimulator } from "./PlcSimulator";
import type { FbdSource, NanoPlcProject } from "../types";

const andFbd: FbdSource = {
  schema_version: FBD_SOURCE_SCHEMA_VERSION,
  name: "Main",
  blocks: [
    { id: "di_start", type: "DI", params: { symbol: "DI_Start" } },
    { id: "di_en", type: "DI", params: { symbol: "DI_Enable" } },
    { id: "and1", type: "AND" },
    { id: "do_lamp", type: "DO", params: { symbol: "DO_Lamp" } },
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
