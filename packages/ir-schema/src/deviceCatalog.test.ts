import assert from "node:assert/strict";
import { test } from "node:test";

import {
  buildIoMapFromCatalog,
  listDeviceIoChannels,
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

test("explicit di_channels / do_channels drive symbols and indices", () => {
  const map = buildIoMapFromCatalog({
    ...GENERIC_ESP32_S3_GPIO,
    io: {
      di_count: 2,
      do_count: 1,
      di_symbol_prefix: "DI_",
      do_symbol_prefix: "DO_",
      di_channels: [2, 5],
      do_channels: [3],
      di_gpio: [10, 11],
      do_gpio: [12],
    },
  });
  assert.deepEqual(
    map.entries.map((e) => [e.symbol, e.kind, e.index, e.gpio]),
    [
      ["DI_2", "DI", 0, 10],
      ["DI_5", "DI", 1, 11],
      ["DO_3", "DO", 0, 12],
    ]
  );
});

test("listDeviceIoChannels defaults to 1..N", () => {
  const { di, do: doList } = listDeviceIoChannels(M5STACK_STAMPLC_K141.io);
  assert.equal(di.length, 8);
  assert.equal(doList.length, 4);
  assert.deepEqual(di[0], { channel: 1, symbol: "DI_1", index: 0 });
  assert.deepEqual(doList[3], { channel: 4, symbol: "DO_4", index: 3 });
});
