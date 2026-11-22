import type { FieldbusAccess, FieldbusImage } from "./image";
import { ModbusTcpServer } from "./modbus";
import { MqttBroker, MqttProcessBridge } from "./mqtt";
import { OpcUaServer } from "./opcua";

export interface FieldbusListenOptions {
  host?: string;
  /** When false, that protocol is not bound. Omitted means start it. */
  modbus?: boolean;
  mqtt?: boolean;
  opcua?: boolean;
  modbusPort?: number;
  mqttPort?: number;
  opcuaPort?: number;
  /** Topic root. State is `{prefix}/di/0`, writes are `{prefix}/di/0/set`. */
  mqttPrefix?: string;
}

export interface FieldbusServerSet {
  modbusPort?: number;
  mqttPort?: number;
  opcuaPort?: number;
  errors: string[];
  publish(image: FieldbusImage): void;
  close(): Promise<void>;
}

/** Localhost Modbus TCP, MQTT 3.1.1, and OPC UA (anonymous, no security). */
export async function startFieldbusServers(
  access: FieldbusAccess,
  options: FieldbusListenOptions = {}
): Promise<FieldbusServerSet> {
  const host = options.host ?? "127.0.0.1";
  const errors: string[] = [];
  const modbus = new ModbusTcpServer(access);
  const mqtt = new MqttBroker();
  const bridge = new MqttProcessBridge(mqtt, options.mqttPrefix ?? "nanoplc", access);
  const opcua = new OpcUaServer(access);
  let modbusPort: number | undefined;
  let mqttPort: number | undefined;
  let opcuaPort: number | undefined;

  if (options.modbus !== false) {
    try {
      modbusPort = await modbus.listen(options.modbusPort ?? 0, host);
    } catch (error) {
      errors.push(`Modbus: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.mqtt !== false) {
    try {
      mqttPort = await mqtt.listen(options.mqttPort ?? 0, host);
    } catch (error) {
      errors.push(`MQTT: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (options.opcua !== false) {
    try {
      opcuaPort = await opcua.listen(options.opcuaPort ?? 0, host);
    } catch (error) {
      errors.push(`OPC UA: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return {
    modbusPort,
    mqttPort,
    opcuaPort,
    errors,
    publish(image: FieldbusImage) {
      bridge.publish(image);
    },
    async close() {
      await Promise.all([modbus.close(), mqtt.close(), opcua.close()]);
    },
  };
}
