import { IO_MAP_SCHEMA_VERSION } from "./constants";
import type { IoMap, IoMapEntry, NanoPlcDriverRef, NanoPlcModuleRef, NanoPlcProject } from "./types";

export interface DeviceIoProfile {
  di_count: number;
  do_count: number;
  di_symbol_prefix: string;
  do_symbol_prefix: string;
  /** Direct ESP32 GPIO numbers per process-image index (omit for I/O expander boards). */
  di_gpio?: number[];
  do_gpio?: number[];
}

export interface DeviceCatalogEntry {
  id: string;
  vendor: string;
  model: string;
  label: string;
  description: string;
  shop_url?: string;
  board: string;
  idf_target: string;
  scan_period_ms: number;
  io: DeviceIoProfile;
  module: NanoPlcModuleRef;
  driver: NanoPlcDriverRef;
}

export const M5STACK_STAMPLC_K141: DeviceCatalogEntry = {
  id: "m5stack.stamplc_k141",
  vendor: "M5Stack",
  model: "StamPLC (K141)",
  label: "M5Stack StamPLC Controller (StampS3)",
  description:
    "8 opto-isolated digital inputs, 4 relay outputs (AW9523 I/O expander). ESP32-S3FN8, DIN rail.",
  shop_url: "https://shop.m5stack.com/products/m5stamp-plc-controller-with-m5stamps3",
  board: "m5stack-stamplc",
  idf_target: "esp32s3",
  scan_period_ms: 10,
  io: {
    di_count: 8,
    do_count: 4,
    di_symbol_prefix: "DI_",
    do_symbol_prefix: "DO_",
  },
  module: {
    id: "stamplc_io",
    name: "StamPLC onboard I/O (8 DI / 4 relay)",
    type: "m5_stamplc_io",
    config: "src/io-map.json",
  },
  driver: {
    id: "hal_stamplc",
    name: "StamPLC AW9523 I/O expander",
    type: "m5_aw9523",
    binds: "stamplc_io",
  },
};

export const GENERIC_ESP32_S3_GPIO: DeviceCatalogEntry = {
  id: "generic.esp32_s3_gpio",
  vendor: "Generic",
  model: "ESP32-S3 devkit (GPIO)",
  label: "Generic ESP32-S3 (GPIO placeholders)",
  description: "Minimal 1 DI / 1 DO example with direct GPIO mapping for bring-up.",
  board: "esp32-s3",
  idf_target: "esp32s3",
  scan_period_ms: 10,
  io: {
    di_count: 1,
    do_count: 1,
    di_symbol_prefix: "DI_",
    do_symbol_prefix: "DO_",
    di_gpio: [0],
    do_gpio: [2],
  },
  module: {
    id: "gpio1",
    name: "Onboard GPIO (digital)",
    type: "gpio_digital_io",
    config: "src/io-map.json",
  },
  driver: {
    id: "hal_gpio",
    name: "GPIO process image (nanoplc_hal)",
    type: "nanoplc_hal",
    binds: "gpio1",
  },
};

export const DEVICE_CATALOG: DeviceCatalogEntry[] = [M5STACK_STAMPLC_K141, GENERIC_ESP32_S3_GPIO];

export function findDeviceCatalogEntry(id: string): DeviceCatalogEntry | undefined {
  return DEVICE_CATALOG.find((d) => d.id === id);
}

export function buildIoMapFromCatalog(entry: DeviceCatalogEntry): IoMap {
  const entries: IoMapEntry[] = [];

  for (let i = 0; i < entry.io.di_count; i++) {
    const row: IoMapEntry = {
      symbol: `${entry.io.di_symbol_prefix}${i + 1}`,
      kind: "DI",
      index: i,
      active_high: true,
    };
    if (entry.io.di_gpio?.[i] !== undefined) {
      row.gpio = entry.io.di_gpio[i];
    }
    entries.push(row);
  }

  for (let i = 0; i < entry.io.do_count; i++) {
    const row: IoMapEntry = {
      symbol: `${entry.io.do_symbol_prefix}${i + 1}`,
      kind: "DO",
      index: i,
      active_high: true,
    };
    if (entry.io.do_gpio?.[i] !== undefined) {
      row.gpio = entry.io.do_gpio[i];
    }
    entries.push(row);
  }

  return { schema_version: IO_MAP_SCHEMA_VERSION, entries };
}

export function buildProjectDeviceFields(entry: DeviceCatalogEntry): NanoPlcProject["device"] {
  return {
    board: entry.board,
    idf_target: entry.idf_target,
    catalog_id: entry.id,
    vendor: entry.vendor,
    model: entry.model,
  };
}

export function catalogLabel(entry: DeviceCatalogEntry): string {
  return `${entry.label} — ${entry.io.di_count} DI / ${entry.io.do_count} DO`;
}
