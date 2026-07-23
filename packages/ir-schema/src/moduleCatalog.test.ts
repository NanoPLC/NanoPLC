import assert from "node:assert/strict";
import { test } from "node:test";

import { ioMapIndexOffsets } from "./moduleCatalog";
import {
  buildModuleConfig,
  buildModuleIoMapEntries,
  isModuleCompatibleWithHost,
  M5STACK_STAMPLC_IO,
  M5STACK_STAMPLC_AC,
  nextStamPlcIoModuleId,
  nextStamPlcAcModuleId,
} from "./moduleCatalog";
import { resolveProjectIoProfileFromConfigs } from "./projectIo";
import type { NanoPlcProject } from "./types";
import { PROJECT_SCHEMA_VERSION } from "./constants";

test("StamPLC IO module builds 2 AI and 3 DO entries with global indices", () => {
  const entries = buildModuleIoMapEntries(M5STACK_STAMPLC_IO, { di: 0, do: 4, ai: 0 });
  assert.equal(entries.filter((e) => e.kind === "AI").length, 2);
  assert.equal(entries.filter((e) => e.kind === "DO").length, 3);
  assert.deepEqual(
    entries.filter((e) => e.kind === "AI").map((e) => [e.symbol, e.index]),
    [
      ["AI_1", 0],
      ["AI_2", 1],
    ]
  );
  assert.deepEqual(
    entries.filter((e) => e.kind === "DO").map((e) => [e.symbol, e.index]),
    [
      ["DO_5", 4],
      ["DO_6", 5],
      ["DO_7", 6],
    ]
  );
});

test("StamPLC AC module builds 1 DO at global offset", () => {
  const entries = buildModuleIoMapEntries(M5STACK_STAMPLC_AC, { di: 0, do: 4, ai: 0 });
  assert.equal(entries.length, 1);
  assert.deepEqual(entries[0], {
    symbol: "DO_5",
    kind: "DO",
    index: 4,
    active_high: true,
  });
});

test("buildModuleConfig for StamPLC AC includes fixed I2C 0x44", () => {
  const config = buildModuleConfig(M5STACK_STAMPLC_AC, { di: 0, do: 0, ai: 0 });
  assert.equal(config.catalog_id, "m5stack.stamplc_ac");
  assert.equal(config.i2c_address, 0x44);
  assert.equal(config.outputs?.[0]?.role, "rel_en");
});

test("StamPLC AC is compatible only with StamPLC host", () => {
  assert.equal(isModuleCompatibleWithHost(M5STACK_STAMPLC_AC, "m5stack.stamplc_k141"), true);
  assert.equal(isModuleCompatibleWithHost(M5STACK_STAMPLC_AC, "generic.esp32_s3_gpio"), false);
});

test("buildModuleConfig includes I2C address and output roles", () => {
  const config = buildModuleConfig(M5STACK_STAMPLC_IO, { di: 0, do: 4, ai: 0 });
  assert.equal(config.catalog_id, "m5stack.stamplc_io");
  assert.equal(config.i2c_address, 0x20);
  assert.equal(config.outputs?.length, 3);
  assert.equal(config.io_map.entries.length, 5);
});

test("StamPLC IO is compatible only with StamPLC host", () => {
  assert.equal(isModuleCompatibleWithHost(M5STACK_STAMPLC_IO, "m5stack.stamplc_k141"), true);
  assert.equal(isModuleCompatibleWithHost(M5STACK_STAMPLC_IO, "generic.esp32_s3_gpio"), false);
  assert.equal(isModuleCompatibleWithHost(M5STACK_STAMPLC_IO, undefined), false);
});

test("ioMapIndexOffsets counts highest DI/DO/AI index", () => {
  assert.deepEqual(
    ioMapIndexOffsets([
      { symbol: "DI_1", kind: "DI", index: 0 },
      { symbol: "DI_8", kind: "DI", index: 7 },
      { symbol: "AI_1", kind: "AI", index: 0 },
      { symbol: "AI_2", kind: "AI", index: 1 },
      { symbol: "DO_1", kind: "DO", index: 0 },
      { symbol: "DO_4", kind: "DO", index: 3 },
    ]),
    { di: 8, do: 4, ai: 2 }
  );
});

test("nextStamPlcAcModuleId increments instance suffix", () => {
  assert.equal(nextStamPlcAcModuleId(["stamplc_ac_exp1"]), "stamplc_ac_exp2");
  assert.equal(nextStamPlcAcModuleId([]), "stamplc_ac_exp1");
});

test("nextStamPlcIoModuleId increments instance suffix", () => {
  assert.equal(nextStamPlcIoModuleId(["stamplc_io", "stamplc_io_exp1"]), "stamplc_io_exp2");
  assert.equal(nextStamPlcIoModuleId([]), "stamplc_io_exp1");
});

test("resolveProjectIoProfileFromConfigs merges onboard and expansion maps", () => {
  const project: NanoPlcProject = {
    schema_version: PROJECT_SCHEMA_VERSION,
    name: "demo",
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
    programs: [],
  };

  const configs = new Map<string, unknown>([
    [
      "src/io-map.json",
      {
        schema_version: 1,
        entries: [
          { symbol: "DI_1", kind: "DI", index: 0 },
          { symbol: "DO_4", kind: "DO", index: 3 },
        ],
      },
    ],
    ["src/modules/stamplc_io_exp1.json", buildModuleConfig(M5STACK_STAMPLC_IO, { di: 0, do: 4, ai: 0 })],
  ]);

  const profile = resolveProjectIoProfileFromConfigs(
    project,
    configs as Map<string, import("./moduleCatalog").ModuleConfig>
  );
  assert.equal(profile.di.length, 1);
  assert.equal(profile.ai.length, 2);
  assert.equal(profile.do.length, 4);
  assert.equal(profile.modules.length, 2);
  assert.deepEqual(profile.modules[0].do.map((c) => [c.channel, c.symbol]), [[1, "DO_4"]]);
  assert.deepEqual(profile.modules[1].do.map((c) => [c.channel, c.symbol]), [
    [1, "DO_5"],
    [2, "DO_6"],
    [3, "DO_7"],
  ]);
});
