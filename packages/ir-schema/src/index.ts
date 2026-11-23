export {
  FBD_SOURCE_SCHEMA_VERSION,
  IO_MAP_SCHEMA_VERSION,
  IR_VERSION,
  PROJECT_SCHEMA_VERSION,
} from "./constants";
export { compileFbdToIr, compileProjectToIr, compileTasksToIr } from "./compileFbd";
export { FREEWHEEL_PERIOD_MS, irPrimaryPeriodMs, irPrimaryTask, irTaskList, irTaskPeriodMs } from "./irTasks";
export { fbdOutputVar, fbdSourcePortIrName, resolveIoSymbol } from "./fbdIrNames";
export { inferFbdPortTypes } from "./fbdPortTypes";
export type { FbdPortTypes, FbdPortContext } from "./fbdPortTypes";
export {
  callBlockPorts,
  defaultPouInitial,
  findPouVariable,
  localBlockPorts,
  nextPouVarName,
  parsePouVariables,
  pouIrName,
} from "./pouVars";
export { codegenC, computeIrMagic, codegenFirmware } from "./codegen/cGenerator";
export type { CodegenCResult } from "./codegen/cGenerator";
export type { CodegenFirmwareOutput, CodegenIoContext } from "./codegen/codegenFirmware";
export { PlcSimulator } from "./simulator/PlcSimulator";
export type {
  SimForce,
  SimIoCapacity,
  SimulatorSnapshot,
  TimerInstanceState,
  TonInstanceState,
} from "./simulator/types";
export { createSimState, executeScheduleStep, runScan, snapshot } from "./simulator/executeScan";
export type {
  CompileDiagnostic,
  CompileResult,
  FbdBlock,
  FbdPortRef,
  FbdSource,
  FbdVariable,
  FbdWire,
  IoMap,
  IoMapEntry,
  IrIoImage,
  IrEventSource,
  IrTask,
  IrVariable,
  NanoPlcProgramRef,
  NanoPlcModuleRef,
  NanoPlcDriverRef,
  NanoPlcProject,
  NanoPlcTaskPouCall,
  NanoPlcTaskRef,
  NanoPlcTaskWatchdog,
  PlcIr,
  PlcPrimitiveType,
  PlcTaskKind,
  PlcVarClass,
  WatchdogAction,
  ScheduleOp,
  ScheduleStep,
} from "./types";
export { PLC_PRIMITIVE_TYPES, PLC_TASK_KINDS, PLC_VAR_CLASSES } from "./types";
export {
  DEFAULT_CYCLIC_INTERVAL_MS,
  DEFAULT_EXTRA_TASK_PRIORITY,
  DEFAULT_MAIN_TASK_ID,
  DEFAULT_MAIN_TASK_NAME,
  DEFAULT_TASK_PRIORITY,
  DEFAULT_WATCHDOG_TIME_MS,
  MAX_TASK_PRIORITY,
  MIN_TASK_PRIORITY,
  defaultMainTask,
  ensureProjectTasks,
  entryProgram,
  findTask,
  isPlcTaskKind,
  normalizeTask,
  primaryCyclicTask,
  projectScanPeriodMs,
  resolveTaskConfiguration,
  setTaskProgram,
  syncScanFromTasks,
  taskDescription,
  taskEntryProgramId,
  taskKindLabel,
} from "./tasks";
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
export {
  MODULE_CATALOG,
  M5STACK_STAMPLC_IO,
  M5STACK_STAMPLC_AC,
  buildModuleAndDriverRefs,
  buildModuleConfig,
  buildModuleIoMapEntries,
  findModuleCatalogEntry,
  ioMapIndexOffsets,
  isModuleCompatibleWithHost,
  listCompatibleModules,
  moduleCatalogLabel,
  moduleConfigRelativePath,
  nextStamPlcIoModuleId,
  nextStamPlcAcModuleId,
} from "./moduleCatalog";
export type { ModuleCatalogEntry, ModuleConfig } from "./moduleCatalog";
export {
  buildMergedIoMap,
  mergeProjectIoEntries,
  moduleConfigEntries,
  parseModuleConfig,
  projectIoProfileFromEntries,
  resolveProjectIoProfileFromConfigs,
} from "./projectIo";
export type { ProjectIoProfile, IoModuleChannels } from "./projectIo";
export { listIoChannelsFromModuleEntries } from "./projectIo";
export { resolveDeviceTree, defaultProjectModules, defaultProjectDrivers, DEFAULT_GPIO_MODULE, DEFAULT_HAL_DRIVER } from "./projectTreeDefaults";
export { VirtualPlant } from "./plant/VirtualPlant";
export { nextPlantDeviceId, parseVirtualPlant } from "./plant/parsePlant";
export {
  PLANT_DEVICE_KINDS,
  TRANSMITTER_DEFAULTS,
  TRANSMITTER_PROFILES,
  plantDeviceSummary,
} from "./plant/types";
export type {
  ConveyorDevice,
  LampDevice,
  MotorDevice,
  PlantDeviceKind,
  PlantDeviceSnapshot,
  PlantImage,
  PlantSnapshot,
  PushbuttonDevice,
  SwitchDevice,
  TankDevice,
  TransmitterDevice,
  TransmitterProfile,
  ValveDevice,
  VirtualDevice,
  VirtualPlantConfig,
} from "./plant/types";
export {
  DEFAULT_MODBUS_PORT,
  DEFAULT_MQTT_PORT,
  DEFAULT_MQTT_PREFIX,
  DEFAULT_OPCUA_PORT,
  resolveFieldbus,
} from "./fieldbus/config";
export type { NanoPlcCommunication, NanoPlcFieldbusEndpoint, ResolvedFieldbus } from "./fieldbus/config";
export { DI_COIL_BASE, DI_HOLDING_BASE } from "./fieldbus/image";
export type { FieldbusAccess, FieldbusImage } from "./fieldbus/image";
export { handleModbusTcp, ModbusTcpServer } from "./fieldbus/modbus";
export { MqttBroker, MqttProcessBridge, applyMqttSet, fieldbusStateTopics, mqttTopicMatch } from "./fieldbus/mqtt";
export { OpcUaServer } from "./fieldbus/opcua";
export { startFieldbusServers } from "./fieldbus/server";
export type { FieldbusListenOptions, FieldbusServerSet } from "./fieldbus/server";
export {
  analyzeSt,
  completeSt,
  definitionSt,
  formatSt,
  hoverSt,
  maskStComments,
  ST_KEYWORD_DETAILS,
  ST_KEYWORDS,
  ST_TYPES,
} from "./st/analyzeSt";
export { compileStToIr, stProgramInterface } from "./st/compileSt";
export type { StAnalysis, StCompletion, StDiagnostic, StLocation, StSymbol } from "./st/analyzeSt";
export type { ResolvedDeviceTree } from "./projectTreeDefaults";
export { validateFbdSource, validateProject } from "./validate";
export {
  buildCodegenIoContext,
  compileProjectDir,
  loadProjectFbdSourcesFromDisk,
  loadProjectIoProfile,
  loadProjectModuleConfigs,
} from "./projectDisk";
export type { CompileProjectDirResult } from "./projectDisk";
