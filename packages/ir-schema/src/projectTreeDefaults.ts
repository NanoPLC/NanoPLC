import type { NanoPlcDriverRef, NanoPlcModuleRef, NanoPlcProject } from "./types";

export const DEFAULT_GPIO_MODULE: NanoPlcModuleRef = {
  id: "gpio1",
  name: "Onboard GPIO (digital)",
  type: "gpio_digital_io",
  config: "src/io-map.json",
};

export const DEFAULT_HAL_DRIVER: NanoPlcDriverRef = {
  id: "hal_gpio",
  name: "GPIO process image (nanoplc_hal)",
  type: "nanoplc_hal",
  binds: DEFAULT_GPIO_MODULE.id,
};

export interface ResolvedDeviceTree {
  modules: NanoPlcModuleRef[];
  drivers: NanoPlcDriverRef[];
}

/** Merge on-disk project with TIA-style defaults when modules/drivers are omitted. */
export function resolveDeviceTree(project: NanoPlcProject): ResolvedDeviceTree {
  const modules = project.modules?.length ? project.modules : [DEFAULT_GPIO_MODULE];
  const drivers = project.drivers?.length ? project.drivers : [DEFAULT_HAL_DRIVER];
  return { modules, drivers };
}

export function defaultProjectModules(): NanoPlcModuleRef[] {
  return [{ ...DEFAULT_GPIO_MODULE }];
}

export function defaultProjectDrivers(): NanoPlcDriverRef[] {
  return [{ ...DEFAULT_HAL_DRIVER }];
}
