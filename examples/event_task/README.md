# event_task example

Task Configuration **T2**: a cyclic MainTask plus an **event** task that runs on the rising edge of `DI_Start`.

| Task | Kind | Priority | Program | What it does |
|------|------|----------|---------|--------------|
| `MainTask` | cyclic, 10 ms | 1 | `Main` | `DO_Lamp := DI_Start` |
| `StartTask` | event on `DI_Start` | 0 | `OnStart` | Increments `Hits` and sets `DO_Pulse` on each rising edge |

`StartTask` watchdog uses `on_timeout: outputs_off` (force every DO OFF and latch until reboot). MainTask uses `hold`.

## Try it

1. Open `examples/event_task` as a workspace.
2. **NanoPLC: Run simulation**. Toggle `DI_Start` in the watch list: `ev__Hits` increases only on rising edges.
3. **NanoPLC: Compile PLC program** regenerates the task table with `NANOPLC_TASK_EVENT` and the DI trigger index.

GPIO numbers in `src/io-map.json` are placeholders.
