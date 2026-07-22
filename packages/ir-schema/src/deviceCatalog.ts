import { IO_MAP_SCHEMA_VERSION } from "./constants";
import type { IoMap, IoMapEntry, NanoPlcDriverRef, NanoPlcModuleRef, NanoPlcProject } from "./types";

export interface DeviceIoChannel {
  /** 1-based channel number shown in the editor (e.g. Digital In 1). */
  channel: number;
  /** Symbol written into FBD block params and io-map (e.g. DI_1). */
  symbol: string;
  /** 0-based process-image index. */
  index: number;
}

export interface DeviceIoProfile {
  di_count: number;
  do_count: number;
  di_symbol_prefix: string;
  do_symbol_prefix: string;
  /**
   * Explicit 1-based DI channel numbers for modular devices.
   * When omitted, channels are `1 .. di_count`.
   */
  di_channels?: number[];
  /**
   * Explicit 1-based DO channel numbers for modular devices.
   * When omitted, channels are `1 .. do_count`.
   */
  do_channels?: number[];
  /** Direct ESP32 GPIO numbers per process-image index (omit for I/O expander boards). */
  di_gpio?: number[];
  do_gpio?: number[];
}

/** Resolve DI channel numbers from a device I/O profile. */
export function deviceDiChannels(io: DeviceIoProfile): number[] {
  if (io.di_channels && io.di_channels.length > 0) {
    return [...io.di_channels];
  }
  return Array.from({ length: io.di_count }, (_, i) => i + 1);
}

/** Resolve DO channel numbers from a device I/O profile. */
export function deviceDoChannels(io: DeviceIoProfile): number[] {
  if (io.do_channels && io.do_channels.length > 0) {
    return [...io.do_channels];
  }
  return Array.from({ length: io.do_count }, (_, i) => i + 1);
}

/** Build editor/compiler channel lists from a device I/O profile. */
export function listDeviceIoChannels(io: DeviceIoProfile): {
  di: DeviceIoChannel[];
  do: DeviceIoChannel[];
} {
  const di = deviceDiChannels(io).map((channel, index) => ({
    channel,
    symbol: `${io.di_symbol_prefix}${channel}`,
    index,
  }));
  const doList = deviceDoChannels(io).map((channel, index) => ({
    channel,
    symbol: `${io.do_symbol_prefix}${channel}`,
    index,
  }));
  return { di, do: doList };
}

/** Build channel lists from an existing io-map (fallback when catalog_id is absent). */
export function listIoChannelsFromMap(ioMap: IoMap): { di: DeviceIoChannel[]; do: DeviceIoChannel[] } {
  const di: DeviceIoChannel[] = [];
  const doList: DeviceIoChannel[] = [];
  for (const entry of ioMap.entries) {
    const channel = entry.index + 1;
    const row: DeviceIoChannel = { channel, symbol: entry.symbol, index: entry.index };
    if (entry.kind === "DI") {
      di.push(row);
    } else if (entry.kind === "DO") {
      doList.push(row);
    }
  }
  di.sort((a, b) => a.index - b.index);
  doList.sort((a, b) => a.index - b.index);
  return { di, do: doList };
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
  const { di, do: doList } = listDeviceIoChannels(entry.io);

  for (const ch of di) {
    const row: IoMapEntry = {
      symbol: ch.symbol,
      kind: "DI",
      index: ch.index,
      active_high: true,
    };
    if (entry.io.di_gpio?.[ch.index] !== undefined) {
      row.gpio = entry.io.di_gpio[ch.index];
    }
    entries.push(row);
  }

  for (const ch of doList) {
    const row: IoMapEntry = {
      symbol: ch.symbol,
      kind: "DO",
      index: ch.index,
      active_high: true,
    };
    if (entry.io.do_gpio?.[ch.index] !== undefined) {
      row.gpio = entry.io.do_gpio[ch.index];
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
