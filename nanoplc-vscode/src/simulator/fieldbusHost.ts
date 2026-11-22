import * as vscode from "vscode";

import {
  resolveFieldbus,
  startFieldbusServers,
  type FieldbusAccess,
  type FieldbusImage,
  type FieldbusServerSet,
  type NanoPlcProject,
} from "@nanoplc/ir-schema";

let active: FieldbusServerSet | undefined;

function defaultsFromSettings(): {
  enabled: boolean;
  modbusPort: number;
  mqttPort: number;
  opcuaPort: number;
  mqttPrefix: string;
} {
  const cfg = vscode.workspace.getConfiguration("nanoplc");
  return {
    enabled: cfg.get<boolean>("fieldbus.enabled", true),
    modbusPort: cfg.get<number>("fieldbus.modbusPort", 5502),
    mqttPort: cfg.get<number>("fieldbus.mqttPort", 5883),
    opcuaPort: cfg.get<number>("fieldbus.opcuaPort", 54840),
    mqttPrefix: cfg.get<string>("fieldbus.mqttPrefix", "nanoplc"),
  };
}

/** Bind localhost fieldbus servers for the running simulation. */
export async function startSimFieldbus(project: NanoPlcProject, access: FieldbusAccess): Promise<string> {
  await stopSimFieldbus();
  const resolved = resolveFieldbus(project.communication, defaultsFromSettings());
  if (!resolved.modbus && !resolved.mqtt && !resolved.opcua) {
    return "";
  }
  active = await startFieldbusServers(access, {
    modbus: resolved.modbus,
    mqtt: resolved.mqtt,
    opcua: resolved.opcua,
    modbusPort: resolved.modbusPort,
    mqttPort: resolved.mqttPort,
    opcuaPort: resolved.opcuaPort,
    mqttPrefix: resolved.mqttPrefix,
  });
  const parts: string[] = [];
  if (active.modbusPort) {
    parts.push(`Modbus TCP 127.0.0.1:${active.modbusPort}`);
  }
  if (active.mqttPort) {
    parts.push(`MQTT 127.0.0.1:${active.mqttPort} (${resolved.mqttPrefix}/#)`);
  }
  if (active.opcuaPort) {
    parts.push(`OPC UA opc.tcp://127.0.0.1:${active.opcuaPort}`);
  }
  if (active.errors.length > 0) {
    void vscode.window.showWarningMessage(`NanoPLC fieldbus: ${active.errors.join(" ")}`);
  }
  return parts.join(" · ");
}

export function publishSimFieldbus(image: FieldbusImage): void {
  active?.publish(image);
}

export async function stopSimFieldbus(): Promise<void> {
  const current = active;
  active = undefined;
  await current?.close();
}
