import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import { buildModuleConfig, M5STACK_STAMPLC_IO, type ModuleConfig } from "../moduleCatalog";
import { buildIoMapFromCatalog, M5STACK_STAMPLC_K141 } from "../deviceCatalog";
import { PROJECT_SCHEMA_VERSION } from "../constants";
import { compileFbdToIr } from "../compileFbd";
import { codegenFirmware } from "./cGenerator";
import { resolveAw9523Bindings, resolveStamPlcIoBindings } from "./driverBindings";
import type { FbdSource, NanoPlcProject } from "../types";

const stamplcProject: NanoPlcProject = {
  schema_version: PROJECT_SCHEMA_VERSION,
  name: "stamplc_exp",
  device: { board: "m5stack-stamplc", idf_target: "esp32s3", catalog_id: "m5stack.stamplc_k141" },
  scan: { period_ms: 10 },
  modules: [
    { id: "stamplc_io", name: "Onboard", type: "m5_stamplc_io", config: "src/io-map.json" },
    {
      id: "stamplc_io_exp1",
      name: "StamPLC IO",
      type: "m5_stamplc_io_expansion",
      config: "src/modules/stamplc_io_exp1.json",
    },
  ],
  drivers: [
    { id: "hal_stamplc", name: "AW9523", type: "m5_aw9523", binds: "stamplc_io" },
    {
      id: "stamplc_io_exp1_drv",
      name: "StamPLC IO I2C",
      type: "m5_stamplc_io",
      binds: "stamplc_io_exp1",
    },
  ],
  programs: [{ id: "main", name: "Main", source: "src/main.fbd.json", language: "fbd" }],
};

const expConfig = buildModuleConfig(M5STACK_STAMPLC_IO, { di: 0, do: 4, ai: 0 });
expConfig.i2c_address = 0x21;

const onboardConfig: ModuleConfig = {
  schema_version: 1,
  io_map: buildIoMapFromCatalog(M5STACK_STAMPLC_K141),
};

test("resolveStamPlcIoBindings maps DO indices to I2C role bits", () => {
  const fbd: FbdSource = {
    schema_version: 1,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_1" } },
      { id: "do5", type: "DO", params: { channel: 5, symbol: "DO_5" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do5", port: "IN" } }],
  };
  const compiled = compileFbdToIr(stamplcProject, fbd, "main");
  assert.ok(compiled.ir);

  const moduleConfigs = new Map([["src/modules/stamplc_io_exp1.json", expConfig]]);
  const bindings = resolveStamPlcIoBindings(stamplcProject, compiled.ir, undefined, moduleConfigs);
  assert.equal(bindings.length, 1);
  assert.equal(bindings[0].i2cAddress, 0x21);
  assert.deepEqual(bindings[0].doBindings.map((b) => [b.processIndex, b.roleBit]), [[4, 4]]);
});

test("resolveAw9523Bindings maps onboard DI/DO to AW9523 channels", () => {
  const fbd: FbdSource = {
    schema_version: 1,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_1" } },
      { id: "do1", type: "DO", params: { channel: 1, symbol: "DO_1" } },
    ],
    wires: [{ from: { block: "di1", port: "Q" }, to: { block: "do1", port: "IN" } }],
  };
  const compiled = compileFbdToIr(stamplcProject, fbd, "main");
  assert.ok(compiled.ir);

  const binding = resolveAw9523Bindings(stamplcProject, compiled.ir, new Map([
    ["src/io-map.json", onboardConfig],
  ]));
  assert.ok(binding);
  assert.deepEqual(binding.diBindings, [{ processIndex: 0, channel: 0 }]);
  assert.deepEqual(binding.doBindings, [{ processIndex: 0, channel: 0 }]);
});

test("resolveStamPlcIoBindings maps AI indices to analog channels", () => {
  const fbd: FbdSource = {
    schema_version: 1,
    name: "Main",
    blocks: [{ id: "ai1", type: "AI", params: { channel: 1, symbol: "AI_1" } }],
    wires: [],
  };
  const compiled = compileFbdToIr(stamplcProject, fbd, "main");
  assert.ok(compiled.ir);

  const bindings = resolveStamPlcIoBindings(stamplcProject, compiled.ir, undefined, new Map([
    ["src/modules/stamplc_io_exp1.json", expConfig],
  ]));
  assert.equal(bindings.length, 1);
  assert.deepEqual(bindings[0].aiBindings, [{ processIndex: 0, channel: 1 }]);
});

test("codegenFirmware emits StamPLC IO init and DO writer registration", () => {
  const fbd: FbdSource = {
    schema_version: 1,
    name: "Main",
    blocks: [
      { id: "di1", type: "DI", params: { channel: 1, symbol: "DI_1" } },
      { id: "do5", type: "DO", params: { channel: 5, symbol: "DO_5" } },
      { id: "do6", type: "DO", params: { channel: 6, symbol: "DO_6" } },
    ],
    wires: [
      { from: { block: "di1", port: "Q" }, to: { block: "do5", port: "IN" } },
      { from: { block: "di1", port: "Q" }, to: { block: "do6", port: "IN" } },
    ],
  };
  const compiled = compileFbdToIr(stamplcProject, fbd, "main");
  assert.ok(compiled.ir);
  const hash = createHash("sha256").update(JSON.stringify(compiled.ir)).digest("hex");

  const out = codegenFirmware(compiled.ir, hash, {
    project: stamplcProject,
    moduleConfigs: new Map([
      ["src/io-map.json", onboardConfig],
      ["src/modules/stamplc_io_exp1.json", expConfig],
    ]),
  });

  assert.match(out.io_hal_config_c, /m5_aw9523_init/);
  assert.match(out.io_hal_config_c, /nanoplc_hal_register_di_reader\(0,/);
  assert.match(out.io_hal_config_c, /m5_stamplc_io_bus_init/);
  assert.match(out.io_hal_config_c, /m5_stamplc_io_init\(&npgen_stamplc_io_exp1, 0x21\)/);
  assert.match(out.io_hal_config_c, /M5_STAMPLC_IO_BIT_RELAY_TRIG/);
  assert.match(out.io_hal_config_c, /nanoplc_hal_register_do_writer\(4,/);
  assert.match(out.io_hal_config_c, /npgen_bind_stamplc_io_modules/);
});
