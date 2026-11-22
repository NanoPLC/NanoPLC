import assert from "node:assert/strict";
import { test } from "node:test";

import { compileFbdToIr } from "../compileFbd";
import { FBD_SOURCE_SCHEMA_VERSION, PROJECT_SCHEMA_VERSION } from "../constants";
import { PlcSimulator } from "../simulator/PlcSimulator";
import type { FbdSource, NanoPlcProject } from "../types";
import { validateProject } from "../validate";
import { nextPlantDeviceId, parseVirtualPlant } from "./parsePlant";
import type { PlantImage, VirtualPlantConfig } from "./types";
import { VirtualPlant } from "./VirtualPlant";

function image(di = 4, ai = 2, dout = 4): PlantImage {
  return {
    di: Array.from({ length: di }, () => false),
    ai: Array.from({ length: ai }, () => 0),
    do: Array.from({ length: dout }, () => false),
  };
}

test("pushbutton owns its DI and a switch latches", () => {
  const plant = new VirtualPlant({
    devices: [
      { id: "pb1", name: "Start", kind: "pushbutton", di: 0 },
      { id: "sw1", name: "Enable", kind: "switch", di: 1 },
    ],
  });
  const io = image();
  plant.integrate(io, 0);
  assert.equal(io.di[0], false);
  plant.setControl("pb1", true, io);
  assert.equal(io.di[0], true);
  plant.setControl("pb1", false, io);
  assert.equal(io.di[0], false);
  plant.setControl("sw1", true, io);
  plant.integrate(io, 500);
  assert.equal(io.di[1], true);
});

test("transmitter profiles clamp engineering values into the AI image", () => {
  const parsed = parseVirtualPlant({
    devices: [
      { id: "tx1", name: "Temp", kind: "transmitter", profile: "temperature", ai: 0 },
      { id: "tx2", name: "Pressure", kind: "transmitter", profile: "pressure", ai: 1 },
    ],
  });
  assert.equal(parsed.diagnostics.length, 0);
  assert.ok(parsed.config);
  const plant = new VirtualPlant(parsed.config);
  const io = image();
  plant.integrate(io, 0);
  assert.equal(io.ai[0], 25);
  assert.equal(io.ai[1], 0);
  plant.setControl("tx1", 1000, io);
  assert.equal(io.ai[0], 150);
  const snap = plant.snapshot(io);
  assert.equal(snap.devices[0]?.unit, "°C");
  assert.equal(snap.devices[1]?.unit, "bar");
});

test("motor feedback waits for response_ms of continuous run command", () => {
  const plant = new VirtualPlant({
    devices: [
      { id: "motor1", name: "Pump", kind: "motor", run_do: 0, running_di: 1, response_ms: 100 },
    ],
  });
  const io = image();
  io.do[0] = true;
  plant.integrate(io, 90);
  assert.equal(io.di[1], false);
  assert.equal(plant.snapshot(io).devices[0]?.status, "Starting");
  plant.integrate(io, 10);
  assert.equal(io.di[1], true);
  io.do[0] = false;
  plant.integrate(io, 0);
  assert.equal(io.di[1], false);
});

test("valve travels open and closed and reports the opened switch", () => {
  const plant = new VirtualPlant({
    devices: [{ id: "valve1", name: "Fill", kind: "valve", open_do: 0, opened_di: 2, travel_ms: 1000 }],
  });
  const io = image();
  io.do[0] = true;
  plant.integrate(io, 500);
  assert.equal(plant.snapshot(io).devices[0]?.number, 50);
  assert.equal(io.di[2], false);
  plant.integrate(io, 500);
  assert.equal(io.di[2], true);
  io.do[0] = false;
  plant.integrate(io, 1000);
  assert.equal(io.di[2], false);
});

test("tank fills, drains, clamps, and drives high/low switches", () => {
  const plant = new VirtualPlant({
    devices: [
      {
        id: "tank1",
        name: "Sump",
        kind: "tank",
        level_ai: 0,
        inlet_do: 0,
        outlet_do: 1,
        fill_per_s: 10,
        drain_per_s: 10,
        high_di: 0,
        low_di: 1,
        high_pct: 80,
        low_pct: 20,
        initial_pct: 0,
      },
    ],
  });
  const io = image();
  plant.integrate(io, 0);
  assert.equal(io.di[1], true);
  io.do[0] = true;
  plant.integrate(io, 1000);
  assert.equal(io.ai[0], 10);
  plant.integrate(io, 8000);
  assert.equal(io.ai[0], 90);
  assert.equal(io.di[0], true);
  assert.equal(io.di[1], false);
  io.do[0] = false;
  io.do[1] = true;
  plant.integrate(io, 20000);
  assert.equal(io.ai[0], 0);
  plant.setControl("tank1", 50, io);
  assert.equal(io.ai[0], 50);
});

test("conveyor photoeye is true only while a part is in the end window", () => {
  const plant = new VirtualPlant({
    devices: [
      {
        id: "conv1",
        name: "Belt",
        kind: "conveyor",
        run_do: 0,
        sensor_di: 0,
        travel_ms: 1000,
        window: 0.05,
      },
    ],
  });
  const io = image();
  plant.setControl("conv1", "load", io);
  plant.setControl("conv1", "load", io);
  assert.equal(plant.snapshot(io).devices[0]?.can_load, false);
  io.do[0] = true;
  plant.integrate(io, 1000);
  assert.equal(io.di[0], true);
  plant.integrate(io, 50);
  assert.equal(io.di[0], true);
  plant.integrate(io, 1);
  assert.equal(io.di[0], false);
  assert.equal(plant.snapshot(io).devices[0]?.status, "Empty");
});

test("parseVirtualPlant rejects duplicate sensor writers and a bad transmitter range", () => {
  const dup = parseVirtualPlant({
    devices: [
      { id: "pb1", name: "A", kind: "pushbutton", di: 0 },
      { id: "sw1", name: "B", kind: "switch", di: 0 },
    ],
  });
  assert.ok(dup.diagnostics.some((d) => d.code === "NP-0131"));
  assert.equal(dup.config, undefined);

  const range = parseVirtualPlant({
    devices: [{ id: "tx1", name: "T", kind: "transmitter", profile: "adc", ai: 0, min: 5, max: 1 }],
  });
  assert.ok(range.diagnostics.some((d) => d.code === "NP-0133"));

  const missing = parseVirtualPlant({ devices: "nope" });
  assert.ok(missing.diagnostics.some((d) => d.code === "NP-0130"));
});

test("validateProject accepts an optional virtual plant and rejects a broken one", () => {
  const project: NanoPlcProject = {
    schema_version: PROJECT_SCHEMA_VERSION,
    name: "plant",
    device: { board: "esp32-s3", idf_target: "esp32s3" },
    scan: { period_ms: 10 },
    programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
    virtual_plant: {
      devices: [{ id: "lamp1", name: "Lamp", kind: "lamp", do: 0 }],
    },
  };
  const ok = validateProject(project);
  assert.equal(ok.project?.name, "plant");
  assert.equal(
    ok.diagnostics.some((d) => d.code.startsWith("NP-013")),
    false
  );

  const bad = validateProject({
    ...project,
    virtual_plant: { devices: [{ id: "1bad", name: "X", kind: "lamp", do: 0 }] },
  });
  assert.equal(bad.project, undefined);
  assert.ok(bad.diagnostics.some((d) => d.code === "NP-0132"));
});

test("nextPlantDeviceId skips ids already in the plant", () => {
  assert.equal(nextPlantDeviceId("tank", [{ id: "tank1" }]), "tank2");
  assert.equal(nextPlantDeviceId("pushbutton", []), "pb1");
});

const baseProject: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "plant_sim",
  device: { board: "esp32-s3", idf_target: "esp32s3" },
  scan: { period_ms: 10 },
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};

function compileDo(on: boolean): NonNullable<ReturnType<typeof compileFbdToIr>["ir"]> {
  const fbd: FbdSource = {
    schema_version: FBD_SOURCE_SCHEMA_VERSION,
    name: "Main",
    blocks: [
      { id: "c1", type: "CONST", params: { data_type: "BOOL", value: on } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_Run" } },
    ],
    wires: [{ from: { block: "c1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const compiled = compileFbdToIr(baseProject, fbd, "main");
  assert.ok(compiled.ok && compiled.ir, compiled.diagnostics.map((d) => d.message).join("; "));
  return compiled.ir;
}

test("the plant overwrites a manual DI write on the next scan", () => {
  const ir = compileDo(false);
  const plant: VirtualPlantConfig = {
    devices: [{ id: "pb1", name: "Start", kind: "pushbutton", di: 0 }],
  };
  const sim = new PlcSimulator(ir, { di: 2, do: 1, ai: 1 }, plant);
  sim.setDi(0, true);
  const snap = sim.stepOnce();
  assert.equal(snap.di[0], false);
  sim.setPlantControl("pb1", true);
  assert.equal(sim.currentSnapshot().di[0], true);
  assert.equal(sim.currentSnapshot().plant?.devices[0]?.status, "Pressed");
});

test("tank level integrates from the previous scan's inlet DO", () => {
  const ir = compileDo(true);
  const plant: VirtualPlantConfig = {
    devices: [
      {
        id: "tank1",
        name: "Sump",
        kind: "tank",
        level_ai: 0,
        inlet_do: 0,
        fill_per_s: 100,
        drain_per_s: 0,
        high_pct: 80,
        low_pct: 20,
        initial_pct: 0,
      },
    ],
  };
  const sim = new PlcSimulator(ir, { di: 1, do: 1, ai: 1 }, plant);
  const first = sim.stepOnce();
  assert.equal(first.ai[0], 0);
  assert.equal(first.do[0], true);
  sim.advance(100);
  const level = sim.currentSnapshot().ai[0] ?? 0;
  assert.ok(Math.abs(level - 10) < 1e-6, `level ${level}`);
});
