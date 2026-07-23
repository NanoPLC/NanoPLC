import type { ModuleConfig } from "../moduleCatalog";
import { resolveDeviceTree } from "../projectTreeDefaults";
import type { IoMap, NanoPlcProject, PlcIr } from "../types";

/** StamPLC IO REG_IO_CONTROL role names from module config → firmware bit index. */
export const STAMPLC_IO_ROLE_BITS: Record<string, number> = {
  ex_ctr_1: 0,
  ex_ctr_2: 1,
  relay_trig_0: 4,
};

export interface StamPlcIoDoBinding {
  processIndex: number;
  roleBit: number;
  activeHigh: boolean;
}

export interface StamPlcIoAiBinding {
  processIndex: number;
  /** StamPLC IO analog channel 1 or 2. */
  channel: number;
}

export interface StamPlcIoDriverBinding {
  moduleId: string;
  cDeviceVar: string;
  i2cAddress: number;
  doBindings: StamPlcIoDoBinding[];
  aiBindings: StamPlcIoAiBinding[];
}

export interface Aw9523DiBinding {
  processIndex: number;
  channel: number;
}

export interface Aw9523DoBinding {
  processIndex: number;
  channel: number;
}

export interface Aw9523DriverBinding {
  diBindings: Aw9523DiBinding[];
  doBindings: Aw9523DoBinding[];
}

function cVarName(moduleId: string): string {
  return `npgen_${moduleId.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

function roleToBit(role: string): number | undefined {
  return STAMPLC_IO_ROLE_BITS[role.trim()];
}

function aiChannelFromSymbol(symbol: string): number | undefined {
  const match = /(\d+)\s*$/.exec(symbol.trim());
  if (!match) {
    return undefined;
  }
  const channel = Number(match[1]);
  return channel === 1 || channel === 2 ? channel : undefined;
}

function moduleChannelOffset(entries: { index: number }[]): number {
  if (entries.length === 0) {
    return 0;
  }
  return Math.min(...entries.map((e) => e.index));
}

/** Resolve m5_stamplc_io driver bindings from project metadata and module configs. */
export function resolveStamPlcIoBindings(
  project: NanoPlcProject,
  ir: PlcIr,
  mergedIoMap: IoMap | undefined,
  moduleConfigs: Map<string, ModuleConfig>
): StamPlcIoDriverBinding[] {
  const { modules, drivers } = resolveDeviceTree(project);
  const bindings: StamPlcIoDriverBinding[] = [];

  for (const drv of drivers) {
    if (drv.type !== "m5_stamplc_io") {
      continue;
    }
    const mod = modules.find((m) => m.id === drv.binds);
    if (!mod?.config) {
      continue;
    }
    const config = moduleConfigs.get(mod.config);
    if (!config) {
      continue;
    }

    const doEntries = config.io_map.entries
      .filter((e) => e.kind === "DO")
      .sort((a, b) => a.index - b.index);
    const aiEntries = config.io_map.entries
      .filter((e) => e.kind === "AI")
      .sort((a, b) => a.index - b.index);
    const outputs = config.outputs ?? [];
    const doBindings: StamPlcIoDoBinding[] = [];
    const aiBindings: StamPlcIoAiBinding[] = [];

    for (let i = 0; i < doEntries.length; i++) {
      const entry = doEntries[i];
      if (!ir.io_image.do.some((d) => d.index === entry.index)) {
        continue;
      }
      const role = outputs[i]?.role;
      if (!role) {
        continue;
      }
      const bit = roleToBit(role);
      if (bit === undefined) {
        continue;
      }
      const mapped = mergedIoMap?.entries.find((e) => e.kind === "DO" && e.symbol === entry.symbol);
      doBindings.push({
        processIndex: entry.index,
        roleBit: bit,
        activeHigh: mapped?.active_high ?? entry.active_high ?? true,
      });
    }

    for (let i = 0; i < aiEntries.length; i++) {
      const entry = aiEntries[i];
      if (!ir.io_image.ai.some((d) => d.index === entry.index)) {
        continue;
      }
      const channel = aiChannelFromSymbol(entry.symbol) ?? i + 1;
      if (channel !== 1 && channel !== 2) {
        continue;
      }
      aiBindings.push({
        processIndex: entry.index,
        channel,
      });
    }

    if (doBindings.length === 0 && aiBindings.length === 0) {
      continue;
    }

    bindings.push({
      moduleId: mod.id,
      cDeviceVar: cVarName(mod.id),
      i2cAddress: config.i2c_address ?? 0x20,
      doBindings,
      aiBindings,
    });
  }

  return bindings;
}

/** Resolve onboard AW9523 DI/DO bindings (StamPLC K141). */
export function resolveAw9523Bindings(
  project: NanoPlcProject,
  ir: PlcIr,
  moduleConfigs: Map<string, ModuleConfig>
): Aw9523DriverBinding | undefined {
  const { modules, drivers } = resolveDeviceTree(project);
  const drv = drivers.find((d) => d.type === "m5_aw9523");
  if (!drv?.binds) {
    return undefined;
  }

  const mod = modules.find((m) => m.id === drv.binds);
  if (!mod?.config) {
    return undefined;
  }
  const config = moduleConfigs.get(mod.config);
  if (!config) {
    return undefined;
  }

  const diEntries = config.io_map.entries
    .filter((e) => e.kind === "DI")
    .sort((a, b) => a.index - b.index);
  const doEntries = config.io_map.entries
    .filter((e) => e.kind === "DO")
    .sort((a, b) => a.index - b.index);
  const diBase = moduleChannelOffset(diEntries);
  const doBase = moduleChannelOffset(doEntries);

  const diBindings: Aw9523DiBinding[] = [];
  for (const entry of diEntries) {
    if (!ir.io_image.di.some((d) => d.index === entry.index)) {
      continue;
    }
    diBindings.push({
      processIndex: entry.index,
      channel: entry.index - diBase,
    });
  }

  const doBindings: Aw9523DoBinding[] = [];
  for (const entry of doEntries) {
    if (!ir.io_image.do.some((d) => d.index === entry.index)) {
      continue;
    }
    doBindings.push({
      processIndex: entry.index,
      channel: entry.index - doBase,
    });
  }

  if (diBindings.length === 0 && doBindings.length === 0) {
    return undefined;
  }

  return { diBindings, doBindings };
}
