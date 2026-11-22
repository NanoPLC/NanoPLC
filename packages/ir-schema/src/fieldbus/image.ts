/** Process image a virtual fieldbus reads and writes. Simulator only. */

export interface FieldbusImage {
  di: boolean[];
  do: boolean[];
  ai: number[];
}

export interface FieldbusAccess {
  read(): FieldbusImage;
  writeDi(index: number, value: boolean): void;
  writeDo(index: number, value: boolean): void;
  writeAi(index: number, value: number): void;
}

/**
 * Coil / register map shared by Modbus (and documented for MQTT / OPC UA).
 * DI writes use a high base so they do not collide with DO coils or AI registers.
 */
export const DI_COIL_BASE = 1000;
export const DI_HOLDING_BASE = 1000;

export type CoilBank = { kind: "di" | "do"; index: number };

export function resolveCoil(address: number, image: FieldbusImage): CoilBank | undefined {
  if (address >= 0 && address < image.do.length) {
    return { kind: "do", index: address };
  }
  if (address >= DI_COIL_BASE && address < DI_COIL_BASE + image.di.length) {
    return { kind: "di", index: address - DI_COIL_BASE };
  }
  return undefined;
}

export function resolveDiscrete(address: number, image: FieldbusImage): number | undefined {
  if (address >= 0 && address < image.di.length) {
    return address;
  }
  return undefined;
}

/** Input register or holding register 0..ai.length-1. */
export function resolveAnalog(address: number, image: FieldbusImage): number | undefined {
  if (address >= 0 && address < image.ai.length) {
    return address;
  }
  return undefined;
}

/** Holding register that writes a DI as 0/1. */
export function resolveDiHolding(address: number, image: FieldbusImage): number | undefined {
  if (address >= DI_HOLDING_BASE && address < DI_HOLDING_BASE + image.di.length) {
    return address - DI_HOLDING_BASE;
  }
  return undefined;
}

export function analogToRegister(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  const rounded = Math.round(value);
  if (rounded > 32767) {
    return 32767;
  }
  if (rounded < -32768) {
    return -32768;
  }
  return rounded;
}

export function registerToAnalog(word: number): number {
  return word > 32767 ? word - 65536 : word;
}
