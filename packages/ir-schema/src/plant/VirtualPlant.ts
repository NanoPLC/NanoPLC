import type {
  PlantDeviceSnapshot,
  PlantImage,
  PlantSnapshot,
  VirtualDevice,
  VirtualPlantConfig,
} from "./types";

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, n));
}

function writeDi(io: PlantImage, index: number, value: boolean): void {
  if (index >= 0 && index < io.di.length) {
    io.di[index] = value;
  }
}

function writeAi(io: PlantImage, index: number, value: number): void {
  if (index >= 0 && index < io.ai.length) {
    io.ai[index] = value;
  }
}

function readDo(io: PlantImage, index: number): boolean {
  return index >= 0 && index < io.do.length && io.do[index] === true;
}

/**
 * Process-image plant. Call `integrate` with the elapsed virtual time since the
 * previous call **before** the PLC pass that samples inputs. Actuator physics
 * uses the DO image left by the previous pass, so feedback lags by one pass
 * even when `response_ms` is 0.
 */
export class VirtualPlant {
  private readonly devices: VirtualDevice[];
  private pressed = new Map<string, boolean>();
  private switched = new Map<string, boolean>();
  private transmitter = new Map<string, number>();
  private motorAcc = new Map<string, number>();
  private motorRunning = new Map<string, boolean>();
  private valvePos = new Map<string, number>();
  private tankLevel = new Map<string, number>();
  /** Part positions along the belt, 0 = load point, 1 = sensor. */
  private parts = new Map<string, number[]>();

  constructor(config: VirtualPlantConfig) {
    this.devices = config.devices;
    this.reset();
  }

  reset(): void {
    this.pressed.clear();
    this.switched.clear();
    this.transmitter.clear();
    this.motorAcc.clear();
    this.motorRunning.clear();
    this.valvePos.clear();
    this.tankLevel.clear();
    this.parts.clear();
    for (const device of this.devices) {
      if (device.kind === "transmitter") {
        this.transmitter.set(device.id, clamp(device.initial, device.min, device.max));
      }
      if (device.kind === "tank") {
        this.tankLevel.set(device.id, clamp(device.initial_pct, 0, 100));
      }
      if (device.kind === "valve") {
        this.valvePos.set(device.id, 0);
      }
    }
  }

  /**
   * Operator gesture. `boolean` holds a pushbutton or sets a switch.
   * `number` sets a transmitter or a tank level (percent).
   * `"load"` places a part on a conveyor.
   * Sensor outputs are published immediately so the panel matches the image.
   */
  setControl(id: string, value: boolean | number | "load", io: PlantImage): void {
    const device = this.devices.find((d) => d.id === id);
    if (!device) {
      return;
    }
    if (device.kind === "pushbutton" && typeof value === "boolean") {
      this.pressed.set(id, value);
    } else if (device.kind === "switch" && typeof value === "boolean") {
      this.switched.set(id, value);
    } else if (device.kind === "transmitter" && typeof value === "number" && Number.isFinite(value)) {
      this.transmitter.set(id, clamp(value, device.min, device.max));
    } else if (device.kind === "tank" && typeof value === "number" && Number.isFinite(value)) {
      this.tankLevel.set(id, clamp(value, 0, 100));
    } else if (device.kind === "conveyor" && value === "load") {
      this.loadPart(device.id, device.window);
    }
    this.integrate(io, 0);
  }

  private loadPart(id: string, window: number): void {
    const list = this.parts.get(id) ?? [];
    if (list.some((p) => p < window)) {
      return;
    }
    list.push(0);
    this.parts.set(id, list);
  }

  /** Advance actuator physics by `dtMs` and write every sensor this plant owns. */
  integrate(io: PlantImage, dtMs: number): void {
    const dt = Math.max(0, dtMs);
    const sec = dt / 1000;
    for (const device of this.devices) {
      switch (device.kind) {
        case "pushbutton":
          writeDi(io, device.di, this.pressed.get(device.id) === true);
          break;
        case "switch":
          writeDi(io, device.di, this.switched.get(device.id) === true);
          break;
        case "lamp":
          break;
        case "transmitter":
          writeAi(
            io,
            device.ai,
            clamp(this.transmitter.get(device.id) ?? device.initial, device.min, device.max)
          );
          break;
        case "motor": {
          const run = readDo(io, device.run_do);
          const acc = run ? (this.motorAcc.get(device.id) ?? 0) + dt : 0;
          this.motorAcc.set(device.id, acc);
          const running = run && acc >= device.response_ms;
          this.motorRunning.set(device.id, running);
          if (device.running_di !== undefined) {
            writeDi(io, device.running_di, running);
          }
          break;
        }
        case "valve": {
          const open = readDo(io, device.open_do);
          let pos = this.valvePos.get(device.id) ?? 0;
          pos = clamp(pos + (open ? dt : -dt) / device.travel_ms, 0, 1);
          this.valvePos.set(device.id, pos);
          if (device.opened_di !== undefined) {
            writeDi(io, device.opened_di, pos >= 1);
          }
          break;
        }
        case "tank": {
          let level = this.tankLevel.get(device.id) ?? device.initial_pct;
          if (device.inlet_do !== undefined && readDo(io, device.inlet_do)) {
            level += device.fill_per_s * sec;
          }
          if (device.outlet_do !== undefined && readDo(io, device.outlet_do)) {
            level -= device.drain_per_s * sec;
          }
          level = clamp(level, 0, 100);
          this.tankLevel.set(device.id, level);
          writeAi(io, device.level_ai, level);
          if (device.high_di !== undefined) {
            writeDi(io, device.high_di, level >= device.high_pct);
          }
          if (device.low_di !== undefined) {
            writeDi(io, device.low_di, level <= device.low_pct);
          }
          break;
        }
        case "conveyor": {
          const run = readDo(io, device.run_do);
          let list = this.parts.get(device.id) ?? [];
          if (run && dt > 0) {
            const delta = dt / device.travel_ms;
            const end = 1 + device.window;
            list = list.map((p) => p + delta).filter((p) => p <= end);
          }
          this.parts.set(device.id, list);
          const sensing = list.some((p) => p >= 1 && p <= 1 + device.window);
          if (device.sensor_di !== undefined) {
            writeDi(io, device.sensor_di, sensing);
          }
          break;
        }
      }
    }
  }

  snapshot(io: PlantImage): PlantSnapshot {
    const devices: PlantDeviceSnapshot[] = this.devices.map((device) => this.deviceSnapshot(device, io));
    return { devices };
  }

  private deviceSnapshot(device: VirtualDevice, io: PlantImage): PlantDeviceSnapshot {
    const base = { id: device.id, name: device.name, kind: device.kind };
    switch (device.kind) {
      case "pushbutton": {
        const held = this.pressed.get(device.id) === true;
        return { ...base, bool: held, status: held ? "Pressed" : "Released" };
      }
      case "switch": {
        const on = this.switched.get(device.id) === true;
        return { ...base, bool: on, active: on, status: on ? "On" : "Off" };
      }
      case "lamp": {
        const lit = readDo(io, device.do);
        return { ...base, active: lit, status: lit ? "On" : "Off" };
      }
      case "transmitter": {
        const value = clamp(this.transmitter.get(device.id) ?? device.initial, device.min, device.max);
        return {
          ...base,
          number: value,
          number_min: device.min,
          number_max: device.max,
          unit: device.unit,
          status: `${value} ${device.unit}`,
        };
      }
      case "motor": {
        const running = this.motorRunning.get(device.id) === true;
        const commanded = readDo(io, device.run_do);
        const status = running ? "Running" : commanded ? "Starting" : "Stopped";
        return { ...base, active: running, status };
      }
      case "valve": {
        const pos = this.valvePos.get(device.id) ?? 0;
        const pct = Math.round(pos * 100);
        return { ...base, active: pos >= 1, number: pct, status: `${pct}%` };
      }
      case "tank": {
        const level = this.tankLevel.get(device.id) ?? device.initial_pct;
        return {
          ...base,
          number: level,
          number_min: 0,
          number_max: 100,
          unit: "%",
          status: `${level.toFixed(1)}%`,
        };
      }
      case "conveyor": {
        const list = this.parts.get(device.id) ?? [];
        const sensing = list.some((p) => p >= 1 && p <= 1 + device.window);
        const canLoad = !list.some((p) => p < device.window);
        const status = sensing ? "Sensor" : list.length > 0 ? `${list.length} part(s)` : "Empty";
        return { ...base, active: sensing, can_load: canLoad, status };
      }
    }
  }
}
