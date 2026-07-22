export {
  FBD_SOURCE_SCHEMA_VERSION,
  IO_MAP_SCHEMA_VERSION,
  IR_VERSION,
  PROJECT_SCHEMA_VERSION,
} from "./constants";
export { compileFbdToIr } from "./compileFbd";
export { codegenC, computeIrMagic, codegenFirmware } from "./codegen/cGenerator";
export type { CodegenCResult } from "./codegen/cGenerator";
export type { CodegenFirmwareOutput } from "./codegen/codegenFirmware";
export { PlcSimulator } from "./simulator/PlcSimulator";
export type { SimulatorSnapshot, TonInstanceState } from "./simulator/types";
export { createSimState, executeScheduleStep, runScan, snapshot } from "./simulator/executeScan";
export type {
  CompileDiagnostic,
  CompileResult,
  FbdBlock,
  FbdPortRef,
  FbdSource,
  FbdWire,
  IoMap,
  IoMapEntry,
  IrIoImage,
  IrVariable,
  NanoPlcProgramRef,
  NanoPlcModuleRef,
  NanoPlcDriverRef,
  NanoPlcProject,
  PlcIr,
  PlcPrimitiveType,
  ScheduleOp,
  ScheduleStep,
} from "./types";
export { PLC_PRIMITIVE_TYPES } from "./types";
export {
  DEVICE_CATALOG,
  GENERIC_ESP32_S3_GPIO,
  M5STACK_STAMPLC_K141,
  buildIoMapFromCatalog,
  buildProjectDeviceFields,
  catalogLabel,
  deviceDiChannels,
  deviceDoChannels,
  findDeviceCatalogEntry,
  listDeviceIoChannels,
  listIoChannelsFromMap,
} from "./deviceCatalog";
export type { DeviceCatalogEntry, DeviceIoChannel, DeviceIoProfile } from "./deviceCatalog";
export { resolveDeviceTree, defaultProjectModules, defaultProjectDrivers, DEFAULT_GPIO_MODULE, DEFAULT_HAL_DRIVER } from "./projectTreeDefaults";
export type { ResolvedDeviceTree } from "./projectTreeDefaults";
export { validateFbdSource, validateProject } from "./validate";
