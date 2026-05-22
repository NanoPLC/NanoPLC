import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIoMapFromCatalog,
  M5STACK_STAMPLC_K141,
  GENERIC_ESP32_S3_GPIO,
} from "./deviceCatalog";

test("StamPLC catalog builds 8 DI and 4 DO io-map", () => {
  const map = buildIoMapFromCatalog(M5STACK_STAMPLC_K141);
  assert.equal(map.entries.filter((e) => e.kind === "DI").length, 8);
  assert.equal(map.entries.filter((e) => e.kind === "DO").length, 4);
  assert.equal(map.entries[0].symbol, "DI_1");
  assert.equal(map.entries[7].symbol, "DI_8");
  assert.equal(map.entries[8].symbol, "DO_1");
  assert.equal(map.entries[0].gpio, undefined);
});

test("Generic ESP32-S3 catalog includes GPIO placeholders", () => {
  const map = buildIoMapFromCatalog(GENERIC_ESP32_S3_GPIO);
  assert.equal(map.entries.length, 2);
  assert.equal(map.entries[0].gpio, 0);
  assert.equal(map.entries[1].gpio, 2);
});
