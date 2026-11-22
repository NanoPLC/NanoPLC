# blink_fbd example

FBD program that blinks one lamp: 0.5 s off, 0.5 s on, at a 10 ms MainTask.

It shows how to build feedback without a combinational loop (`NP-0400`). The lamp state is stored in the PROGRAM variable `LampOn` (VAR). It is read at the start of the pass and written at the end, so the next pass sees it.

| Block | Role |
|-------|------|
| `lamp_state` (LOCAL `LampOn`, read) | Lamp state from the previous pass |
| `not1` → `ton_off` (TON 500 ms) | Lamp has been off for 500 ms → `SET` |
| `ton_on` (TON 500 ms) | Lamp has been on for 500 ms → `RESET1` |
| `rs1` (RS) | Lamp state for this pass |
| `lamp_store` (LOCAL `LampOn`, write), `do_lamp` (DO_Lamp) | Store the state and drive the output |

## Try it

1. Open `examples/blink_fbd` as a workspace and open `src/main.fbd.json` in the FBD editor.
2. **NanoPLC: Run simulation**, add `DO_Lamp` to the watch list, and watch it toggle every 0.5 s.
3. **NanoPLC: Compile PLC program** to regenerate `firmware/components/nanoplc_generated/`.

GPIO 2 in `src/io-map.json` is a placeholder. Adjust it for your board before flashing.

The golden scenario `packages/ir-schema/golden/blink_fbd.golden.json` checks the exact scan on which the lamp switches, both in the simulator and in the generated C.
