import type { CompileDiagnostic } from "../types";
import {
  PLANT_DEVICE_KINDS,
  TRANSMITTER_DEFAULTS,
  TRANSMITTER_PROFILES,
  type PlantDeviceKind,
  type TransmitterProfile,
  type VirtualDevice,
  type VirtualPlantConfig,
} from "./types";

const ID_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

function diag(code: string, message: string): CompileDiagnostic {
  return { code, message, severity: "error" };
}

function isKind(value: unknown): value is PlantDeviceKind {
  return typeof value === "string" && (PLANT_DEVICE_KINDS as readonly string[]).includes(value);
}

function isProfile(value: unknown): value is TransmitterProfile {
  return typeof value === "string" && (TRANSMITTER_PROFILES as readonly string[]).includes(value);
}

function requiredIndex(
  raw: unknown,
  label: string,
  diagnostics: CompileDiagnostic[]
): number | undefined {
  if (typeof raw !== "number" || !Number.isInteger(raw) || raw < 0) {
    diagnostics.push(diag("NP-0132", `${label} must be an integer channel index >= 0.`));
    return undefined;
  }
  return raw;
}

function optionalIndex(
  raw: unknown,
  label: string,
  diagnostics: CompileDiagnostic[]
): number | undefined {
  if (raw === undefined || raw === null) {
    return undefined;
  }
  return requiredIndex(raw, label, diagnostics);
}

function nonNegative(
  raw: unknown,
  label: string,
  fallback: number,
  diagnostics: CompileDiagnostic[]
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 0) {
    diagnostics.push(diag("NP-0132", `${label} must be a number >= 0.`));
    return fallback;
  }
  return raw;
}

function positiveMs(
  raw: unknown,
  label: string,
  fallback: number,
  diagnostics: CompileDiagnostic[]
): number {
  if (raw === undefined) {
    return fallback;
  }
  if (typeof raw !== "number" || !Number.isFinite(raw) || raw < 1) {
    diagnostics.push(diag("NP-0132", `${label} must be a number >= 1.`));
    return fallback;
  }
  return raw;
}

interface SensorClaim {
  key: string;
  id: string;
}

function claim(claims: SensorClaim[], key: string, id: string, diagnostics: CompileDiagnostic[]): void {
  const prev = claims.find((c) => c.key === key);
  if (prev) {
    diagnostics.push(
      diag("NP-0131", `${key.replace(":", " ")} is driven by both "${prev.id}" and "${id}".`)
    );
    return;
  }
  claims.push({ key, id });
}

function parseDevice(
  raw: unknown,
  claims: SensorClaim[],
  ids: Set<string>,
  diagnostics: CompileDiagnostic[]
): VirtualDevice | undefined {
  if (raw == null || typeof raw !== "object") {
    diagnostics.push(diag("NP-0132", "Each virtual device must be an object."));
    return undefined;
  }
  const o = raw as Record<string, unknown>;
  const where = typeof o.id === "string" && o.id ? `"${o.id}"` : "virtual device";
  if (typeof o.id !== "string" || !ID_RE.test(o.id)) {
    diagnostics.push(diag("NP-0132", `${where} id must match ${ID_RE.source}.`));
    return undefined;
  }
  if (ids.has(o.id)) {
    diagnostics.push(diag("NP-0132", `Duplicate virtual device id "${o.id}".`));
  }
  ids.add(o.id);
  if (typeof o.name !== "string" || o.name.trim() === "") {
    diagnostics.push(diag("NP-0132", `Virtual device "${o.id}" name is required.`));
  }
  if (!isKind(o.kind)) {
    diagnostics.push(
      diag("NP-0132", `Virtual device "${o.id}" kind must be ${PLANT_DEVICE_KINDS.join(", ")}.`)
    );
    return undefined;
  }
  const name = typeof o.name === "string" && o.name.trim() !== "" ? o.name.trim() : o.id;
  const id = o.id;

  switch (o.kind) {
    case "pushbutton":
    case "switch": {
      const di = requiredIndex(o.di, `Virtual device "${id}" di`, diagnostics);
      if (di === undefined) {
        return undefined;
      }
      claim(claims, `DI:${di}`, id, diagnostics);
      return { id, name, kind: o.kind, di };
    }
    case "lamp": {
      const dout = requiredIndex(o.do, `Virtual device "${id}" do`, diagnostics);
      if (dout === undefined) {
        return undefined;
      }
      return { id, name, kind: "lamp", do: dout };
    }
    case "transmitter": {
      if (!isProfile(o.profile)) {
        diagnostics.push(
          diag("NP-0133", `Transmitter "${id}" profile must be ${TRANSMITTER_PROFILES.join(", ")}.`)
        );
        return undefined;
      }
      const defaults = TRANSMITTER_DEFAULTS[o.profile];
      const min = typeof o.min === "number" && Number.isFinite(o.min) ? o.min : defaults.min;
      const max = typeof o.max === "number" && Number.isFinite(o.max) ? o.max : defaults.max;
      if (!(max > min)) {
        diagnostics.push(diag("NP-0133", `Transmitter "${id}" max must be greater than min.`));
      }
      const initialRaw = o.initial === undefined ? defaults.initial : o.initial;
      const initial = typeof initialRaw === "number" && Number.isFinite(initialRaw) ? initialRaw : defaults.initial;
      const unit = typeof o.unit === "string" && o.unit.trim() !== "" ? o.unit.trim() : defaults.unit;
      const ai = requiredIndex(o.ai, `Transmitter "${id}" ai`, diagnostics);
      if (ai === undefined) {
        return undefined;
      }
      claim(claims, `AI:${ai}`, id, diagnostics);
      return { id, name, kind: "transmitter", profile: o.profile, ai, min, max, unit, initial };
    }
    case "motor": {
      const run_do = requiredIndex(o.run_do, `Motor "${id}" run_do`, diagnostics);
      const running_di = optionalIndex(o.running_di, `Motor "${id}" running_di`, diagnostics);
      const response_ms = nonNegative(o.response_ms, `Motor "${id}" response_ms`, 0, diagnostics);
      if (run_do === undefined) {
        return undefined;
      }
      if (running_di !== undefined) {
        claim(claims, `DI:${running_di}`, id, diagnostics);
      }
      return { id, name, kind: "motor", run_do, running_di, response_ms };
    }
    case "valve": {
      const open_do = requiredIndex(o.open_do, `Valve "${id}" open_do`, diagnostics);
      const opened_di = optionalIndex(o.opened_di, `Valve "${id}" opened_di`, diagnostics);
      const travel_ms = positiveMs(o.travel_ms, `Valve "${id}" travel_ms`, 1000, diagnostics);
      if (open_do === undefined) {
        return undefined;
      }
      if (opened_di !== undefined) {
        claim(claims, `DI:${opened_di}`, id, diagnostics);
      }
      return { id, name, kind: "valve", open_do, opened_di, travel_ms };
    }
    case "tank": {
      const level_ai = requiredIndex(o.level_ai, `Tank "${id}" level_ai`, diagnostics);
      const inlet_do = optionalIndex(o.inlet_do, `Tank "${id}" inlet_do`, diagnostics);
      const outlet_do = optionalIndex(o.outlet_do, `Tank "${id}" outlet_do`, diagnostics);
      const high_di = optionalIndex(o.high_di, `Tank "${id}" high_di`, diagnostics);
      const low_di = optionalIndex(o.low_di, `Tank "${id}" low_di`, diagnostics);
      const fill_per_s = nonNegative(o.fill_per_s, `Tank "${id}" fill_per_s`, 10, diagnostics);
      const drain_per_s = nonNegative(o.drain_per_s, `Tank "${id}" drain_per_s`, 10, diagnostics);
      const high_pct = nonNegative(o.high_pct, `Tank "${id}" high_pct`, 80, diagnostics);
      const low_pct = nonNegative(o.low_pct, `Tank "${id}" low_pct`, 20, diagnostics);
      const initial_pct = nonNegative(o.initial_pct, `Tank "${id}" initial_pct`, 0, diagnostics);
      if (low_pct > high_pct) {
        diagnostics.push(diag("NP-0132", `Tank "${id}" low_pct must be <= high_pct.`));
      }
      if (level_ai === undefined) {
        return undefined;
      }
      claim(claims, `AI:${level_ai}`, id, diagnostics);
      if (high_di !== undefined) {
        claim(claims, `DI:${high_di}`, id, diagnostics);
      }
      if (low_di !== undefined) {
        claim(claims, `DI:${low_di}`, id, diagnostics);
      }
      return {
        id,
        name,
        kind: "tank",
        level_ai,
        inlet_do,
        outlet_do,
        fill_per_s,
        drain_per_s,
        high_di,
        low_di,
        high_pct,
        low_pct,
        initial_pct,
      };
    }
    case "conveyor": {
      const run_do = requiredIndex(o.run_do, `Conveyor "${id}" run_do`, diagnostics);
      const sensor_di = optionalIndex(o.sensor_di, `Conveyor "${id}" sensor_di`, diagnostics);
      const travel_ms = positiveMs(o.travel_ms, `Conveyor "${id}" travel_ms`, 2000, diagnostics);
      let window = 0.05;
      if (o.window !== undefined) {
        if (typeof o.window !== "number" || !(o.window > 0) || o.window > 1) {
          diagnostics.push(diag("NP-0132", `Conveyor "${id}" window must be a fraction in (0, 1].`));
        } else {
          window = o.window;
        }
      }
      if (run_do === undefined) {
        return undefined;
      }
      if (sensor_di !== undefined) {
        claim(claims, `DI:${sensor_di}`, id, diagnostics);
      }
      return { id, name, kind: "conveyor", run_do, sensor_di, travel_ms, window };
    }
  }
}

/**
 * Normalize `nanoplc.project.json` → `virtual_plant`.
 * `undefined` means the project has no plant. Structural problems are `NP-0130`…`NP-0133`.
 */
export function parseVirtualPlant(raw: unknown): {
  config?: VirtualPlantConfig;
  diagnostics: CompileDiagnostic[];
} {
  if (raw === undefined) {
    return { diagnostics: [] };
  }
  const diagnostics: CompileDiagnostic[] = [];
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { diagnostics: [diag("NP-0130", "virtual_plant must be an object with a devices array.")] };
  }
  const devicesRaw = (raw as { devices?: unknown }).devices;
  if (!Array.isArray(devicesRaw)) {
    return { diagnostics: [diag("NP-0130", "virtual_plant.devices must be an array.")] };
  }
  const claims: SensorClaim[] = [];
  const ids = new Set<string>();
  const devices: VirtualDevice[] = [];
  for (const item of devicesRaw) {
    const device = parseDevice(item, claims, ids, diagnostics);
    if (device) {
      devices.push(device);
    }
  }
  if (diagnostics.length > 0) {
    return { diagnostics };
  }
  return { config: { devices }, diagnostics };
}

const ID_PREFIX: Record<PlantDeviceKind, string> = {
  pushbutton: "pb",
  switch: "sw",
  lamp: "lamp",
  transmitter: "tx",
  motor: "motor",
  valve: "valve",
  tank: "tank",
  conveyor: "conv",
};

export function nextPlantDeviceId(kind: PlantDeviceKind, devices: { id: string }[]): string {
  const prefix = ID_PREFIX[kind];
  const taken = new Set(devices.map((d) => d.id));
  let n = 1;
  while (taken.has(`${prefix}${n}`)) {
    n += 1;
  }
  return `${prefix}${n}`;
}
