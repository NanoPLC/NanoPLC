# Virtual fieldbuses (simulator)

While **Run simulation** is active, NanoPLC can expose the process image on localhost so a SCADA client can be tested without hardware. Nothing in this document is compiled into ESP-IDF firmware.

Defaults (override with `nanoplc.fieldbus.*` or `nanoplc.project.json` → `communication`):

| Protocol | Default | Security |
|----------|---------|----------|
| Modbus TCP | `127.0.0.1:5502` | localhost only |
| MQTT 3.1.1 (QoS 0) | `127.0.0.1:5883` | localhost only, no auth |
| OPC UA TCP | `opc.tcp://127.0.0.1:54840` | anonymous, SecurityPolicy None |

Set `communication.modbus.enabled` (or `mqtt` / `opcua`) to `false` to skip that listener. `nanoplc.fieldbus.enabled` = false skips all three unless a project endpoint sets `enabled: true`.

## Modbus map

| Table | Addresses | Process image |
|-------|-----------|----------------|
| Coils (FC 01, 05, 0F) | `0 … DO count-1` | DO |
| Coils | `1000 …` | DI (so a master can write inputs) |
| Discrete inputs (FC 02) | `0 …` | DI, read-only |
| Input registers (FC 04) | `0 …` | AI as int16 |
| Holding registers (FC 03, 06, 10) | `0 …` | AI as int16 |
| Holding registers | `1000 …` | DI as 0/1 |

Analog values are rounded and clamped to int16. The PLC program overwrites DO on the next scan when it writes that coil. A virtual-plant device that owns a DI overwrites that input on the next plant step.

## MQTT

Prefix default `nanoplc`.

| Topic | Direction |
|-------|-----------|
| `{prefix}/di/{i}` | retained state, `0` or `1` |
| `{prefix}/do/{i}` | retained state |
| `{prefix}/ai/{i}` | retained state, decimal |
| `{prefix}/di/{i}/set` | write a DI |
| `{prefix}/do/{i}/set` | write a DO |
| `{prefix}/ai/{i}/set` | write an AI |

Subscribe to `nanoplc/#`.

## OPC UA

Subset: Hello, OpenSecureChannel (None), GetEndpoints, FindServers, CreateSession, ActivateSession (anonymous), Read, Write, Browse, CloseSession.

Variables live under `Objects`:

| NodeId | Type |
|--------|------|
| `ns=1;s=DI0` | Boolean |
| `ns=1;s=DO0` | Boolean |
| `ns=1;s=AI0` | Float |

Attribute `Value` (13) is read/write. Browse `Objects` (ns=0;i=85) lists the variables that exist in the current image.
