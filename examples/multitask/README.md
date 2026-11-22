# multitask example

Three PLC tasks, each running its own PROGRAM (Task Configuration T1):

| Task | Kind | Priority | Program | What it does |
|------|------|----------|---------|--------------|
| `MainTask` | cyclic, 10 ms | 1 | `Fast` | `DO_Alarm := DI_Stop` — fast reaction to an input |
| `SlowTask` | cyclic, 100 ms | 5 | `Blink` | Blinks `DO_Lamp` (0.5 s off, 0.5 s on); its TONs advance by 100 ms per pass |
| `BackgroundTask` | freewheeling | 20 | `Background` | Counts its own passes in `bg__Passes` |

On the ESP32-S3 each task becomes one FreeRTOS task (`np_main_task`, `np_slow_task`, `np_bg_task`), all on the same core. PLC priority 0 is the highest; a PLC task with a lower number preempts the others.

## Try it

1. Open `examples/multitask` as a workspace.
2. **NanoPLC: Run simulation**. The status line shows passes per task: `main_task` runs 10× as often as `slow_task`, and `bg_task` once per virtual millisecond.
3. **NanoPLC: Compile PLC program** regenerates `firmware/components/nanoplc_generated/` with one task function per PLC task and the `nanoplc_generated_tasks()` table.

GPIO numbers in `src/io-map.json` are placeholders. Adjust them for your board before flashing.
