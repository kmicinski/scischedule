const PROTOCOL_COLORS = [
  "#1f6aa5",
  "#007f5f",
  "#7b2cbf",
  "#c44536",
  "#0f766e",
  "#3a5a40",
  "#9d4edd",
  "#00509d",
  "#2d6a4f",
  "#bc6c25",
  "#6a4c93",
  "#006d77",
  "#b5179e",
  "#355070",
  "#1982c4",
  "#8ac926",
  "#5f0f40",
  "#2b2d42",
  "#118ab2",
  "#52796f",
];

const state = {
  now: new Date(),
  monthCursor: new Date(),
  weekCursor: new Date(),
  protocols: [],
  experiments: [],
  monthView: null,
  weekView: null,
  currentTab: "month",
  selectedExperimentId: null,
  placement: null,
  pendingMove: null,
  taskContext: new Map(),
};

const $ = (sel) => document.querySelector(sel);
const protocolList = $("#protocol-list");
const monthGrid = $("#month-grid");
const monthWeekdays = $("#month-weekdays");
const weekGrid = $("#week-grid");
const monthTitle = $("#month-title");
const weekTitle = $("#week-title");
const statusLine = $("#status-line");
const lockSelectedBtn = $("#lock-selected-btn");
const placementPanel = $("#placement-panel");
const placementTitle = $("#placement-title");
const placementScientist = $("#placement-scientist");
const movePanel = $("#move-panel");
const moveSubtitle = $("#move-subtitle");
const moveReason = $("#move-reason");

init();

async function init() {
  bindUi();
  await refreshAll();
}

function bindUi() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.currentTab = tab.dataset.view;
      document.querySelectorAll(".view").forEach((v) => v.classList.remove("active"));
      $(`#${tab.dataset.view}-view`).classList.add("active");
    });
  });

  $("#today-btn").addEventListener("click", async () => {
    state.monthCursor = new Date();
    state.weekCursor = new Date();
    await renderViews();
  });

  lockSelectedBtn.addEventListener("click", async () => {
    if (!state.selectedExperimentId) return;
    await lockExperiment(state.selectedExperimentId);
  });

  $("#month-prev").addEventListener("click", async () => {
    state.monthCursor.setMonth(state.monthCursor.getMonth() - 1);
    await renderMonth();
  });

  $("#month-next").addEventListener("click", async () => {
    state.monthCursor.setMonth(state.monthCursor.getMonth() + 1);
    await renderMonth();
  });

  $("#week-prev").addEventListener("click", async () => {
    state.weekCursor.setDate(state.weekCursor.getDate() - 7);
    await renderWeek();
  });

  $("#week-next").addEventListener("click", async () => {
    state.weekCursor.setDate(state.weekCursor.getDate() + 7);
    await renderWeek();
  });

  $("#placement-create").addEventListener("click", async () => {
    await finalizePlacement();
  });

  $("#placement-cancel").addEventListener("click", () => {
    clearPlacement();
    drawMonthGrid();
  });

  $("#move-confirm").addEventListener("click", async () => {
    await commitPendingMove();
  });

  $("#move-cancel").addEventListener("click", () => {
    clearPendingMove();
  });

  const dialog = $("#protocol-dialog");
  $("#new-protocol-btn").addEventListener("click", () => {
    resetProtocolDialog();
    dialog.showModal();
  });
  $("#cancel-protocol").addEventListener("click", () => dialog.close());
  $("#add-step").addEventListener("click", () => addStepCard());

  $("#protocol-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    await createProtocolFromDialog();
    dialog.close();
  });
}

function resetProtocolDialog() {
  const container = $("#steps-container");
  container.innerHTML = "";
  addStepCard();
}

function addStepCard() {
  const tpl = $("#step-template");
  const node = tpl.content.cloneNode(true);
  $("#steps-container").appendChild(node);
  refreshParentOptions();
}

function refreshParentOptions() {
  const cards = Array.from(document.querySelectorAll("#steps-container .step-card"));
  cards.forEach((card, idx) => {
    const sel = card.querySelector(".step-parent");
    const current = sel.value;
    sel.innerHTML = '<option value="">(root)</option>';
    cards.forEach((inner, jdx) => {
      if (idx === jdx) return;
      const name = inner.querySelector(".step-name").value || `Step ${jdx + 1}`;
      sel.insertAdjacentHTML("beforeend", `<option value="${jdx}">${name}</option>`);
    });
    sel.value = current;
  });
}

async function createProtocolFromDialog() {
  const form = $("#protocol-form");
  const name = form.elements.name.value;
  const description = form.elements.description.value;

  const cards = Array.from(document.querySelectorAll("#steps-container .step-card"));
  const steps = cards.map((card) => ({
    name: card.querySelector(".step-name").value,
    details: card.querySelector(".step-details").value,
    parent_step_index: null,
    default_offset_days: parseInt(card.querySelector(".step-offset").value || "0", 10),
  }));

  cards.forEach((card, i) => {
    const parentValue = card.querySelector(".step-parent").value;
    if (parentValue !== "") {
      steps[i].parent_step_index = parseInt(parentValue, 10);
    }
  });

  const created = await api("/api/protocols", {
    method: "POST",
    body: JSON.stringify({ name, description, steps }),
  });

  if (!created.id) {
    showStatus(created.error || "Failed to create protocol", true);
    return;
  }

  showStatus("Protocol created.");
  await refreshAll();
}

async function refreshAll() {
  state.protocols = await api("/api/protocols");
  state.experiments = await api("/api/experiments");
  if (!Array.isArray(state.protocols)) state.protocols = [];
  if (!Array.isArray(state.experiments)) state.experiments = [];

  rebuildTaskContext();
  renderProtocols();
  updateLockButton();
  updatePlacementPanel();
  updateMovePanel();
  await renderViews();
}

function rebuildTaskContext() {
  state.taskContext.clear();

  for (const exp of state.experiments) {
    const protocol = state.protocols.find((p) => p.id === exp.protocol_id);
    const steps = protocol?.steps || [];
    const stepById = new Map(steps.map((s) => [s.id, s]));
    const childrenById = new Map();

    for (const step of steps) {
      if (!step.parent_step_id) continue;
      const arr = childrenById.get(step.parent_step_id) || [];
      arr.push(step.id);
      childrenById.set(step.parent_step_id, arr);
    }

    const taskByStep = new Map(exp.tasks.map((t) => [t.step_id, t]));

    for (const task of exp.tasks) {
      const step = stepById.get(task.step_id);
      const parentTask = step?.parent_step_id ? taskByStep.get(step.parent_step_id) : null;
      const nextDates = (childrenById.get(task.step_id) || [])
        .map((sid) => taskByStep.get(sid)?.date)
        .filter(Boolean)
        .sort();

      state.taskContext.set(task.id, {
        experimentId: exp.id,
        protocolId: exp.protocol_id,
        protocolName: exp.protocol_name,
        task,
        parentDate: parentTask?.date || null,
        nextDates,
      });
    }
  }
}

async function renderViews() {
  await Promise.all([renderMonth(), renderWeek()]);
}

function renderProtocols() {
  protocolList.innerHTML = "";
  for (const p of state.protocols) {
    const li = document.createElement("li");
    li.className = "protocol-item";
    li.draggable = true;
    li.dataset.protocolId = p.id;
    li.style.borderLeft = `4px solid ${protocolColor(p.id)}`;
    li.innerHTML = `<strong>${escapeHtml(p.name)}</strong><br/><small>${escapeHtml(p.description || "")}</small>`;

    li.addEventListener("dragstart", (e) => {
      e.dataTransfer.setData("text/protocol-id", p.id);
    });

    li.addEventListener("click", () => {
      beginPlacement(p.id, currentMonthAnchorDate());
      drawMonthGrid();
    });

    protocolList.appendChild(li);
  }
}

async function renderMonth() {
  const year = state.monthCursor.getFullYear();
  const month = state.monthCursor.getMonth() + 1;
  state.monthView = await api(`/api/views/month?year=${year}&month=${month}`);
  monthTitle.textContent = `${state.monthCursor.toLocaleString(undefined, { month: "long" })} ${year}`;
  renderWeekdayHeader();
  drawMonthGrid();
}

function renderWeekdayHeader() {
  monthWeekdays.innerHTML = "";
  ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].forEach((w) => {
    const d = document.createElement("div");
    d.className = "weekday";
    d.textContent = w;
    monthWeekdays.appendChild(d);
  });
}

function drawMonthGrid() {
  if (!state.monthView || !Array.isArray(state.monthView.cells)) return;

  clearHoverFocus();
  monthGrid.innerHTML = "";

  const year = state.monthCursor.getFullYear();
  const month = state.monthCursor.getMonth() + 1;
  const first = new Date(year, month - 1, 1);
  const leadingEmpty = (first.getDay() + 6) % 7;
  for (let i = 0; i < leadingEmpty; i++) {
    const spacer = document.createElement("div");
    monthGrid.appendChild(spacer);
  }

  const previewByDate = buildPlacementTasksByDate();

  for (const cell of state.monthView.cells) {
    const d = new Date(cell.date);
    const div = document.createElement("div");
    div.className = "month-cell";
    div.dataset.date = cell.date;
    div.innerHTML = `<div class="day-number">${d.getDate()}</div>`;

    drawTaskRows(div, cell, previewByDate.get(cell.date) || []);

    div.addEventListener("click", () => {
      if (state.placement) {
        state.placement.anchorDate = cell.date;
        updatePlacementPanel();
        drawMonthGrid();
      }
    });

    div.addEventListener("dragover", (e) => {
      const protocolId = e.dataTransfer.getData("text/protocol-id");
      const previewAnchor = e.dataTransfer.getData("text/preview-anchor");
      const taskId = e.dataTransfer.getData("text/task-id");

      if (protocolId || previewAnchor || taskId) {
        e.preventDefault();
        div.classList.add("drag-over");
      }

      if (protocolId || previewAnchor) {
        const nextProtocolId = protocolId || state.placement?.protocolId;
        const needsUpdate =
          !state.placement ||
          state.placement.protocolId !== nextProtocolId ||
          state.placement.anchorDate !== cell.date;
        if (needsUpdate) {
          beginPlacement(nextProtocolId, cell.date);
          drawMonthGrid();
        }
      }
    });

    div.addEventListener("dragleave", () => div.classList.remove("drag-over"));

    div.addEventListener("drop", async (e) => {
      e.preventDefault();
      div.classList.remove("drag-over");
      const protocolId = e.dataTransfer.getData("text/protocol-id");
      const previewAnchor = e.dataTransfer.getData("text/preview-anchor");
      const taskId = e.dataTransfer.getData("text/task-id");
      const experimentId = e.dataTransfer.getData("text/experiment-id");

      if (protocolId || previewAnchor) {
        beginPlacement(protocolId || state.placement?.protocolId, cell.date);
        drawMonthGrid();
      } else if (taskId && experimentId) {
        stageMove(experimentId, taskId, cell.date);
      }
    });

    monthGrid.appendChild(div);
  }
}

function drawTaskRows(cellEl, cell, previews) {
  const tasks = Array.isArray(cell.tasks) ? cell.tasks : [];
  const maxRows = 7;
  const rows = [];

  tasks.forEach((task) => {
    const ctx = state.taskContext.get(task.id);
    if (!ctx) return;

    rows.push({
      kind: "task",
      task,
      text: `${ctx.protocolName}: ${task.step_name}`,
      protocolId: ctx.protocolId,
      experimentId: ctx.experimentId,
      parentDate: ctx.parentDate,
      nextDates: ctx.nextDates,
      deviation: Boolean(task.deviation),
    });
  });

  previews.forEach((preview) => {
    const protocol = state.protocols.find((p) => p.id === state.placement?.protocolId);
    rows.push({
      kind: "preview",
      text: `${protocol?.name || "Preview"}: ${preview.label}`,
      protocolId: state.placement?.protocolId,
      isRoot: preview.isRoot,
    });
  });

  rows.slice(0, maxRows).forEach((row) => {
    const div = document.createElement("div");
    div.className = `task-row ${row.kind === "preview" ? "preview" : ""} ${row.isRoot ? "preview-root" : ""} ${row.deviation ? "deviation" : ""}`;
    if (row.kind === "task" && state.selectedExperimentId === row.experimentId) {
      div.classList.add("selected");
    }

    if (row.kind === "task") {
      div.dataset.experimentId = row.experimentId;
      div.dataset.taskId = row.task.id;
    }

    div.style.setProperty("--proto-color", protocolColor(row.protocolId));
    div.innerHTML = `<div class="task-row-text">${escapeHtml(row.text)}</div>`;

    if (row.kind === "task") {
      div.draggable = true;
      div.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/task-id", row.task.id);
        e.dataTransfer.setData("text/experiment-id", row.experimentId);
      });

      div.addEventListener("click", (e) => {
        e.stopPropagation();
        selectExperiment(row.experimentId);
      });

      div.addEventListener("mouseenter", () => {
        applyHoverFocus(row.experimentId, row.task.id, row.parentDate, row.nextDates || []);
      });

      div.addEventListener("mouseleave", clearHoverFocus);
    }

    if (row.kind === "preview" && row.isRoot) {
      div.draggable = true;
      div.addEventListener("dragstart", (e) => {
        e.dataTransfer.setData("text/preview-anchor", "1");
        e.dataTransfer.setData("text/protocol-id", state.placement.protocolId);
      });
    }

    cellEl.appendChild(div);
  });

  if (rows.length > maxRows) {
    const more = document.createElement("div");
    more.className = "day-rollup";
    more.textContent = `+${rows.length - maxRows} additional items`;
    cellEl.appendChild(more);
  }
}

function applyHoverFocus(experimentId, taskId, parentDate, nextDates) {
  clearHoverFocus();
  monthGrid.classList.add("hovering");

  document.querySelectorAll(".task-row[data-experiment-id]").forEach((row) => {
    if (row.dataset.experimentId === experimentId) {
      row.classList.add("focused");
    }
  });

  document.querySelectorAll(".month-cell").forEach((cell) => {
    if (!cell.querySelector(`.task-row[data-experiment-id="${experimentId}"]`)) {
      cell.classList.add("muted");
    }
  });

  if (parentDate) {
    highlightRange(parentDate, state.taskContext.get(taskId)?.task.date || parentDate, "range-back");
  }

  (nextDates || []).forEach((d) => {
    highlightRange(state.taskContext.get(taskId)?.task.date || d, d, "range-forward");
  });

  const currDate = state.taskContext.get(taskId)?.task.date;
  if (currDate) {
    const cell = document.querySelector(`.month-cell[data-date="${currDate}"]`);
    if (cell) cell.classList.add("range-current");
  }
}

function clearHoverFocus() {
  monthGrid.classList.remove("hovering");
  document.querySelectorAll(".task-row.focused").forEach((row) => row.classList.remove("focused"));
  document.querySelectorAll(".month-cell.muted").forEach((cell) => cell.classList.remove("muted"));
  document
    .querySelectorAll(".month-cell.range-back, .month-cell.range-forward, .month-cell.range-current")
    .forEach((cell) => {
      cell.classList.remove("range-back", "range-forward", "range-current");
    });
}

function highlightRange(a, b, klass) {
  const start = a <= b ? a : b;
  const end = a <= b ? b : a;
  document.querySelectorAll(".month-cell").forEach((cell) => {
    const date = cell.dataset.date;
    if (!date) return;
    if (date >= start && date <= end) {
      cell.classList.add(klass);
    }
  });
}

async function renderWeek() {
  const d = state.weekCursor;
  const year = d.getFullYear();
  const month = d.getMonth() + 1;
  const day = d.getDate();

  state.weekView = await api(`/api/views/week?year=${year}&month=${month}&day=${day}`);
  const start = new Date(state.weekView.week_start);
  const end = new Date(start);
  end.setDate(end.getDate() + 6);
  weekTitle.textContent = `${start.toLocaleDateString()} - ${end.toLocaleDateString()}`;

  weekGrid.innerHTML = "";

  for (const wd of state.weekView.days) {
    const wrap = document.createElement("section");
    wrap.className = "week-day";
    wrap.dataset.date = wd.date;
    wrap.innerHTML = `<h4>${new Date(wd.date).toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" })}</h4>`;

    wrap.addEventListener("dragover", (e) => e.preventDefault());
    wrap.addEventListener("drop", async (e) => {
      e.preventDefault();
      const taskId = e.dataTransfer.getData("text/task-id");
      const experimentId = e.dataTransfer.getData("text/experiment-id");
      if (taskId && experimentId) {
        stageMove(experimentId, taskId, wd.date);
      }
    });

    renderWeekDayContent(wrap, wd);
    weekGrid.appendChild(wrap);
  }
}

function renderWeekDayContent(wrap, wd) {
  const tasks = wd.tasks || [];
  const selected = state.selectedExperimentId;

  if (selected) {
    const selectedTasks = tasks.filter((t) => state.taskContext.get(t.id)?.experimentId === selected);
    const otherCount = tasks.length - selectedTasks.length;

    selectedTasks.slice(0, 8).forEach((task) => {
      wrap.appendChild(buildWeekTaskRow(task));
    });

    if (selectedTasks.length > 8) {
      const more = document.createElement("div");
      more.className = "day-rollup";
      more.textContent = `+${selectedTasks.length - 8} additional selected tasks`;
      wrap.appendChild(more);
    }

    if (otherCount > 0) {
      const info = document.createElement("div");
      info.className = "day-rollup";
      info.textContent = `${otherCount} tasks from other experiments hidden`;
      wrap.appendChild(info);
    }
    return;
  }

  const byProtocol = new Map();
  tasks.forEach((task) => {
    const ctx = state.taskContext.get(task.id);
    const key = ctx?.protocolId || "unknown";
    const curr = byProtocol.get(key) || { name: ctx?.protocolName || "Experiment", protocolId: key, count: 0, anyDeviation: false, experimentId: ctx?.experimentId || "" };
    curr.count += 1;
    curr.anyDeviation = curr.anyDeviation || Boolean(task.deviation);
    byProtocol.set(key, curr);
  });

  const summaries = Array.from(byProtocol.values()).sort((a, b) => b.count - a.count);
  summaries.slice(0, 7).forEach((s) => {
    const row = document.createElement("div");
    row.className = `week-summary ${s.anyDeviation ? "deviation" : ""}`;
    row.style.setProperty("--proto-color", protocolColor(s.protocolId));
    row.innerHTML = `<div>${escapeHtml(s.name)} x${s.count}</div><small>${s.anyDeviation ? "Contains deviations" : "On protocol"}</small>`;
    row.addEventListener("click", () => selectExperiment(s.experimentId));
    wrap.appendChild(row);
  });

  if (summaries.length > 7) {
    const more = document.createElement("div");
    more.className = "day-rollup";
    more.textContent = `+${summaries.length - 7} additional protocols`;
    wrap.appendChild(more);
  }
}

function buildWeekTaskRow(task) {
  const row = document.createElement("div");
  const ctx = state.taskContext.get(task.id);
  const expId = ctx?.experimentId || "";
  row.className = `week-task ${state.selectedExperimentId === expId ? "selected" : ""} ${task.deviation ? "deviation" : ""}`;
  row.draggable = true;
  row.dataset.taskId = task.id;
  row.dataset.experimentId = expId;

  row.addEventListener("dragstart", (e) => {
    e.dataTransfer.setData("text/task-id", task.id);
    e.dataTransfer.setData("text/experiment-id", row.dataset.experimentId);
  });

  row.addEventListener("click", () => selectExperiment(row.dataset.experimentId));

  row.innerHTML = `
    <div>
      <strong>${escapeHtml(ctx?.protocolName || "Experiment")}: ${escapeHtml(task.step_name)}</strong>
      ${task.deviation ? `<div class="small">Moved ${task.deviation.shifted_by_days > 0 ? "+" : ""}${task.deviation.shifted_by_days}d</div>` : ""}
    </div>
    <div>
      <button class="btn up">↑</button>
      <button class="btn down">↓</button>
    </div>
  `;

  row.querySelector(".up").addEventListener("click", async (e) => {
    e.stopPropagation();
    await reorderTask(row.dataset.experimentId, task.id, task.day_priority - 1);
  });
  row.querySelector(".down").addEventListener("click", async (e) => {
    e.stopPropagation();
    await reorderTask(row.dataset.experimentId, task.id, task.day_priority + 1);
  });

  return row;
}

function selectExperiment(experimentId) {
  state.selectedExperimentId = experimentId || null;
  updateLockButton();
  drawMonthGrid();
  renderWeek();
}

function updateLockButton() {
  const experiment = state.experiments.find((e) => e.id === state.selectedExperimentId);
  const canLock = experiment && experiment.status === "Draft";
  lockSelectedBtn.disabled = !canLock;
}

function beginPlacement(protocolId, anchorDate) {
  if (!protocolId) return;
  const protocol = state.protocols.find((p) => p.id === protocolId);
  if (!protocol) return;

  const sameProtocol = state.placement && state.placement.protocolId === protocolId;
  state.placement = {
    protocolId,
    anchorDate,
    scientist: sameProtocol ? placementScientist.value || "scientist" : "scientist",
  };

  placementScientist.value = state.placement.scientist;
  updatePlacementPanel();
}

function clearPlacement() {
  state.placement = null;
  updatePlacementPanel();
}

function updatePlacementPanel() {
  if (!state.placement) {
    placementPanel.classList.add("hidden");
    return;
  }

  const protocol = state.protocols.find((p) => p.id === state.placement.protocolId);
  placementPanel.classList.remove("hidden");
  placementTitle.textContent = `Protocol Placement: ${protocol?.name || "Unknown"}`;
  $("#placement-subtitle").textContent = `Start date ${state.placement.anchorDate}. Drag the highlighted root row to reposition.`;
}

function stageMove(experimentId, taskId, toDate) {
  const ctx = state.taskContext.get(taskId);
  if (!ctx) return;
  if (ctx.task.date === toDate) return;

  state.pendingMove = {
    experimentId,
    taskId,
    fromDate: ctx.task.date,
    toDate,
    label: `${ctx.protocolName}: ${ctx.task.step_name}`,
  };
  moveReason.value = ctx.task.deviation?.reason || "";
  updateMovePanel();
  showStatus("Review and confirm the deviation before saving.");
}

function clearPendingMove() {
  state.pendingMove = null;
  updateMovePanel();
}

function updateMovePanel() {
  if (!state.pendingMove) {
    movePanel.classList.add("hidden");
    return;
  }

  movePanel.classList.remove("hidden");
  moveSubtitle.textContent = `${state.pendingMove.label} from ${state.pendingMove.fromDate} to ${state.pendingMove.toDate}`;
}

async function commitPendingMove() {
  if (!state.pendingMove) return;
  const reason = (moveReason.value || "Manual deviation").trim();

  const res = await api(`/api/experiments/${state.pendingMove.experimentId}/tasks/move`, {
    method: "PATCH",
    body: JSON.stringify({
      task_id: state.pendingMove.taskId,
      new_date: state.pendingMove.toDate,
      reason,
    }),
  });

  if (res.error) {
    showStatus(res.error, true);
    return;
  }

  showStatus("Deviation saved.");
  clearPendingMove();
  await refreshAll();
}

function buildPlacementTasksByDate() {
  const out = new Map();
  if (!state.placement) return out;

  const protocol = state.protocols.find((p) => p.id === state.placement.protocolId);
  if (!protocol || !Array.isArray(protocol.steps) || protocol.steps.length === 0) return out;

  const ordered = topologicalSortSteps(protocol.steps);
  const datesByStep = new Map();

  for (const step of ordered) {
    const date = step.parent_step_id
      ? addDays(datesByStep.get(step.parent_step_id), step.default_offset_days || 0)
      : state.placement.anchorDate;
    datesByStep.set(step.id, date);

    const current = out.get(date) || [];
    current.push({ label: step.name, isRoot: !step.parent_step_id });
    out.set(date, current);
  }

  return out;
}

function topologicalSortSteps(steps) {
  const byId = new Map(steps.map((s) => [s.id, s]));
  const indegree = new Map();
  const children = new Map();

  steps.forEach((s) => {
    indegree.set(s.id, indegree.get(s.id) || 0);
    if (s.parent_step_id && byId.has(s.parent_step_id)) {
      indegree.set(s.id, (indegree.get(s.id) || 0) + 1);
      const kids = children.get(s.parent_step_id) || [];
      kids.push(s.id);
      children.set(s.parent_step_id, kids);
    }
  });

  const queue = [];
  indegree.forEach((deg, id) => {
    if (deg === 0) queue.push(id);
  });

  const out = [];
  while (queue.length > 0) {
    const id = queue.shift();
    out.push(byId.get(id));
    const kids = children.get(id) || [];
    kids.forEach((childId) => {
      const next = (indegree.get(childId) || 0) - 1;
      indegree.set(childId, next);
      if (next === 0) queue.push(childId);
    });
  }

  return out.length === steps.length ? out : steps;
}

async function finalizePlacement() {
  if (!state.placement) return;

  const scientist = (placementScientist.value || "scientist").trim();
  if (!scientist) {
    showStatus("Scientist name is required.", true);
    return;
  }

  const res = await api("/api/experiments", {
    method: "POST",
    body: JSON.stringify({
      protocol_id: state.placement.protocolId,
      start_date: state.placement.anchorDate,
      created_by: scientist,
    }),
  });

  if (res.error) {
    showStatus(res.error, true);
    return;
  }

  showStatus("Draft experiment created. Lock it manually when ready.");
  state.selectedExperimentId = res.id;
  clearPlacement();
  await refreshAll();
}

async function lockExperiment(experimentId) {
  const res = await api(`/api/experiments/${experimentId}/lock`, { method: "POST" });
  if (res.error) {
    showStatus(res.error, true);
    return;
  }
  showStatus("Experiment locked and marked live.");
  await refreshAll();
}

async function reorderTask(experimentId, taskId, newPriority) {
  const res = await api(`/api/experiments/${experimentId}/tasks/reorder`, {
    method: "PATCH",
    body: JSON.stringify({ task_id: taskId, new_priority: newPriority }),
  });

  if (res.error) {
    showStatus(res.error, true);
  }

  await refreshAll();
}

function protocolColor(protocolId) {
  if (!protocolId) return PROTOCOL_COLORS[0];
  let h = 0;
  for (let i = 0; i < protocolId.length; i++) {
    h = (h * 31 + protocolId.charCodeAt(i)) >>> 0;
  }
  return PROTOCOL_COLORS[h % PROTOCOL_COLORS.length];
}

function showStatus(message, isError = false) {
  statusLine.textContent = message || "";
  statusLine.classList.toggle("error", Boolean(isError));
}

async function api(url, opts = {}) {
  const res = await fetch(url, {
    headers: { "Content-Type": "application/json" },
    ...opts,
  });

  const text = await res.text();
  if (!text) return {};

  try {
    return JSON.parse(text);
  } catch {
    return { error: text };
  }
}

function addDays(dateStr, offset) {
  const d = new Date(dateStr + "T00:00:00");
  d.setDate(d.getDate() + Number(offset || 0));
  return dateToISO(d);
}

function dateToISO(date) {
  const y = date.getFullYear();
  const m = `${date.getMonth() + 1}`.padStart(2, "0");
  const d = `${date.getDate()}`.padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function currentMonthAnchorDate() {
  const d = new Date(state.monthCursor);
  d.setDate(1);
  return dateToISO(d);
}

function escapeHtml(s) {
  return String(s || "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
