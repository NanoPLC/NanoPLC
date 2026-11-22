/** Simulator-only virtual plant (Factory I/O lite). Not part of firmware codegen. */

export const PLANT_DEVICE_KINDS = [
  "pushbutton",
  "switch",
  "lamp",
  "transmitter",
  "motor",
  "valve",
  "tank",
  "conveyor",
] as const;

export type PlantDeviceKind = (typeof PLANT_DEVICE_KINDS)[number];

export const TRANSMITTER_PROFILES = ["temperature", "pressure", "adc"] as const;

export type TransmitterProfile = (typeof TRANSMITTER_PROFILES)[number];

/** Engineering defaults written straight into the analog process image. */
export const TRANSMITTER_DEFAULTS: Record<
  TransmitterProfile,
  { min: number; max: number; unit: string; initial: number }
> = {
  temperature: { min: 0, max: 150, unit: "°C", initial: 25 },
  pressure: { min: 0, max: 10, unit: "bar", initial: 0 },
  adc: { min: 0, max: 3.3, unit: "V", initial: 0 },
};

interface PlantDeviceBase {
  id: string;
  name: string;
}

export interface PushbuttonDevice extends PlantDeviceBase {
  kind: "pushbutton";
  /** Process-image DI index. Held only while the operator presses. */
  di: number;
}

export interface SwitchDevice extends PlantDeviceBase {
  kind: "switch";
  /** Process-image DI index. Latched until toggled. */
  di: number;
}

export interface LampDevice extends PlantDeviceBase {
  kind: "lamp";
  /** Process-image DO index the lamp displays. */
  do: number;
}

export interface TransmitterDevice extends PlantDeviceBase {
  kind: "transmitter";
  profile: TransmitterProfile;
  /** Process-image AI index. The value is engineering units, not a raw ADC count. */
  ai: number;
  min: number;
  max: number;
  unit: string;
  /** Value applied at reset. */
  initial: number;
}

export interface MotorDevice extends PlantDeviceBase {
  kind: "motor";
  /** Run command. */
  run_do: number;
  /** Optional "running" feedback. Follows the command after `response_ms`. */
  running_di?: number;
  /** Milliseconds of continuous run command before feedback turns on. 0 = same plant step. */
  response_ms: number;
}

export interface ValveDevice extends PlantDeviceBase {
  kind: "valve";
  /** Open command. */
  open_do: number;
  /** True when the valve has finished travelling open. */
  opened_di?: number;
  /** Full-stroke time, ms. */
  travel_ms: number;
}

export interface TankDevice extends PlantDeviceBase {
  kind: "tank";
  /** Level percent (0..100) written to this AI. */
  level_ai: number;
  inlet_do?: number;
  outlet_do?: number;
  /** Percent of span added per second while the inlet DO is on. */
  fill_per_s: number;
  /** Percent of span removed per second while the outlet DO is on. */
  drain_per_s: number;
  high_di?: number;
  low_di?: number;
  high_pct: number;
  low_pct: number;
  /** Level applied at reset. */
  initial_pct: number;
}

export interface ConveyorDevice extends PlantDeviceBase {
  kind: "conveyor";
  run_do: number;
  /** Photoeye. True while a part is in the end window. */
  sensor_di?: number;
  /** Time for a part to travel from the load point to the sensor, ms. */
  travel_ms: number;
  /** Sensor window width as a fraction of the travel (just past the end). */
  window: number;
}

export type VirtualDevice =
  | PushbuttonDevice
  | SwitchDevice
  | LampDevice
  | TransmitterDevice
  | MotorDevice
  | ValveDevice
  | TankDevice
  | ConveyorDevice;

export interface VirtualPlantConfig {
  devices: VirtualDevice[];
}

/** Live row for the simulator I/O panel. */
export interface PlantDeviceSnapshot {
  id: string;
  name: string;
  kind: PlantDeviceKind;
  status: string;
  /** Pushbutton held or switch on. */
  bool?: boolean;
  /** Transmitter engineering value or tank level percent. */
  number?: number;
  number_min?: number;
  number_max?: number;
  unit?: string;
  /** Conveyor accepts another part at the load point. */
  can_load?: boolean;
  /** Lamp lit, motor running, valve fully open, or conveyor sensor made. */
  active?: boolean;
}

export interface PlantSnapshot {
  devices: PlantDeviceSnapshot[];
}

export interface PlantImage {
  di: boolean[];
  ai: number[];
  do: boolean[];
}

export function plantDeviceSummary(device: VirtualDevice): string {
  switch (device.kind) {
    case "pushbutton":
      return `Pushbutton · DI ${device.di}`;
    case "switch":
      return `Switch · DI ${device.di}`;
    case "lamp":
      return `Lamp · DO ${device.do}`;
    case "transmitter":
      return `${device.profile} · AI ${device.ai} ${device.unit}`;
    case "motor":
      return device.running_di === undefined
        ? `Motor · DO ${device.run_do}`
        : `Motor · DO ${device.run_do} → DI ${device.running_di}`;
    case "valve":
      return device.opened_di === undefined
        ? `Valve · DO ${device.open_do}`
        : `Valve · DO ${device.open_do} → DI ${device.opened_di}`;
    case "tank":
      return `Tank · AI ${device.level_ai}`;
    case "conveyor":
      return device.sensor_di === undefined
        ? `Conveyor · DO ${device.run_do}`
        : `Conveyor · DO ${device.run_do} → DI ${device.sensor_di}`;
  }
}
