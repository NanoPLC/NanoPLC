/** Simulator-only fieldbus endpoint. `enabled: false` keeps that protocol off. */
export interface NanoPlcFieldbusEndpoint {
  enabled?: boolean;
  port?: number;
  /** MQTT topic root. Ignored by Modbus and OPC UA. */
  prefix?: string;
}

export interface NanoPlcCommunication {
  modbus?: NanoPlcFieldbusEndpoint;
  mqtt?: NanoPlcFieldbusEndpoint;
  opcua?: NanoPlcFieldbusEndpoint;
}

export interface ResolvedFieldbus {
  modbus: boolean;
  mqtt: boolean;
  opcua: boolean;
  modbusPort: number;
  mqttPort: number;
  opcuaPort: number;
  mqttPrefix: string;
}

export const DEFAULT_MODBUS_PORT = 5502;
export const DEFAULT_MQTT_PORT = 5883;
export const DEFAULT_OPCUA_PORT = 54840;
export const DEFAULT_MQTT_PREFIX = "nanoplc";

function endpointEnabled(endpoint: NanoPlcFieldbusEndpoint | undefined, fallback: boolean): boolean {
  if (endpoint?.enabled === false) {
    return false;
  }
  if (endpoint?.enabled === true) {
    return true;
  }
  return fallback;
}

function endpointPort(endpoint: NanoPlcFieldbusEndpoint | undefined, fallback: number): number {
  const port = endpoint?.port;
  if (typeof port === "number" && Number.isInteger(port) && port >= 0 && port <= 65535) {
    return port;
  }
  return fallback;
}

/** Merge project `communication` over IDE defaults. */
export function resolveFieldbus(
  communication: NanoPlcCommunication | undefined,
  defaults: { enabled: boolean; modbusPort: number; mqttPort: number; opcuaPort: number; mqttPrefix: string }
): ResolvedFieldbus {
  return {
    modbus: endpointEnabled(communication?.modbus, defaults.enabled),
    mqtt: endpointEnabled(communication?.mqtt, defaults.enabled),
    opcua: endpointEnabled(communication?.opcua, defaults.enabled),
    modbusPort: endpointPort(communication?.modbus, defaults.modbusPort),
    mqttPort: endpointPort(communication?.mqtt, defaults.mqttPort),
    opcuaPort: endpointPort(communication?.opcua, defaults.opcuaPort),
    mqttPrefix:
      typeof communication?.mqtt?.prefix === "string" && communication.mqtt.prefix.trim() !== ""
        ? communication.mqtt.prefix.trim()
        : defaults.mqttPrefix,
  };
}
