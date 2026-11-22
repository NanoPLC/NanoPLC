(function () {
  const vscode = acquireVsCodeApi();

  /** @type {{ di: any[], do: any[], ai: any[], modules: any[], source: string }} */
  let ioProfile = { di: [], do: [], ai: [], modules: [], source: "none" };
  /** @type {Array<{id:string,name:string,language:string,variables:Array<{name:string,class:string,type:string}>}>} */
  let programs = [];
  /** @type {Array<any>} */
  let watches = [];
  /** @type {{ scan_index: number, elapsed_ms: number, task_passes?: Record<string, number>, vars: Record<string, boolean|number>, di: boolean[], ai: number[], do: boolean[] }} */
  let snap = { scan_index: 0, elapsed_ms: 0, task_passes: {}, vars: {}, di: [], ai: [], do: [] };
  let scanPeriodMs = 10;
  /** @type {{ devices: Array<Record<string, unknown>> }} */
  let plantConfig = { devices: [] };

  const el = {
    meta: document.getElementById("meta"),
    ioKind: document.getElementById("io-kind"),
    ioModule: document.getElementById("io-module"),
    ioChannel: document.getElementById("io-channel"),
    ioHint: document.getElementById("io-hint"),
    btnAddIo: document.getElementById("btn-add-io"),
    varProgram: document.getElementById("var-program"),
    varName: document.getElementById("var-name"),
    varHint: document.getElementById("var-hint"),
    btnAddVar: document.getElementById("btn-add-var"),
    ioBody: document.getElementById("io-body"),
    varBody: document.getElementById("var-body"),
    plantList: document.getElementById("plant-list"),
    plantKind: document.getElementById("plant-kind"),
    plantName: document.getElementById("plant-name"),
    plantFields: document.getElementById("plant-fields"),
    plantHint: document.getElementById("plant-hint"),
    btnAddPlant: document.getElementById("btn-add-plant"),
  };

  function ioKey(kind) {
    return String(kind || "DI").toLowerCase();
  }

  function ioModulesForKind(kind) {
    const key = ioKey(kind);
    if (ioProfile.modules?.length) {
      return ioProfile.modules
        .map((mod) => ({ id: mod.id, name: mod.name, channels: mod[key] || [] }))
        .filter((mod) => mod.channels.length > 0);
    }
    const flat = ioProfile[key] || [];
    if (flat.length === 0) {
      return [];
    }
    return [{ id: "device", name: "Device", channels: flat }];
  }

  function channelLabel(entry) {
    return `${entry.channel} — ${entry.symbol}`;
  }

  function findIoEntry(ioKind, moduleId, channel) {
    const mod = ioModulesForKind(ioKind).find((m) => m.id === moduleId);
    const entry = mod?.channels.find((c) => c.channel === channel);
    return mod && entry ? { module: mod, entry } : undefined;
  }

  function findProgram(id) {
    return programs.find((p) => p.id === id);
  }

  function findVariable(programId, name) {
    const prog = findProgram(programId);
    return (prog?.variables || []).find((v) => v.name === name);
  }

  function ioWatchTaken(ioKind, moduleId, channel) {
    return watches.some(
      (w) => w.kind === "io" && w.ioKind === ioKind && w.moduleId === moduleId && w.channel === channel
    );
  }

  function varWatchTaken(programId, name) {
    return watches.some((w) => w.kind === "var" && w.programId === programId && w.name === name);
  }

  function fillSelect(select, items, placeholder) {
    const previous = select.value;
    select.innerHTML = "";
    const empty = document.createElement("option");
    empty.value = "";
    empty.textContent = placeholder;
    select.appendChild(empty);
    for (const item of items) {
      const opt = document.createElement("option");
      opt.value = item.value;
      opt.textContent = item.label;
      opt.disabled = Boolean(item.disabled);
      select.appendChild(opt);
    }
    if (items.some((i) => i.value === previous && !i.disabled)) {
      select.value = previous;
    }
  }

  function refreshIoSelectors() {
    const kind = el.ioKind.value;
    const modules = ioModulesForKind(kind);
    fillSelect(
      el.ioModule,
      modules.map((m) => ({ value: m.id, label: m.name })),
      modules.length ? "Select module…" : "No modules"
    );
    el.ioModule.disabled = modules.length === 0;
    refreshIoChannels();
  }

  function refreshIoChannels() {
    const kind = el.ioKind.value;
    const modules = ioModulesForKind(kind);
    const mod = modules.find((m) => m.id === el.ioModule.value);
    if (!mod) {
      fillSelect(el.ioChannel, [], "Select channel…");
      el.ioChannel.disabled = true;
      el.btnAddIo.disabled = true;
      el.ioHint.textContent =
        ioProfile.source === "none"
          ? "Open a NanoPLC project with a device catalog or io-map.json to list channels."
          : "Select a module.";
      return;
    }
    const items = mod.channels.map((entry) => ({
      value: String(entry.channel),
      label: channelLabel(entry),
      disabled: ioWatchTaken(kind, mod.id, entry.channel),
    }));
    fillSelect(el.ioChannel, items, "Select channel…");
    el.ioChannel.disabled = items.length === 0;
    el.btnAddIo.disabled = !el.ioChannel.value;
    const available = items.filter((i) => !i.disabled).length;
    if (items.length === 0) {
      el.ioHint.textContent = "This module has no channels of that type.";
    } else if (available === 0) {
      el.ioHint.textContent = "All channels of this type are already watched.";
    } else {
      el.ioHint.textContent = "";
    }
  }

  function refreshVarSelectors() {
    const withVars = programs.filter((p) => (p.variables || []).length > 0);
    fillSelect(
      el.varProgram,
      withVars.map((p) => ({ value: p.id, label: p.name })),
      withVars.length ? "Select program…" : "No program variables"
    );
    el.varProgram.disabled = withVars.length === 0;
    refreshVarNames();
  }

  function refreshVarNames() {
    const prog = findProgram(el.varProgram.value);
    const vars = prog?.variables || [];
    const items = vars.map((v) => ({
      value: v.name,
      label: `${v.name} (${v.class} · ${v.type})`,
      disabled: varWatchTaken(prog.id, v.name),
    }));
    fillSelect(el.varName, items, vars.length ? "Select variable…" : "No variables");
    el.varName.disabled = items.length === 0;
    el.btnAddVar.disabled = !el.varName.value;
    if (!prog) {
      el.varHint.textContent = withVarsHint();
      return;
    }
    const available = items.filter((i) => !i.disabled).length;
    if (vars.length === 0) {
      el.varHint.textContent = "This program has no IN, IN_OUT, OUT, VAR, or TEMP declarations.";
    } else if (available === 0) {
      el.varHint.textContent = "All variables in this program are already watched.";
    } else {
      el.varHint.textContent = "";
    }
  }

  function withVarsHint() {
    return programs.some((p) => (p.variables || []).length > 0)
      ? "Select a program."
      : "Declare IN, IN_OUT, OUT, VAR, or TEMP on an FBD program to watch them here.";
  }

  function formatBool(value) {
    return value ? "TRUE" : "FALSE";
  }

  /** Shortest decimal that round-trips to the same float32 (REAL is float on the MCU). */
  function formatNumber(value, type) {
    const n = Number(value);
    if (type !== "REAL" || !Number.isFinite(n)) {
      return String(value);
    }
    for (let p = 1; p <= 9; p++) {
      const s = Number(n.toPrecision(p));
      if (Math.fround(s) === n) {
        return String(s);
      }
    }
    return String(n);
  }

  function ioValue(watch) {
    const found = findIoEntry(watch.ioKind, watch.moduleId, watch.channel);
    const index = found?.entry.index ?? -1;
    if (watch.ioKind === "AI") {
      return snap.ai[index] ?? 0;
    }
    if (watch.ioKind === "DO") {
      return snap.do[index] ?? false;
    }
    return snap.di[index] ?? false;
  }

  function varIrName(programId, name) {
    return `${programId}__${name}`;
  }

  function varValue(watch) {
    const v = findVariable(watch.programId, watch.name);
    const raw = snap.vars[varIrName(watch.programId, watch.name)];
    if (v?.type === "BOOL") {
      return raw === true || raw === 1;
    }
    return typeof raw === "number" ? raw : 0;
  }

  function emptyRow(colspan, text) {
    const tr = document.createElement("tr");
    const td = document.createElement("td");
    td.colSpan = colspan;
    td.className = "empty";
    td.textContent = text;
    tr.appendChild(td);
    return tr;
  }

  function removeButton(id) {
    const btn = document.createElement("button");
    btn.className = "remove";
    btn.type = "button";
    btn.textContent = "Remove";
    btn.addEventListener("click", () => vscode.postMessage({ type: "removeWatch", id }));
    return btn;
  }

  function renderIoTable() {
    const rows = watches.filter((w) => w.kind === "io");
    el.ioBody.innerHTML = "";
    if (rows.length === 0) {
      el.ioBody.appendChild(emptyRow(4, "No I/O watched. Add a module channel above."));
      return;
    }
    for (const watch of rows) {
      const found = findIoEntry(watch.ioKind, watch.moduleId, watch.channel);
      const tr = document.createElement("tr");
      tr.dataset.id = watch.id;
      const kind = document.createElement("td");
      kind.textContent = watch.ioKind;
      const loc = document.createElement("td");
      loc.textContent = found
        ? `${found.module.name} · ${channelLabel(found.entry)}`
        : `${watch.moduleId} · ${watch.channel}`;
      const value = document.createElement("td");
      value.className = "value-cell";
      fillIoValueCell(value, watch, found);
      const remove = document.createElement("td");
      remove.appendChild(removeButton(watch.id));
      tr.appendChild(kind);
      tr.appendChild(loc);
      tr.appendChild(value);
      tr.appendChild(remove);
      el.ioBody.appendChild(tr);
    }
  }

  function fillIoValueCell(cell, watch, found) {
    cell.innerHTML = "";
    const index = found?.entry.index;
    const value = ioValue(watch);
    if (watch.ioKind === "DO") {
      cell.className = `value-cell ${value ? "on" : "off"}`;
      cell.textContent = formatBool(Boolean(value));
      return;
    }
    cell.className = "value-cell";
    if (watch.ioKind === "AI") {
      const input = document.createElement("input");
      input.className = "ai-value";
      input.type = "number";
      input.step = "any";
      input.value = String(value);
      const owned = ownedIo().ai.has(index);
      input.disabled = typeof index !== "number" || owned;
      input.title = owned ? "Driven by the virtual plant" : "";
      input.addEventListener("change", () => {
        vscode.postMessage({
          type: "setAi",
          index,
          value: Number(input.value),
        });
      });
      cell.appendChild(input);
      return;
    }
    const btn = document.createElement("button");
    btn.className = "di-toggle";
    btn.type = "button";
    btn.textContent = formatBool(Boolean(value));
    const owned = ownedIo().di.has(index);
    btn.disabled = typeof index !== "number" || owned;
    btn.title = owned ? "Driven by the virtual plant" : "";
    btn.addEventListener("click", () => {
      btn.textContent = formatBool(btn.textContent !== "TRUE");
      vscode.postMessage({ type: "toggleDi", index });
    });
    cell.appendChild(btn);
  }

  function renderVarTable() {
    const rows = watches.filter((w) => w.kind === "var");
    el.varBody.innerHTML = "";
    if (rows.length === 0) {
      el.varBody.appendChild(emptyRow(5, "No variables watched. Add a program variable above."));
      return;
    }
    for (const watch of rows) {
      const prog = findProgram(watch.programId);
      const variable = findVariable(watch.programId, watch.name);
      const tr = document.createElement("tr");
      tr.dataset.id = watch.id;
      const cls = document.createElement("td");
      cls.textContent = variable?.class ?? "";
      const loc = document.createElement("td");
      loc.textContent = `${prog?.name ?? watch.programId}.${watch.name}`;
      const type = document.createElement("td");
      type.className = "kind-tag";
      type.textContent = variable?.type ?? "";
      const value = document.createElement("td");
      value.className = "value-cell";
      fillVarValueCell(value, watch, variable);
      const remove = document.createElement("td");
      remove.appendChild(removeButton(watch.id));
      tr.appendChild(cls);
      tr.appendChild(loc);
      tr.appendChild(type);
      tr.appendChild(value);
      tr.appendChild(remove);
      el.varBody.appendChild(tr);
    }
  }

  function fillVarValueCell(cell, watch, variable) {
    cell.innerHTML = "";
    const type = variable?.type ?? "BOOL";
    const value = varValue(watch);
    if (type === "BOOL") {
      const btn = document.createElement("button");
      btn.className = "di-toggle";
      btn.type = "button";
      btn.textContent = formatBool(Boolean(value));
      btn.addEventListener("click", () => {
        const next = btn.textContent !== "TRUE";
        btn.textContent = formatBool(next);
        vscode.postMessage({
          type: "setVar",
          programId: watch.programId,
          name: watch.name,
          value: next,
        });
      });
      cell.appendChild(btn);
      return;
    }
    const input = document.createElement("input");
    input.className = "var-value";
    input.type = "number";
    input.step = type === "REAL" ? "any" : "1";
    input.value = formatNumber(value, type);
    input.addEventListener("change", () => {
      const n = Number(input.value);
      vscode.postMessage({
        type: "setVar",
        programId: watch.programId,
        name: watch.name,
        value: Number.isFinite(n) ? n : 0,
      });
    });
    cell.appendChild(input);
  }

  function cellIsBusy(cell) {
    return Boolean(cell.querySelector("input:focus") || cell.querySelector("button:active"));
  }

  function updateIoValues() {
    for (const row of el.ioBody.querySelectorAll("tr[data-id]")) {
      const watch = watches.find((w) => w.id === row.dataset.id);
      if (!watch || watch.kind !== "io") {
        continue;
      }
      const cell = row.querySelector(".value-cell");
      if (!cell || cellIsBusy(cell)) {
        continue;
      }
      const found = findIoEntry(watch.ioKind, watch.moduleId, watch.channel);
      const value = ioValue(watch);
      if (watch.ioKind === "DO") {
        cell.className = `value-cell ${value ? "on" : "off"}`;
        cell.textContent = formatBool(Boolean(value));
        continue;
      }
      if (watch.ioKind === "AI") {
        const input = cell.querySelector("input.ai-value");
        if (input) {
          input.value = String(value);
        }
        continue;
      }
      const btn = cell.querySelector("button.di-toggle");
      if (btn) {
        btn.textContent = formatBool(Boolean(value));
        btn.disabled = typeof found?.entry.index !== "number";
      }
    }
  }

  function updateVarValues() {
    for (const row of el.varBody.querySelectorAll("tr[data-id]")) {
      const watch = watches.find((w) => w.id === row.dataset.id);
      if (!watch || watch.kind !== "var") {
        continue;
      }
      const cell = row.querySelector(".value-cell");
      if (!cell || cellIsBusy(cell)) {
        continue;
      }
      const variable = findVariable(watch.programId, watch.name);
      const type = variable?.type ?? "BOOL";
      const value = varValue(watch);
      if (type === "BOOL") {
        const btn = cell.querySelector("button.di-toggle");
        if (btn) {
          btn.textContent = formatBool(Boolean(value));
        }
        continue;
      }
      const input = cell.querySelector("input.var-value");
      if (input) {
        input.value = formatNumber(value, type);
      }
    }
  }

  function ownedIo() {
    const di = new Set();
    const ai = new Set();
    for (const device of plantConfig.devices || []) {
      if (device.kind === "pushbutton" || device.kind === "switch") {
        di.add(device.di);
      } else if (device.kind === "transmitter") {
        ai.add(device.ai);
      } else if (device.kind === "motor" && device.running_di != null) {
        di.add(device.running_di);
      } else if (device.kind === "valve" && device.opened_di != null) {
        di.add(device.opened_di);
      } else if (device.kind === "tank") {
        ai.add(device.level_ai);
        if (device.high_di != null) {
          di.add(device.high_di);
        }
        if (device.low_di != null) {
          di.add(device.low_di);
        }
      } else if (device.kind === "conveyor" && device.sensor_di != null) {
        di.add(device.sensor_di);
      }
    }
    return { di, ai };
  }

  const PLANT_FIELDS = {
    pushbutton: [{ key: "di", label: "DI", kind: "DI", required: true }],
    switch: [{ key: "di", label: "DI", kind: "DI", required: true }],
    lamp: [{ key: "do", label: "DO", kind: "DO", required: true }],
    transmitter: [
      { key: "profile", label: "Profile", kind: "profile", required: true },
      { key: "ai", label: "AI", kind: "AI", required: true },
    ],
    motor: [
      { key: "run_do", label: "Run DO", kind: "DO", required: true },
      { key: "running_di", label: "Running DI", kind: "DI", required: false },
    ],
    valve: [
      { key: "open_do", label: "Open DO", kind: "DO", required: true },
      { key: "opened_di", label: "Opened DI", kind: "DI", required: false },
    ],
    tank: [
      { key: "level_ai", label: "Level AI", kind: "AI", required: true },
      { key: "inlet_do", label: "Inlet DO", kind: "DO", required: false },
      { key: "outlet_do", label: "Outlet DO", kind: "DO", required: false },
      { key: "high_di", label: "High DI", kind: "DI", required: false },
      { key: "low_di", label: "Low DI", kind: "DI", required: false },
    ],
    conveyor: [
      { key: "run_do", label: "Run DO", kind: "DO", required: true },
      { key: "sensor_di", label: "Sensor DI", kind: "DI", required: false },
    ],
  };

  function channelOptions(kind) {
    const mods = ioModulesForKind(kind);
    const items = [];
    for (const mod of mods) {
      for (const ch of mod.channels) {
        items.push({
          value: String(ch.index),
          label: `${mod.name} · ${ch.channel} — ${ch.symbol}`,
        });
      }
    }
    return items;
  }

  function refreshPlantFields() {
    const kind = el.plantKind.value;
    const fields = PLANT_FIELDS[kind] || [];
    el.plantFields.innerHTML = "";
    let missing = false;
    for (const field of fields) {
      const select = document.createElement("select");
      select.dataset.key = field.key;
      if (field.kind === "profile") {
        fillSelect(
          select,
          [
            { value: "temperature", label: "Temperature (°C)" },
            { value: "pressure", label: "Pressure (bar)" },
            { value: "adc", label: "ADC (V)" },
          ],
          field.label
        );
      } else {
        const options = channelOptions(field.kind);
        fillSelect(select, options, field.required ? field.label : `${field.label} (optional)`);
        if (field.required && options.length === 0) {
          missing = true;
        }
      }
      select.addEventListener("change", updatePlantAddEnabled);
      el.plantFields.appendChild(select);
    }
    const hasOptional = fields.some((field) => !field.required);
    el.plantHint.textContent = missing
      ? "This project has no channel of the required kind. Add I/O on the device first."
      : hasOptional
        ? "Optional feedback channels can be left unset."
        : "";
    updatePlantAddEnabled();
  }

  function updatePlantAddEnabled() {
    const fields = PLANT_FIELDS[el.plantKind.value] || [];
    let ok = el.plantName.value.trim() !== "";
    for (const field of fields) {
      if (!field.required) {
        continue;
      }
      const select = el.plantFields.querySelector(`select[data-key="${field.key}"]`);
      if (!select || !select.value) {
        ok = false;
      }
    }
    el.btnAddPlant.disabled = !ok;
  }

  function plantDevicesNow() {
    return (snap.plant && snap.plant.devices) || [];
  }

  function plantRow(device) {
    const row = document.createElement("div");
    row.className = "plant-device";
    row.dataset.id = device.id;
    const name = document.createElement("span");
    name.className = "name";
    name.textContent = device.name;
    const kind = document.createElement("span");
    kind.className = "kind-tag";
    kind.textContent = device.kind;
    const status = document.createElement("span");
    status.className = "status";
    const control = document.createElement("span");
    control.className = "plant-control";
    if (device.kind === "pushbutton") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Hold";
      const release = () => {
        if (!btn.classList.contains("held")) {
          return;
        }
        btn.classList.remove("held");
        vscode.postMessage({ type: "setPlantControl", id: device.id, value: false });
      };
      btn.addEventListener("pointerdown", (event) => {
        event.preventDefault();
        if (btn.setPointerCapture) {
          btn.setPointerCapture(event.pointerId);
        }
        btn.classList.add("held");
        vscode.postMessage({ type: "setPlantControl", id: device.id, value: true });
      });
      btn.addEventListener("pointerup", release);
      btn.addEventListener("pointercancel", release);
      btn.addEventListener("lostpointercapture", release);
      control.appendChild(btn);
    } else if (device.kind === "switch") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = "di-toggle";
      btn.addEventListener("click", () => {
        const current = plantDevicesNow().find((item) => item.id === device.id);
        vscode.postMessage({ type: "setPlantControl", id: device.id, value: !current?.bool });
      });
      control.appendChild(btn);
    } else if (device.number_min != null && (device.kind === "transmitter" || device.kind === "tank")) {
      const input = document.createElement("input");
      input.className = "plant-number";
      input.type = "number";
      input.step = "any";
      input.min = String(device.number_min);
      input.max = String(device.number_max);
      input.addEventListener("change", () => {
        const n = Number(input.value);
        vscode.postMessage({
          type: "setPlantControl",
          id: device.id,
          value: Number.isFinite(n) ? n : device.number_min,
        });
      });
      control.appendChild(input);
    } else if (device.kind === "conveyor") {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Place part";
      btn.addEventListener("click", () => {
        vscode.postMessage({ type: "setPlantControl", id: device.id, value: "load" });
      });
      control.appendChild(btn);
    }
    const remove = document.createElement("button");
    remove.type = "button";
    remove.className = "remove";
    remove.textContent = "Remove";
    remove.addEventListener("click", () => {
      vscode.postMessage({ type: "removePlantDevice", id: device.id });
    });
    row.appendChild(name);
    row.appendChild(kind);
    row.appendChild(status);
    row.appendChild(control);
    row.appendChild(remove);
    return row;
  }

  function renderPlantList() {
    const devices = plantDevicesNow();
    const sig = devices.map((device) => device.id).join(",");
    if (el.plantList.dataset.sig !== sig) {
      el.plantList.dataset.sig = sig;
      el.plantList.innerHTML = "";
      if (devices.length === 0) {
        const empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "No virtual devices. Add one to drive inputs from the panel.";
        el.plantList.appendChild(empty);
      } else {
        for (const device of devices) {
          el.plantList.appendChild(plantRow(device));
        }
      }
    }
    updatePlantRows();
  }

  function updatePlantRows() {
    for (const row of el.plantList.querySelectorAll(".plant-device")) {
      const device = plantDevicesNow().find((item) => item.id === row.dataset.id);
      if (!device) {
        continue;
      }
      row.classList.toggle("active", Boolean(device.active));
      const status = row.querySelector(".status");
      if (status) {
        status.textContent = device.unit ? `${device.status}` : device.status;
      }
      const toggle = row.querySelector("button.di-toggle");
      if (toggle) {
        toggle.textContent = device.bool ? "ON" : "OFF";
      }
      const load = row.querySelector("button");
      if (device.kind === "conveyor" && load && load.textContent === "Place part") {
        load.disabled = device.can_load === false;
      }
      const input = row.querySelector("input.plant-number");
      if (input && document.activeElement !== input && device.number != null) {
        input.value = String(device.number);
      }
    }
  }

  function renderMeta() {
    let text = `Scan #${snap.scan_index} · ${snap.elapsed_ms} ms elapsed · period ${scanPeriodMs} ms`;
    const passes = Object.entries(snap.task_passes || {});
    if (passes.length > 1) {
      text += ` · tasks: ${passes.map(([id, n]) => `${id} ${n}`).join(", ")}`;
    }
    el.meta.textContent = text;
  }

  function renderAll() {
    refreshIoSelectors();
    refreshVarSelectors();
    renderIoTable();
    renderVarTable();
    if (!el.plantFields.childElementCount) {
      refreshPlantFields();
    }
    renderPlantList();
    renderMeta();
  }

  el.ioKind.addEventListener("change", refreshIoSelectors);
  el.ioModule.addEventListener("change", refreshIoChannels);
  el.ioChannel.addEventListener("change", () => {
    el.btnAddIo.disabled = !el.ioChannel.value;
  });
  el.btnAddIo.addEventListener("click", () => {
    if (!el.ioModule.value || !el.ioChannel.value) {
      return;
    }
    vscode.postMessage({
      type: "addIo",
      ioKind: el.ioKind.value,
      moduleId: el.ioModule.value,
      channel: Number(el.ioChannel.value),
    });
  });
  el.varProgram.addEventListener("change", refreshVarNames);
  el.varName.addEventListener("change", () => {
    el.btnAddVar.disabled = !el.varName.value;
  });
  el.btnAddVar.addEventListener("click", () => {
    if (!el.varProgram.value || !el.varName.value) {
      return;
    }
    vscode.postMessage({
      type: "addVar",
      programId: el.varProgram.value,
      name: el.varName.value,
    });
  });

  el.btnAddPlant.addEventListener("click", () => {
    const payload = {
      type: "addPlantDevice",
      kind: el.plantKind.value,
      name: el.plantName.value.trim(),
    };
    for (const select of el.plantFields.querySelectorAll("select")) {
      if (!select.value) {
        continue;
      }
      if (select.dataset.key === "profile") {
        payload.profile = select.value;
      } else {
        payload[select.dataset.key] = Number(select.value);
      }
    }
    vscode.postMessage(payload);
    el.plantName.value = "";
    updatePlantAddEnabled();
  });
  el.plantKind.addEventListener("change", refreshPlantFields);
  el.plantName.addEventListener("input", updatePlantAddEnabled);

  window.addEventListener("message", (event) => {
    const msg = event.data;
    if (!msg || typeof msg !== "object") {
      return;
    }
    if (msg.type === "init") {
      ioProfile = msg.ioProfile || ioProfile;
      programs = msg.programs || [];
      plantConfig = msg.plant || { devices: [] };
      watches = msg.watches || [];
      snap = msg.snap || snap;
      scanPeriodMs = msg.scanPeriodMs || 10;
      renderAll();
      return;
    }
    if (msg.type === "watches") {
      watches = msg.watches || [];
      renderAll();
      return;
    }
    if (msg.type === "snapshot") {
      snap = msg.snap || snap;
      renderMeta();
      updateIoValues();
      updateVarValues();
      renderPlantList();
    }
  });

  vscode.postMessage({ type: "ready" });
})();
