const state = { csrf: null, charts: {}, skills: [], activeFilter: "all", token: null, tabsLoaded: new Set() };

// ───── remote access token (from URL param, stored in sessionStorage) ─────
(function initToken() {
  const p = new URLSearchParams(location.search);
  const t = p.get("token");
  if (t) { sessionStorage.setItem("cp_token", t); history.replaceState({}, "", location.pathname); }
  state.token = sessionStorage.getItem("cp_token") || null;
})();

const PALETTE = ["#00E676", "#60A5FA", "#A78BFA", "#F59E0B", "#FB7185", "#38BDF8", "#34D399", "#F472B6", "#FCD34D", "#818CF8"];

// ───── Chart.js global dark theme defaults ─────
if (typeof Chart !== "undefined") {
  Chart.defaults.color = "#4E6079";
  Chart.defaults.borderColor = "#1E2D45";
  Chart.defaults.backgroundColor = "rgba(0,230,118,0.1)";
  Chart.defaults.plugins.legend.display = false;
  Chart.defaults.plugins.tooltip.backgroundColor = "#0F1623";
  Chart.defaults.plugins.tooltip.borderColor = "#1E2D45";
  Chart.defaults.plugins.tooltip.borderWidth = 1;
  Chart.defaults.plugins.tooltip.titleColor = "#E8EEF8";
  Chart.defaults.plugins.tooltip.bodyColor = "#94A3B8";
  Chart.defaults.plugins.tooltip.padding = 10;
  Chart.defaults.plugins.tooltip.cornerRadius = 8;
  Chart.defaults.scale.grid.color = "#1E2D45";
  Chart.defaults.scale.ticks.color = "#4E6079";
}

async function api(path, opts = {}) {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (state.csrf && opts.method && opts.method !== "GET") headers["X-TK-CP-CSRF"] = state.csrf;
  if (state.token) headers["X-CP-Token"] = state.token;
  const r = await fetch(path, { ...opts, headers });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json();
}

const fmtTime = ts => { if (!ts) return "—"; return new Date(ts * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }); };
const fmtUsd = n => { if (n == null) return "—"; return "$" + Number(n).toFixed(2); };
const fmtUsd4 = n => { if (n == null) return "—"; return "$" + Number(n).toFixed(4); };
const esc = s => String(s == null ? "" : s).replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;" }[c]));

// ───── tab switching ─────
document.querySelectorAll(".tab").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".tab-panel").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.querySelector(`.tab-panel[data-panel="${btn.dataset.tab}"]`).classList.add("active");
    if (btn.dataset.tab === "agents") { try { loadAgentManager(); } catch {} }
    if (btn.dataset.tab === "lead-gen") { try { loadLeadGen(); } catch {} }
    if (btn.dataset.tab === "scheduled-jobs") { try { loadScheduledJobs(); } catch {} }
    if (btn.dataset.tab === "crm") { state.tabsLoaded.add("crm"); try { loadCrm(); } catch {} }
    if (btn.dataset.tab === "hubspot") { state.tabsLoaded.add("hubspot"); try { loadHubspot(); } catch {} }
    if (btn.dataset.tab === "instantly") { state.tabsLoaded.add("instantly"); try { loadInstantly(); } catch {} }
  };
});

// ───── bootstrap ─────
async function loadBootstrap() {
  const r = await api("/api/bootstrap");
  state.csrf = r.csrf;
}

// ───── spend tiles ─────
async function loadSpend() {
  const [{ summary }, cc] = await Promise.all([
    api("/api/spend"),
    api("/api/claude-code/summary"),
  ]);
  const el = document.getElementById("spend-tiles");

  const plan = cc.plan || {};
  const ccApiToday = (cc.today || {}).api_usd || 0;
  const ccApiMtd = plan.api_equivalent_mtd || 0;
  const leverage = plan.leverage_x || 0;
  const savings = plan.savings_mtd || 0;
  const planMonthly = plan.monthly_usd || 200;

  // Merge OpenRouter/external telemetry (usually empty) + Claude Code
  let totalToday = ccApiToday, totalMtd = ccApiMtd;
  summary.forEach(r => { totalToday += r.today || 0; totalMtd += r.mtd || 0; });

  const tiles = [
    `<div class="tile"><div class="label">API-equivalent today</div><div class="value">${fmtUsd(totalToday)}</div><div class="sub">what this would cost pay-as-you-go</div></div>`,
    `<div class="tile"><div class="label">API-equivalent MTD</div><div class="value">${fmtUsd(totalMtd)}</div><div class="sub">vs $${planMonthly.toFixed(0)} Max plan flat fee</div></div>`,
    `<div class="tile"><div class="label">Leverage MTD</div><div class="value">${leverage.toFixed(1)}×</div><div class="sub">saved ${fmtUsd(savings)} vs pay-as-you-go</div></div>`,
    `<div class="tile"><div class="label">Claude Max (today)</div><div class="value">${fmtUsd(ccApiToday)}</div><div class="sub">${(cc.today || {}).turns || 0} turns · plan share ${fmtUsd((cc.today || {}).usd || 0)}</div></div>`,
    `<div class="tile"><div class="label">Claude Max (MTD)</div><div class="value">${fmtUsd(ccApiMtd)}</div><div class="sub">${(cc.month || {}).turns || 0} turns · ${(cc.month || {}).sessions || 0} sessions</div></div>`,
  ];
  if (summary.length) {
    summary.forEach(r => tiles.push(`<div class="tile"><div class="label">${esc(r.provider)}</div><div class="value">${fmtUsd(r.today)}</div><div class="sub">today · MTD ${fmtUsd(r.mtd)}</div></div>`));
  }
  el.innerHTML = tiles.join("");
}

// ───── live calls ─────
async function loadCalls() {
  const { calls } = await api("/api/calls");
  document.getElementById("calls-count").textContent = `${calls.length} recent`;
  const tbody = document.querySelector("#calls-table tbody");
  if (!calls.length) { tbody.innerHTML = '<tr><td colspan="8" class="muted center">No calls yet.</td></tr>'; return; }
  tbody.innerHTML = calls.slice(0, 50).map(c => `
    <tr>
      <td>${fmtTime(c.ts)}</td>
      <td>${esc(c.provider)}</td>
      <td>${esc(c.model)}</td>
      <td>${esc(prettyProject(c.skill_tag))}</td>
      <td>${c.tokens_in ?? "—"}</td>
      <td>${c.tokens_out ?? "—"}</td>
      <td>${fmtUsd4(c.usd)}</td>
      <td>${c.latency_ms ?? "—"}</td>
    </tr>`).join("");
}

// ───── revenue goal progress bar (shared by Overview + CRM) ─────
const _fmtMrr = n => "$" + Math.round(Number(n) || 0).toLocaleString();
function renderGoalBar(targetId, activeMrr) {
  const el = document.getElementById(targetId);
  if (!el) return;
  const GOAL_FULL = 15000;   // FULL TIME TURNKEY
  const GOAL_MILE = 9000;    // QUIT ALTERYX milestone
  activeMrr = activeMrr || 0;
  const pct = Math.min(100, (activeMrr / GOAL_FULL) * 100);
  const milePct = (GOAL_MILE / GOAL_FULL) * 100; // 60%
  const hitMile = activeMrr >= GOAL_MILE;
  const hitFull = activeMrr >= GOAL_FULL;
  const fillColor = hitFull ? "#FFD700" : hitMile ? "#00E676" : "#047857";
  const pctLabel = pct > 12 ? `<span style="font-size:11px;font-weight:700;color:#000;padding-right:6px;">${pct.toFixed(0)}%</span>` : "";
  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div style="padding:20px 24px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#5B635E;">REVENUE GOAL · ACTIVE MRR</div>
          <div style="font-size:22px;font-weight:800;color:#0F1311;">
            ${_fmtMrr(activeMrr)}
            <span style="font-size:13px;font-weight:400;color:#8A918C;">/ ${_fmtMrr(GOAL_FULL)} MRR</span>
          </div>
        </div>
        <div style="position:relative;height:32px;background:#1F2937;border-radius:8px;overflow:visible;margin-bottom:28px;">
          <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:${fillColor};border-radius:8px;display:flex;align-items:center;justify-content:flex-end;">${pctLabel}</div>
          <div style="position:absolute;left:${milePct}%;top:-8px;bottom:-8px;width:2px;background:#F59E0B;z-index:2;border-radius:2px;"></div>
          <div style="position:absolute;left:${milePct}%;top:40px;transform:translateX(-50%);white-space:nowrap;text-align:center;">
            <span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#F59E0B;">QUIT ALTERYX</span>
            <span style="font-size:10px;color:#6B7280;display:block;">$9,000</span>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11px;color:#4B5563;">$0</span>
          <span style="font-size:${hitFull ? "13px" : "11px"};font-weight:${hitFull ? "800" : "400"};color:${hitFull ? "#FFD700" : "#4B5563"};">
            ${hitFull ? "★ FULL TIME TURNKEY ★" : "FULL TIME TURNKEY · $15,000"}
          </span>
        </div>
        ${hitFull ? '<div style="margin-top:16px;text-align:center;font-size:16px;font-weight:800;color:#FFD700;letter-spacing:.1em;">YOU DID IT — FULL TIME TURNKEY</div>' : ""}
      </div>
    </div>`;
}

// Overview reads the SAME CRM snapshot as the CRM tab → MRR can't disagree.
async function loadOverviewGoal() {
  try {
    const d = await api("/api/crm/snapshot");
    const s = d.summary || {};
    window._activeMrr = s.active_mrr || 0;
    renderGoalBar("overview-goal-section", window._activeMrr);
  } catch (e) { /* leave empty on failure */ }
}

// Earnings-potential forecast: KPI tiles + stacked service-line bars + per-line
// table + assumptions. Recurring (CFO/Web MRR) + one-time (Recruiting/Web builds).
async function loadOverviewForecast() {
  let f;
  try { f = await api("/api/crm/forecast"); } catch (e) { return; }
  const el = document.getElementById("overview-forecast");
  if (!el) return;
  const months = f.months || [];
  if (!months.length) { el.innerHTML = ""; return; }
  const k = f.kpis || {};
  const pct = Math.round((f.margin || 0.7) * 100);
  const labels = months.map(m => m.label);

  // KPI tiles
  const tile = (label, val, sub, accent) => `
    <div class="tile" style="border-left:3px solid ${accent || "#00B050"};">
      <div class="label">${label}</div>
      <div class="value">${val}</div>
      <div class="sub">${sub}</div>
    </div>`;
  const kpis = [
    tile("6-Mo Earnings Potential", _fmtMrr(k.six_month_total), "Jul–Dec gross revenue", "#00B050"),
    tile(`6-Mo Net @ ${pct}%`, _fmtMrr(k.six_month_net), "after assumed margin", "#047857"),
    tile("Exit MRR (Dec)", _fmtMrr(k.exit_mrr), "recurring run-rate at +6mo", "#2563EB"),
    tile("Recruiting Pops", _fmtMrr(k.recruiting_total), `peak month ${k.peak_label} · ${_fmtMrr(k.peak_total)}`, "#F59E0B"),
  ].join("");

  // table rows
  const th = s => `<th style="padding:6px 9px;text-align:right;font-size:11px;font-weight:700;color:#5B635E;white-space:nowrap;">${s}</th>`;
  const tdL = (s, c) => `<td style="padding:6px 9px;text-align:left;font-size:12px;font-weight:600;color:${c || "#5B635E"};white-space:nowrap;">${s}</td>`;
  const td = (v, bold, c) => `<td style="padding:6px 9px;text-align:right;font-size:13px;color:${c || "#0F1311"};${bold ? "font-weight:800;" : "font-weight:600;"}">${v ? _fmtMrr(v) : "—"}</td>`;
  const headRow = `<tr><th style="text-align:left;padding:6px 9px;"></th>${labels.map(th).join("")}</tr>`;
  const row = (lbl, key, dot) => `<tr><td style="padding:6px 9px;text-align:left;font-size:12px;font-weight:600;color:#5B635E;white-space:nowrap;"><span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${dot};margin-right:7px;"></span>${lbl}</td>${months.map(m => td(m[key])).join("")}</tr>`;
  const totalRow = `<tr style="border-top:2px solid #E3E8E5;">${tdL("Total", "#0F1311")}${months.map(m => td(m.total, true)).join("")}</tr>`;
  const netRow = `<tr>${tdL(`Net @ ${pct}%`, "#047857")}${months.map(m => td(m.net, true, "#047857")).join("")}</tr>`;
  const table = `<table style="width:100%;border-collapse:collapse;margin-top:6px;">
    ${headRow}
    ${row("Turnkey CFO · MRR", "cfo_mrr", "#00B050")}
    ${row("Turnkey Web · MRR", "web_mrr", "#2563EB")}
    ${row("Web · builds (1×)", "web_onetime", "#93C5FD")}
    ${row("Recruiting (1×)", "recruiting_onetime", "#F59E0B")}
    ${totalRow}${netRow}</table>`;

  // assumptions
  const a = f.assumptions || {};
  const money = n => "$" + Math.round(n).toLocaleString();
  const cfoLines = (a.cfo_new_clients || []).map(c =>
    `${c.name} <b>${money(c.monthly)}/mo</b>${c.ramp_to ? ` → ${money(c.ramp_to)} over ${c.ramp_months}mo` : ""} · starts +${c.start_month}mo`);
  const rollLines = (a.temp_rolloffs || []).map(t => `${t.name} −${money(t.amount)}/mo at +${t.end_month}mo`);
  const recLines = (a.recruiting || []).map(r => `${r.name} <b>${money(r.amount)}</b> at +${r.month}mo`);
  const webA = a.web || {};
  const webLine = `${webA.new_care_plans_per_month || 0} new $${webA.care_plan_value || 147}/mo care plan(s)/mo from +${webA.care_plans_start_month || 2}mo`
    + (webA.one_time && webA.one_time.length ? ` · builds: ${webA.one_time.map(o => `${o.name} ${money(o.amount)} @+${o.month}mo`).join(", ")}` : "");
  const assumptions = `
    <div style="margin-top:14px;border-top:1px solid #E3E8E5;padding-top:12px;">
      <div style="font-size:11px;font-weight:700;letter-spacing:.06em;color:#8A918C;margin-bottom:8px;">ASSUMPTIONS · edit app/forecast_config.json</div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px 22px;font-size:11.5px;color:#5B635E;line-height:1.55;">
        <div><b style="color:#00B050;">CFO new clients</b><br>${cfoLines.join("<br>") || "—"}<br><span style="color:#B7791F;">Roll-off:</span> ${rollLines.join("; ") || "none"}</div>
        <div><b style="color:#2563EB;">Web</b><br>Live base ${money(f.web_base)}/mo (care plans)<br>${webLine}</div>
        <div><b style="color:#F59E0B;">Recruiting (gross)</b><br>${recLines.join("<br>") || "—"}<br><span style="color:#8A918C;">Gross retained installments — Tim's commission (~50–60%) not netted here.</span></div>
      </div>
    </div>`;

  el.innerHTML = `
    <div class="card" style="margin-bottom:16px;padding:18px 22px;">
      <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;flex-wrap:wrap;gap:6px;">
        <div style="font-size:13px;font-weight:800;letter-spacing:.04em;color:#0F1311;">EARNINGS POTENTIAL · NEXT 6 MONTHS</div>
        <div style="font-size:11px;color:#8A918C;">CFO + Web recurring · Recruiting + Web one-time · live CRM base · excl. Dakota referral list</div>
      </div>
      <div class="tiles" style="margin-bottom:16px;">${kpis}</div>
      <div style="height:260px;"><canvas id="chart-forecast"></canvas></div>
      ${table}
      ${assumptions}
    </div>`;

  upsertChart("chart-forecast", {
    type: "bar",
    data: {
      labels,
      datasets: [
        { label: "CFO MRR", data: months.map(m => m.cfo_mrr), backgroundColor: "#00B050", stack: "e", borderRadius: 2 },
        { label: "Web MRR", data: months.map(m => m.web_mrr), backgroundColor: "#2563EB", stack: "e", borderRadius: 2 },
        { label: "Web builds (1×)", data: months.map(m => m.web_onetime), backgroundColor: "#93C5FD", stack: "e", borderRadius: 2 },
        { label: "Recruiting (1×)", data: months.map(m => m.recruiting_onetime), backgroundColor: "#F59E0B", stack: "e", borderRadius: 2 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: true, position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, color: "#5B635E" } },
        tooltip: {
          callbacks: {
            label: c => `${c.dataset.label}: ${_fmtMrr(c.parsed.y)}`,
            footer: items => "Total: " + _fmtMrr(items.reduce((s, i) => s + i.parsed.y, 0)),
          },
        },
      },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { color: "#5B635E", font: { size: 11 } } },
        y: { stacked: true, beginAtZero: true, grid: { color: "#E3E8E5" }, ticks: { color: "#5B635E", font: { size: 10 }, callback: v => "$" + (v / 1000) + "k" } },
      },
    },
  });
}

// ───── charts ─────
function upsertChart(canvasId, config) {
  if (state.charts[canvasId]) state.charts[canvasId].destroy();
  const ctx = document.getElementById(canvasId).getContext("2d");
  state.charts[canvasId] = new Chart(ctx, config);
}

async function loadSpendChart() {
  const { rows } = await api("/api/timeseries/spend?days=30");
  // pivot: days x providers
  const days = [...new Set(rows.map(r => r.day))].sort();
  const providers = [...new Set(rows.map(r => r.provider))];
  const datasets = providers.map((p, i) => ({
    label: p,
    data: days.map(d => {
      const rec = rows.find(r => r.day === d && r.provider === p);
      return rec ? Number(rec.usd) : 0;
    }),
    backgroundColor: PALETTE[i % PALETTE.length],
    borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 1,
  }));
  if (!days.length) {
    datasets.push({ label: "no data yet", data: [0], backgroundColor: "#1E2D45" });
    days.push(new Date().toISOString().slice(0, 10));
  }
  upsertChart("chart-spend", {
    type: "bar",
    data: { labels: days, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, color: "#4E6079" } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 10, color: "#4E6079" } },
        y: { stacked: true, beginAtZero: true, grid: { color: "#1E2D45" }, ticks: { font: { size: 10 }, color: "#4E6079", callback: v => "$" + v } },
      },
    },
  });
}

async function loadActivityChart() {
  const { rows } = await api("/api/timeseries/activity?hours=24");
  const hours = [...new Set(rows.map(r => r.hour))].sort();
  const skills = [...new Set(rows.map(r => r.skill_tag))];
  const datasets = skills.map((s, i) => ({
    label: prettyProject(s) || "untagged",
    data: hours.map(h => {
      const rec = rows.find(r => r.hour === h && r.skill_tag === s);
      return rec ? rec.calls : 0;
    }),
    backgroundColor: PALETTE[i % PALETTE.length],
    borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 1, fill: true, tension: 0.25,
  }));
  if (!hours.length) { datasets.push({ label: "no activity", data: [0], backgroundColor: "#1E2D45" }); hours.push(""); }
  upsertChart("chart-activity", {
    type: "line",
    data: { labels: hours.map(h => h.slice(11, 16)), datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: datasets.length > 1, position: "bottom", labels: { boxWidth: 10, font: { size: 11 }, color: "#4E6079" } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 12, color: "#4E6079" } },
        y: { beginAtZero: true, grid: { color: "#1E2D45" }, ticks: { font: { size: 10 }, color: "#4E6079", precision: 0 } },
      },
    },
  });
}

async function loadSkillBreakdown() {
  const { rows } = await api("/api/breakdown/session?days=30");
  const labels = rows.map(r => { const l = String(r.label || ""); return l.length > 36 ? l.slice(0, 35) + "…" : l; });
  const data = rows.map(r => Number(r.usd));
  upsertChart("chart-skill", {
    type: "doughnut",
    data: {
      labels: labels.length ? labels : ["no data"],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: labels.length ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : ["#1E2D45"],
        borderWidth: 2, borderColor: "#0F1623",
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { display: true, position: "right", labels: { boxWidth: 10, font: { size: 11 }, color: "#94A3B8" } } },
    },
  });
}

async function loadModelBreakdown() {
  const { rows } = await api("/api/breakdown/model?days=30");
  const labels = rows.map(r => r.model);
  const data = rows.map(r => Number(r.usd));
  upsertChart("chart-model", {
    type: "doughnut",
    data: {
      labels: labels.length ? labels : ["no data"],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: labels.length ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : ["#1E2D45"],
        borderWidth: 2, borderColor: "#0F1623",
      }],
    },
    options: {
      responsive: true, maintainAspectRatio: false, cutout: "62%",
      plugins: { legend: { display: true, position: "right", labels: { boxWidth: 10, font: { size: 11 }, color: "#94A3B8" } } },
    },
  });
}

// ───── Claude Code tab ─────
const fmtTokens = n => { if (n == null) return "—"; if (n > 1e9) return (n / 1e9).toFixed(2) + "B"; if (n > 1e6) return (n / 1e6).toFixed(1) + "M"; if (n > 1e3) return (n / 1e3).toFixed(1) + "K"; return String(n); };

async function loadClaudeCodeTiles() {
  const s = await api("/api/claude-code/summary");
  const el = document.getElementById("cc-tiles");
  const plan = s.plan || {};
  const tokens = s.tokens || {};
  const cacheHit = tokens.cache_hit_rate != null ? (tokens.cache_hit_rate * 100).toFixed(1) + "%" : "—";
  const planMonthly = plan.monthly_usd || 200;
  const mtdPctOfPlan = planMonthly ? Math.min(100, (s.month.usd / planMonthly) * 100) : 0;
  const leverage = plan.leverage_x || 0;
  const savings = plan.savings_mtd || 0;
  const effPerTurn = plan.effective_usd_per_turn || 0;
  const effPerMtok = plan.effective_usd_per_mtok || 0;
  const apiMtd = plan.api_equivalent_mtd || 0;

  el.innerHTML = [
    `<div class="tile">
       <div class="label">Claude Max plan</div>
       <div class="value">${fmtUsd(planMonthly)}</div>
       <div class="sub">flat · ${mtdPctOfPlan.toFixed(0)}% of month consumed</div>
     </div>`,
    `<div class="tile">
       <div class="label">Your leverage (MTD)</div>
       <div class="value">${leverage.toFixed(1)}×</div>
       <div class="sub">API-equivalent ${fmtUsd(apiMtd)} ÷ ${fmtUsd(planMonthly)}</div>
     </div>`,
    `<div class="tile">
       <div class="label">Saved vs API (MTD)</div>
       <div class="value">${fmtUsd(savings)}</div>
       <div class="sub">what you'd owe pay-as-you-go</div>
     </div>`,
    `<div class="tile">
       <div class="label">API-equiv — last 7 days</div>
       <div class="value">${fmtUsd(s.week.api_usd || 0)}</div>
       <div class="sub">${s.week.turns} turns · plan share ${fmtUsd(s.week.usd)}</div>
     </div>`,
    `<div class="tile">
       <div class="label">Effective $/turn</div>
       <div class="value">${fmtUsd(effPerTurn)}</div>
       <div class="sub">${fmtUsd(planMonthly)} ÷ ${s.month.turns} MTD turns</div>
     </div>`,
    `<div class="tile">
       <div class="label">Effective $/M tokens</div>
       <div class="value">${fmtUsd(effPerMtok)}</div>
       <div class="sub">your blended rate · cache hit ${cacheHit}</div>
     </div>`,
  ].join("");
}

async function loadClaudeCodeSpendChart() {
  const { rows } = await api("/api/claude-code/timeseries?days=30");
  const days = [...new Set(rows.map(r => r.day))].sort();
  const models = [...new Set(rows.map(r => r.model || "unknown"))];
  const datasets = models.map((m, i) => ({
    label: m,
    data: days.map(d => { const r = rows.find(x => x.day === d && (x.model || "unknown") === m); return r ? Number(r.usd) : 0; }),
    backgroundColor: PALETTE[i % PALETTE.length],
    borderColor: PALETTE[i % PALETTE.length],
    borderWidth: 1,
  }));
  if (!days.length) { datasets.push({ label: "no data", data: [0], backgroundColor: "#E5E7EB" }); days.push(""); }
  upsertChart("cc-chart-spend", {
    type: "bar",
    data: { labels: days, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 10 } },
        y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 }, callback: v => "$" + v.toFixed(2) } },
      },
    },
  });
}

async function loadClaudeCodeTokensChart() {
  const { rows } = await api("/api/claude-code/timeseries?days=30");
  const dayMap = {};
  rows.forEach(r => {
    if (!dayMap[r.day]) dayMap[r.day] = { in: 0, out: 0 };
    dayMap[r.day].in += r.tokens_in || 0;
    dayMap[r.day].out += r.tokens_out || 0;
  });
  const days = Object.keys(dayMap).sort();
  upsertChart("cc-chart-tokens", {
    type: "line",
    data: {
      labels: days,
      datasets: [
        { label: "Input (+cache)", data: days.map(d => dayMap[d].in), borderColor: PALETTE[0], backgroundColor: PALETTE[0] + "22", fill: true, tension: 0.3 },
        { label: "Output", data: days.map(d => dayMap[d].out), borderColor: PALETTE[4], backgroundColor: PALETTE[4] + "22", fill: true, tension: 0.3 },
      ],
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
      scales: {
        x: { grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 10 } },
        y: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => fmtTokens(v) } },
      },
    },
  });
}

function prettyProject(slug) {
  // Strip noisy Windows path encoding: drop leading "C--" then rest
  return String(slug || "").replace(/^C--/i, "").replace(/-/g, "/").replace(/^Users\/[^/]+\//, "~/").slice(0, 60);
}

async function loadClaudeCodeProjectChart() {
  const { rows } = await api("/api/claude-code/by-project?days=30");
  const labels = rows.map(r => prettyProject(r.project_slug));
  const data = rows.map(r => Number(r.usd));
  upsertChart("cc-chart-project", {
    type: "bar",
    data: {
      labels: labels.length ? labels : ["no data"],
      datasets: [{
        label: "$ spent",
        data: data.length ? data : [0],
        backgroundColor: labels.length ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : ["#E5E7EB"],
      }],
    },
    options: {
      indexAxis: "y",
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: {
        x: { beginAtZero: true, ticks: { font: { size: 10 }, callback: v => "$" + v.toFixed(2) } },
        y: { ticks: { font: { size: 10 } } },
      },
    },
  });
}

async function loadClaudeCodeModelChart() {
  const { rows } = await api("/api/claude-code/by-model?days=30");
  const labels = rows.map(r => r.model || "unknown");
  const data = rows.map(r => Number(r.usd));
  upsertChart("cc-chart-model", {
    type: "doughnut",
    data: {
      labels: labels.length ? labels : ["no data"],
      datasets: [{
        data: data.length ? data : [1],
        backgroundColor: labels.length ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : ["#E5E7EB"],
        borderWidth: 2, borderColor: "#FFFFFF",
      }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } } },
  });
}

async function loadClaudeCodeSessions() {
  const { rows } = await api("/api/claude-code/sessions?days=30&limit=15");
  const tbody = document.querySelector("#cc-sessions-table tbody");
  if (!rows.length) { tbody.innerHTML = '<tr><td colspan="7" class="muted center">No sessions yet. Click Rescan.</td></tr>'; return; }
  tbody.innerHTML = rows.map(r => `
    <tr>
      <td><code>${esc(r.session_id.slice(0, 8))}</code></td>
      <td class="muted">${esc(prettyProject(r.project_slug))}</td>
      <td>${r.turns}</td>
      <td><strong>${fmtUsd(r.usd)}</strong></td>
      <td class="muted">${fmtUsd(r.api_usd)}</td>
      <td class="muted">${fmtTime(r.first_ts)}</td>
      <td class="muted">${fmtTime(r.last_ts)}</td>
    </tr>`).join("");
}

async function loadClaudeCode() {
  await Promise.all([
    loadClaudeCodeTiles(), loadClaudeCodeSpendChart(), loadClaudeCodeTokensChart(),
    loadClaudeCodeProjectChart(), loadClaudeCodeModelChart(), loadClaudeCodeSessions(),
  ]);
}

document.getElementById("cc-rescan").onclick = async (ev) => {
  ev.target.disabled = true;
  ev.target.textContent = "Scanning…";
  try {
    const r = await api("/api/claude-code/scan", { method: "POST", body: "{}" });
    document.getElementById("cc-scan-status").textContent = `scanned ${r.files} files · ${r.inserted} new turns`;
    await loadClaudeCode();
  } catch (e) { alert(`Rescan failed: ${e.message}`); }
  finally { ev.target.disabled = false; ev.target.textContent = "Rescan now"; }
};

// ───── skills panel ─────
async function triggerSkill(skillId, writeAction, btn) {
  btn.disabled = true;
  try {
    let nonce = null;
    if (writeAction) {
      if (!confirm(`Write action: ${skillId}. This touches real data. Proceed?`)) { btn.disabled = false; return; }
      const n = await api(`/api/skills/${encodeURIComponent(skillId)}/nonce`, { method: "POST", body: "{}" });
      nonce = n.nonce;
      if (!confirm(`Confirm trigger ${skillId}? (nonce expires in 30s)`)) { btn.disabled = false; return; }
    }
    const r = await api(`/api/skills/${encodeURIComponent(skillId)}/trigger`, { method: "POST", body: JSON.stringify({ nonce }) });
    alert(`${skillId}: ${r.status || (r.ok ? "ok" : "failed")}`);
  } catch (e) {
    alert(`Trigger failed: ${e.message}`);
  } finally {
    btn.disabled = false; loadJobs();
  }
}
window.triggerSkill = triggerSkill;

function renderSkills() {
  const running = new Set(state.runningSkills || []);
  const grid = document.getElementById("skills-grid");
  const filtered = state.activeFilter === "all" ? state.skills : state.skills.filter(s => s.category === state.activeFilter);
  if (!filtered.length) { grid.innerHTML = '<div class="muted center">No skills in this category.</div>'; return; }
  grid.innerHTML = filtered.map(s => {
    const isRun = running.has(s.id) || running.has(s.label);
    const viewOnly = s.view_only;
    return `
      <div class="skill-card${isRun ? ' running' : ''}${viewOnly ? ' view-only' : ''}">
        <div class="top">
          <div>
            <div class="name">${esc(s.label)}${isRun ? ' <span class="badge ok">running</span>' : ''}</div>
            <div class="id">${esc(s.id)}</div>
          </div>
          <div class="tags">
            <span class="badge cat">${esc(s.category)}</span>
            ${viewOnly ? '<span class="badge view">via CLI</span>' : (s.write_action ? '<span class="badge write">write</span>' : '<span class="badge read">read</span>')}
          </div>
        </div>
        <div class="desc">${esc(s.description)}</div>
        <div class="actions">
          ${viewOnly ? '<span class="muted" style="font-size:11px">Invoke via Claude Code</span>' :
            `<button onclick="triggerSkill('${esc(s.id)}', ${s.write_action}, this)">Trigger</button>`}
        </div>
      </div>`;
  }).join("");
}

async function loadSkills() {
  const { registry, processes } = await api("/api/skills");
  state.skills = registry;
  state.runningSkills = processes.map(p => p.skill);
  document.getElementById("skills-count").textContent = `${registry.filter(s => !s.view_only).length} controllable · ${registry.filter(s => s.view_only).length} via CLI · ${processes.length} currently running`;
  renderSkills();
}

document.querySelectorAll(".pill[data-filter]").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".pill[data-filter]").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    state.activeFilter = btn.dataset.filter;
    renderSkills();
  };
});

// ───── jobs + schedules ─────
async function loadJobs() {
  const jtb = document.querySelector("#jobs-table tbody");
  if (!jtb) return;
  const { recent_runs, task_scheduler } = await api("/api/jobs");
  if (!recent_runs.length) { jtb.innerHTML = '<tr><td colspan="5" class="muted center">No runs yet.</td></tr>'; }
  else {
    jtb.innerHTML = recent_runs.map(r => `
      <tr>
        <td>${esc(r.source)}</td>
        <td>${esc(r.job_id)}</td>
        <td>${fmtTime(r.started_at)}</td>
        <td><span class="badge ${r.status === 'ok' ? 'ok' : r.status === 'failed' || r.status === 'error' ? 'failed' : ''}">${esc(r.status)}</span></td>
        <td class="muted">${esc((r.notes || "").slice(0, 80))}</td>
      </tr>`).join("");
  }
  const stb = document.querySelector("#schedules-table tbody");
  const rows = [];
  task_scheduler.forEach(t => rows.push(`<tr><td>task-scheduler</td><td>${esc(t.name)}</td><td>${esc(t.next_run)}</td><td>${esc(t.status)}</td></tr>`));
  stb.innerHTML = rows.length ? rows.join("") : '<tr><td colspan="4" class="muted center">No schedules found.</td></tr>';
}

// ───── HubSpot tab ─────
const HS_STAGE_COLORS = {
  subscriber: "#6B7280", lead: "#B45309", marketingqualifiedlead: "#4F46E5",
  salesqualifiedlead: "#0891B2", opportunity: "#047857", customer: "#059669",
};

async function loadHubspot() {
  const tilesEl = document.getElementById("hs-tiles");
  tilesEl.innerHTML = '<div class="tile placeholder">Loading HubSpot…</div>';
  let d;
  try { d = await api("/api/hubspot/summary"); }
  catch (e) {
    tilesEl.innerHTML = `<div class="tile"><div class="label">HubSpot</div><div class="value">error</div><div class="sub">${esc(e.message)}</div></div>`;
    return;
  }
  if (!d.connected) {
    tilesEl.innerHTML = '<div class="tile"><div class="label">HubSpot</div><div class="value">not connected</div><div class="sub">HUBSPOT_PRIVATE_APP_TOKEN missing</div></div>';
    return;
  }
  const ct = d.contacts || {};
  const cd = d.cold_dial || {};
  const dl = d.deals || {};
  tilesEl.innerHTML = [
    `<div class="tile"><div class="label">Total contacts</div><div class="value">${(ct.total||0).toLocaleString()}</div><div class="sub">in HubSpot CRM</div></div>`,
    `<div class="tile"><div class="label">Retry queue</div><div class="value">${(cd.retry_queue||0).toLocaleString()}</div><div class="sub">ct_next_call_date set</div></div>`,
    `<div class="tile"><div class="label">DNC</div><div class="value">${(cd.do_not_call||0).toLocaleString()}</div><div class="sub">ct_do_not_call = true</div></div>`,
    `<div class="tile"><div class="label">Wrong number</div><div class="value">${(cd.wrong_number||0).toLocaleString()}</div><div class="sub">ct_wrong_number = true</div></div>`,
    `<div class="tile"><div class="label">Deals</div><div class="value">${(dl.total||0).toLocaleString()}</div><div class="sub">total in pipeline</div></div>`,
  ].join("");

  // Deal pipeline table
  const pipelineRows = (d.deal_pipeline || []).sort((a, b) => b.amount - a.amount);
  document.getElementById("hs-deals-count").textContent = `${pipelineRows.length} stages`;
  document.querySelector("#hs-pipeline-table tbody").innerHTML = pipelineRows.length
    ? pipelineRows.map(p => `
        <tr>
          <td>${esc(p.stage)}</td>
          <td class="num">${p.count}</td>
          <td class="num">${p.amount ? "$" + p.amount.toLocaleString(undefined, {minimumFractionDigits:0}) : "—"}</td>
        </tr>`).join("")
    : '<tr><td colspan="3" class="muted center">No deals found.</td></tr>';

  // Stage doughnut
  const byStage = ct.by_stage || {};
  const stageLabels = Object.keys(byStage).filter(k => byStage[k] > 0);
  const stageData = stageLabels.map(k => byStage[k]);
  upsertChart("hs-chart-stage", {
    type: "doughnut",
    data: {
      labels: stageLabels.length ? stageLabels : ["no data"],
      datasets: [{ data: stageData.length ? stageData : [1], backgroundColor: stageLabels.length ? stageLabels.map(l => HS_STAGE_COLORS[l] || "#6B7280") : ["#E5E7EB"], borderWidth: 2, borderColor: "#fff" }],
    },
    options: { responsive: true, maintainAspectRatio: false, cutout: "58%", plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } } },
  });

  // Recent contacts
  const contacts = d.recent_contacts || [];
  document.querySelector("#hs-contacts-table tbody").innerHTML = contacts.length
    ? contacts.map(c => `
        <tr>
          <td>${esc(c.name)}</td>
          <td class="muted">${esc(c.email)}</td>
          <td>${esc(c.stage || "—")}</td>
          <td>${c.next_call ? esc(c.next_call.slice(0,10)) : "—"}</td>
          <td class="muted">${c.created ? new Date(c.created).toLocaleDateString() : "—"}</td>
        </tr>`).join("")
    : '<tr><td colspan="5" class="muted center">No contacts returned.</td></tr>';
}

document.getElementById("hs-refresh").onclick = loadHubspot;

// ───── Instantly tab ─────
async function loadInstantly() {
  const tilesEl = document.getElementById("inst-tiles");
  tilesEl.innerHTML = '<div class="tile placeholder">Loading Instantly…</div>';
  let d;
  try { d = await api("/api/instantly/summary"); }
  catch (e) {
    tilesEl.innerHTML = `<div class="tile"><div class="label">Instantly</div><div class="value">error</div><div class="sub">${esc(e.message)}</div></div>`;
    return;
  }
  if (!d.connected) {
    tilesEl.innerHTML = '<div class="tile"><div class="label">Instantly</div><div class="value">not connected</div><div class="sub">INSTANTLY_API_KEY missing</div></div>';
    return;
  }
  const t = d.totals || {};
  const openRate = t.sent ? (t.opened / t.sent * 100).toFixed(1) : "0";
  const replyRate = t.sent ? (t.replied / t.sent * 100).toFixed(2) : "0";
  const bounceRate = t.sent ? (t.bounced / t.sent * 100).toFixed(2) : "0";
  tilesEl.innerHTML = [
    `<div class="tile"><div class="label">Campaigns</div><div class="value">${(d.campaigns||[]).length}</div><div class="sub">total</div></div>`,
    `<div class="tile"><div class="label">Total leads</div><div class="value">${(t.leads||0).toLocaleString()}</div><div class="sub">across all campaigns</div></div>`,
    `<div class="tile"><div class="label">Sent (30d)</div><div class="value">${(t.sent||0).toLocaleString()}</div><div class="sub">emails sent</div></div>`,
    `<div class="tile"><div class="label">Open rate</div><div class="value">${openRate}%</div><div class="sub">${(t.opened||0).toLocaleString()} opens</div></div>`,
    `<div class="tile"><div class="label">Reply rate</div><div class="value">${replyRate}%</div><div class="sub">${(t.replied||0).toLocaleString()} replies</div></div>`,
    `<div class="tile"><div class="label">Bounce rate</div><div class="value">${bounceRate}%</div><div class="sub">${(t.bounced||0).toLocaleString()} bounces</div></div>`,
  ].join("");

  // Per-campaign table
  const campaigns = d.per_campaign || [];
  document.querySelector("#inst-campaigns-table tbody").innerHTML = campaigns.length
    ? campaigns.map(c => {
        const STAT = { 0: "draft", 1: "active", 2: "paused", 3: "completed", 4: "running" };
        const label = STAT[c.status] || (c.status == null ? "unknown" : String(c.status));
        const badge = c.status === 1 ? "ok" : c.status === 2 || c.status === 0 ? "" : c.status === 3 || c.status === 4 ? "ok" : "failed";
        return `<tr>
          <td>${esc(c.name)}</td>
          <td><span class="badge ${badge}">${esc(label)}</span></td>
          <td class="num">${(c.leads||0).toLocaleString()}</td>
          <td class="num">${(c.sent||0).toLocaleString()}</td>
          <td class="num">${(c.opened||0).toLocaleString()}</td>
          <td class="num" style="color:${c.replied?"#047857":""}">${(c.replied||0).toLocaleString()}</td>
          <td class="num" style="color:${c.bounced?"#B91C1C":""}">${(c.bounced||0).toLocaleString()}</td>
          <td class="num">${c.open_rate}%</td>
          <td class="num" style="color:${c.reply_rate>0?"#047857":""}">${c.reply_rate}%</td>
          <td class="num" style="color:${c.bounce_rate>2?"#B91C1C":""}">${c.bounce_rate}%</td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="10" class="muted center">No campaign analytics yet.</td></tr>';

  // Warmup accounts table
  const accounts = d.accounts || [];
  document.getElementById("inst-accounts-count").textContent = `${accounts.length} accounts`;
  document.querySelector("#inst-accounts-table tbody").innerHTML = accounts.length
    ? accounts.map(a => {
        const score = a.warmup_score;
        const scoreColor = score == null ? "" : score >= 85 ? "color:#047857" : score >= 70 ? "color:#B45309" : "color:#B91C1C";
        return `<tr>
          <td>${esc(a.email||"—")}</td>
          <td>${a.warmup_enabled ? '<span class="badge ok">yes</span>' : '<span class="badge">no</span>'}</td>
          <td style="${scoreColor};font-weight:600">${score != null ? score : "—"}</td>
          <td>${esc(a.status||"—")}</td>
          <td class="num">${a.daily_limit != null ? a.daily_limit : "—"}</td>
        </tr>`;
      }).join("")
    : '<tr><td colspan="5" class="muted center">No accounts found.</td></tr>';
}

document.getElementById("inst-refresh").onclick = loadInstantly;

// ───── coach ─────
async function loadCoach() {
  try {
    const [sum, j, rv] = await Promise.all([
      api("/api/coach/summary"),
      api("/api/coach/journal?limit=100"),
      api("/api/coach/reviews?limit=1"),
    ]);
    const tiles = document.getElementById("coach-tiles");
    tiles.innerHTML = [
      `<div class="tile"><div class="label">Journal entries</div><div class="value">${sum.journal_count ?? 0}</div><div class="sub">all time</div></div>`,
      `<div class="tile"><div class="label">Weekly reviews</div><div class="value">${sum.review_count ?? 0}</div><div class="sub">all time</div></div>`,
      `<div class="tile"><div class="label">Latest entry</div><div class="value">${sum.latest_journal ? esc(sum.latest_journal.date) : "—"}</div><div class="sub">${sum.latest_journal ? esc(sum.latest_journal.source) : "no entries"}</div></div>`,
      `<div class="tile"><div class="label">Latest review</div><div class="value">${sum.latest_review ? esc(sum.latest_review.week_start) : "—"}</div><div class="sub">${sum.latest_review ? "→ " + esc(sum.latest_review.week_end) : "not generated yet"}</div></div>`,
    ].join("");

    const reviews = rv.reviews || [];
    if (reviews.length) {
      const r = reviews[0];
      document.getElementById("coach-review-meta").textContent = `${r.week_start} → ${r.week_end} · ${r.model || ""}`;
      document.getElementById("coach-review-body").textContent = r.narrative;
    }

    const entries = j.entries || [];
    document.getElementById("coach-journal-count").textContent = `${entries.length} shown`;
    const tbody = document.querySelector("#coach-journal-table tbody");
    if (!entries.length) {
      tbody.innerHTML = '<tr><td colspan="3" class="muted center">No entries yet.</td></tr>';
    } else {
      tbody.innerHTML = entries.map(e => `
        <tr>
          <td>${esc(e.date)}</td>
          <td><span class="muted">${esc(e.source)}</span></td>
          <td style="white-space:pre-wrap;">${esc(e.text)}</td>
        </tr>`).join("");
    }
  } catch (err) {
    document.getElementById("coach-tiles").innerHTML =
      `<div class="tile"><div class="label">Coach</div><div class="value">error</div><div class="sub">${esc(err.message)}</div></div>`;
  }
}

document.getElementById("coach-entry-save").onclick = async () => {
  const ta = document.getElementById("coach-entry");
  const status = document.getElementById("coach-entry-status");
  const text = (ta.value || "").trim();
  if (!text) { status.textContent = "write something first"; return; }
  status.textContent = "saving…";
  try {
    await api("/api/coach/journal", { method: "POST", body: JSON.stringify({ text }) });
    ta.value = "";
    status.textContent = "saved";
    loadCoach();
    setTimeout(() => { status.textContent = ""; }, 2000);
  } catch (err) {
    status.textContent = `error: ${err.message}`;
  }
};

// ───── coach sub-tabs + plan dashboard ─────
document.querySelectorAll(".coach-subtab").forEach(btn => {
  btn.onclick = () => {
    document.querySelectorAll(".coach-subtab").forEach(t => t.classList.remove("active"));
    document.querySelectorAll(".coach-sub-pane").forEach(p => p.classList.remove("active"));
    btn.classList.add("active");
    document.querySelector(`.coach-sub-pane[data-coach-pane="${btn.dataset.coachSub}"]`).classList.add("active");
  };
});

function initCoachPlan() {
  const PLAN_START = new Date('2026-05-15T00:00:00');
  const RUNWAY_START = new Date('2026-04-23T00:00:00');
  const TODAY = new Date();

  const daysBetween = (a, b) => Math.floor((b - a) / 86400000);
  const fmtDate = d => d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
  const fmtShort = d => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const $ = id => document.getElementById(id);
  $('cp-today-date').textContent = fmtDate(TODAY);

  const isRunway = TODAY < PLAN_START;
  const runwayDay = daysBetween(RUNWAY_START, TODAY) + 1;
  const daysToLaunch = daysBetween(TODAY, PLAN_START);
  const runwayTotalDays = daysBetween(RUNWAY_START, PLAN_START);

  if (isRunway) {
    const pct = Math.max(0, Math.min(100, (runwayDay / runwayTotalDays) * 100));
    $('cp-runway-fill').style.width = pct + '%';
    $('cp-runway-mid-label').textContent = `Day ${runwayDay}/${runwayTotalDays} · ${daysToLaunch} days to launch`;
  } else {
    const dayNum = daysBetween(PLAN_START, TODAY) + 1;
    const pct = Math.min(100, (dayNum / 365) * 100);
    $('cp-runway-fill').style.width = pct + '%';
    $('cp-runway-start-label').textContent = 'May 15, 2026 · Launch';
    $('cp-runway-mid-label').textContent = `Day ${dayNum}/365`;
    $('cp-runway-end-label').textContent = 'May 14, 2027 · Goal';
  }

  // Baseline MRR is the LIVE CRM active MRR (set by loadOverviewGoal at boot),
  // so the Coach tab can never disagree with the CRM tab.
  const liveMrr = Math.round(window._activeMrr || 0) || 4000;
  const baseEl = document.getElementById('cp-baseline-mrr');
  if (baseEl) baseEl.textContent = '$' + liveMrr.toLocaleString();
  const baseNote = document.getElementById('cp-baseline-note');
  if (baseNote) baseNote.textContent = 'live from CRM · active MRR';

  const MS = [
    { name: 'Start', date: new Date('2026-05-15'), rev: 4000, phase: 'Ramp', monthIdx: 0 },
    { name: 'M1', date: new Date('2026-06-14'), rev: 7500, phase: 'Ramp → Validate', monthIdx: 1 },
    { name: 'M3', date: new Date('2026-08-14'), rev: 11500, phase: 'Validate', monthIdx: 3 },
    { name: 'M6', date: new Date('2026-11-14'), rev: 18000, phase: 'Systemize', monthIdx: 6 },
    { name: 'M9', date: new Date('2027-02-14'), rev: 23500, phase: 'Scale', monthIdx: 9 },
    { name: 'M12', date: new Date('2027-05-14'), rev: 39950, phase: 'Push to goal', monthIdx: 12 },
  ];
  const nextCheckpoint = () => { for (const m of MS) if (m.date > TODAY) return m; return MS[MS.length - 1]; };
  const nc = nextCheckpoint();

  const msCardEl = $('cp-milestones-cards');
  MS.forEach(m => {
    const div = document.createElement('div');
    div.className = 'cp-ms' + (m === nc ? ' current' : '');
    div.innerHTML = `<div class="cp-date">${m.name} · ${fmtShort(m.date)}</div><div class="cp-rev">$${m.rev.toLocaleString()}</div><div class="cp-phase">${m.phase}</div>`;
    msCardEl.appendChild(div);
  });

  if (isRunway) {
    $('cp-header-sub').textContent = `Pre-Launch Runway · Day ${runwayDay} of ${runwayTotalDays} · Launch ${fmtDate(PLAN_START)}`;
    $('cp-nstar-headline').textContent = `${daysToLaunch} days to launch`;
    $('cp-nstar-sub').textContent = 'Pre-launch runway: infrastructure + scripts + list. No outbound volume yet — warm-up + prep only.';
    $('cp-nstar-phase').textContent = 'Runway';
    $('cp-nstar-day').textContent = `Runway D${runwayDay}/${runwayTotalDays}`;
    $('cp-nstar-to-next').innerHTML = `${daysToLaunch} <span class="cp-pill ok">to May 15 launch</span>`;
    $('cp-nstar-next-target').textContent = '$4,000 MRR (Start baseline)';
    $('cp-activity-body').innerHTML = `
      <div class="cp-note" style="margin-top:0">Activity targets don't start until launch (May 15). Runway is infra + scripts + warm-up.</div>
      <div class="cp-row"><span class="cp-k">Email volume</span><span class="cp-v cp-pill neutral">paused until May 15</span></div>
      <div class="cp-row"><span class="cp-k">Cold calls</span><span class="cp-v cp-pill neutral">test dials only (≤10 total by May 6)</span></div>
      <div class="cp-row"><span class="cp-k">Soft-send</span><span class="cp-v cp-pill warn">20 contacts · Mon May 11</span></div>
      <div class="cp-row"><span class="cp-k">Delivery</span><span class="cp-v">Existing 8 CFO clients only</span></div>`;
  } else {
    const dayNum = daysBetween(PLAN_START, TODAY) + 1;
    const daysToNc = daysBetween(TODAY, nc.date);
    $('cp-header-sub').textContent = `Plan Day ${dayNum} of 365`;
    $('cp-nstar-headline').textContent = `Day ${dayNum}`;
    $('cp-nstar-sub').textContent = 'Live coaching — pull actuals from coach.db when the skill is wired up.';
    $('cp-nstar-phase').textContent = nc.phase;
    $('cp-nstar-day').textContent = `${dayNum}/365`;
    $('cp-nstar-to-next').textContent = `${daysToNc} days to ${nc.name}`;
    $('cp-nstar-next-target').textContent = `$${nc.rev.toLocaleString()}/mo at ${nc.name}`;
    $('cp-activity-body').innerHTML = `
      <div class="cp-row"><span class="cp-k">Emails (total)</span><span class="cp-v">150 · 38 CFO + 112 Web</span></div>
      <div class="cp-row"><span class="cp-k">Calls</span><span class="cp-v">100 dials · ~2 hr block</span></div>
      <div class="cp-row"><span class="cp-k">Follow-ups</span><span class="cp-v">10</span></div>
      <div class="cp-row"><span class="cp-k">Proposals</span><span class="cp-v">1 (Tue/Thu/Fri)</span></div>
      <div class="cp-row"><span class="cp-k">Delivery block</span><span class="cp-v">90 min</span></div>
      <div class="cp-note">Baseline M0–M3 · adjusts by phase · overridden by day_mode in Slack.</div>`;
  }

  const GATES = [
    { id: 'g1', label: '9 inboxes warm · reputation >85', due: 'May 13' },
    { id: 'g2', label: 'Bounce rate <5% in soft-send', due: 'May 11' },
    { id: 'g3', label: '>1,500 vetted leads loaded', due: 'May 2' },
    { id: 'g4', label: 'CloudTalk → HubSpot sync + power-dialer', due: 'Apr 28' },
    { id: 'g5', label: 'CRM lead_source column live', due: 'Apr 29' },
    { id: 'g6', label: 'CFO + Web scripts A/B finalized', due: 'May 6' },
    { id: 'g7', label: 'Reply-routing classification tested', due: 'May 11' },
  ];
  const savedGates = JSON.parse(localStorage.getItem('tkc-gates') || '{}');
  const gatesEl = $('cp-gates');
  GATES.forEach(g => {
    const cur = savedGates[g.id] || 'gray';
    const row = document.createElement('div');
    row.className = 'cp-gate ' + (cur === 'green' ? 'green' : cur === 'amber' ? 'amber' : cur === 'red' ? 'red' : '');
    row.innerHTML = `<span class="cp-dot"></span><span style="flex:1">${g.label}</span><span class="cp-due">due ${g.due}</span>`;
    row.onclick = () => {
      const cycle = { gray: 'green', green: 'amber', amber: 'red', red: 'gray' };
      savedGates[g.id] = cycle[savedGates[g.id] || 'gray'];
      localStorage.setItem('tkc-gates', JSON.stringify(savedGates));
      location.reload();
    };
    gatesEl.appendChild(row);
  });

  const W1_TODOS = [
    { id: 'w1a', label: 'Buy 3 outreach domains', due: 'Apr 25' },
    { id: 'w1b', label: 'Create 9 inboxes (3 per domain)', due: 'Apr 27' },
    { id: 'w1c', label: 'Set SPF + DKIM + DMARC on all domains', due: 'Apr 28' },
    { id: 'w1d', label: 'Verify CloudTalk → HubSpot 2-way sync + power-dialer mode', due: 'Apr 28' },
    { id: 'w1e', label: 'Start Instantly warm-up on all 9 inboxes', due: 'Apr 29' },
    { id: 'w1f', label: 'Ship CRM lead_source column', due: 'Apr 29' },
    { id: 'w1g', label: 'Draft v1 CFO script, Web script, call script', due: 'Apr 29' },
  ];
  const W2_TODOS = [
    { id: 'w2a', label: 'Warm-up reputation >70 avg', due: 'May 6' },
    { id: 'w2b', label: 'List QA pass 1 (5–10k → 2–3k vetted)', due: 'May 4' },
    { id: 'w2c', label: 'Test CloudTalk call-logging end-to-end (10 dials)', due: 'May 6' },
    { id: 'w2d', label: 'Finalize A/B script variants', due: 'May 5' },
    { id: 'w2e', label: 'Write 3 case studies', due: 'May 6' },
    { id: 'w2f', label: 'Lock positioning + offer copy', due: 'May 6' },
  ];
  const W3_TODOS = [
    { id: 'w3a', label: 'Final list vet', due: 'May 10' },
    { id: 'w3b', label: 'Soft-send: 20 contacts across 3 inboxes', due: 'Mon May 11' },
    { id: 'w3c', label: 'Implement Python logic in skill tool stubs', due: 'May 13' },
    { id: 'w3d', label: 'Sign 1–2 Sacred Partner MOUs', due: 'May 14' },
    { id: 'w3e', label: 'Go/no-go review — all 7 launch gates', due: 'May 13' },
  ];

  function parseDue(s, today) {
    const m = s.match(/(Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)\s+(\d+)/);
    if (!m) return today;
    const months = { Jan: 0, Feb: 1, Mar: 2, Apr: 3, May: 4, Jun: 5, Jul: 6, Aug: 7, Sep: 8, Oct: 9, Nov: 10, Dec: 11 };
    const year = months[m[1]] < 3 ? 2027 : 2026;
    return new Date(year, months[m[1]], parseInt(m[2]));
  }

  function currentRunwayWeek() {
    if (TODAY < new Date('2026-04-30')) return { n: 1, todos: W1_TODOS, label: 'W1 · Apr 23–29', focus: 'Infra: domains, inboxes, DNS, CloudTalk, lead_source', gate: 'Warm-up running · CloudTalk dial-test · lead_source live', endDate: new Date('2026-04-29') };
    if (TODAY < new Date('2026-05-07')) return { n: 2, todos: W2_TODOS, label: 'W2 · Apr 30–May 6', focus: 'List QA, A/B scripts, case studies, CloudTalk E2E', gate: 'Reputation >70 avg · CloudTalk logging live', endDate: new Date('2026-05-06') };
    return { n: 3, todos: W3_TODOS, label: 'W3 · May 7–14', focus: 'Final vet, soft-send May 11, tool logic, MOUs', gate: 'Reputation >85 · bounce <5% · all 7 launch gates green', endDate: new Date('2026-05-14') };
  }

  function renderTodoList(el, todos) {
    el.innerHTML = '';
    const saved = JSON.parse(localStorage.getItem('tkc-todos') || '{}');
    todos.forEach(t => {
      const li = document.createElement('li');
      if (saved[t.id]) li.classList.add('done');
      const due = parseDue(t.due, TODAY);
      const daysUntil = daysBetween(TODAY, due);
      let dueClass = '';
      if (daysUntil < 0) dueClass = ' now';
      else if (daysUntil <= 2) dueClass = ' soon';
      li.innerHTML = `<input type="checkbox" ${saved[t.id] ? 'checked' : ''}><span class="cp-label">${t.label}</span><span class="cp-due${dueClass}">due ${t.due}</span>`;
      li.onclick = (e) => {
        if (e.target.tagName !== 'INPUT') { li.querySelector('input').click(); return; }
        saved[t.id] = e.target.checked;
        localStorage.setItem('tkc-todos', JSON.stringify(saved));
        li.classList.toggle('done', e.target.checked);
      };
      el.appendChild(li);
    });
  }

  const wk = currentRunwayWeek();
  renderTodoList($('cp-daily-todos'), wk.todos);
  renderTodoList($('cp-week-todos'), wk.todos);

  const savedTodos = JSON.parse(localStorage.getItem('tkc-todos') || '{}');
  const open = wk.todos.filter(t => !savedTodos[t.id]);
  open.sort((a, b) => parseDue(a.due, TODAY) - parseDue(b.due, TODAY));
  const top3 = open.slice(0, 3);
  const top3El = $('cp-top3-list');
  if (top3.length === 0) {
    top3El.innerHTML = '<li style="color: var(--cp-accent)">This week\'s list is clear. Advance to next week or queue next stretch.</li>';
  } else {
    top3.forEach(t => {
      const li = document.createElement('li');
      li.innerHTML = `<span class="cp-label2">${t.label}</span> <span class="cp-due">due ${t.due}</span>`;
      top3El.appendChild(li);
    });
  }

  $('cp-week-label').textContent = wk.label;
  $('cp-week-sub').textContent = 'Pre-launch runway — infrastructure + reputation build. Plan-day activity targets start May 15.';
  $('cp-week-focus').textContent = wk.focus;
  $('cp-week-gate').textContent = wk.gate;
  $('cp-week-days-left').textContent = daysBetween(TODAY, wk.endDate) + ' days';

  $('cp-week-targets').innerHTML = `
    <div class="cp-row"><span class="cp-k">Baseline emails/wk</span><span class="cp-v">750 (150 × 5)</span></div>
    <div class="cp-row"><span class="cp-k">Baseline calls/wk</span><span class="cp-v">500 (100 × 5)</span></div>
    <div class="cp-row"><span class="cp-k">Positive replies / wk (CFO)</span><span class="cp-v">≥1 absolute · 0.4% rate</span></div>
    <div class="cp-row"><span class="cp-k">Positive replies / wk (Web)</span><span class="cp-v">≥2 absolute · 0.9% rate</span></div>
    <div class="cp-row"><span class="cp-k">Proposals sent / wk</span><span class="cp-v">3 (Tue/Thu/Fri)</span></div>
    <div class="cp-row"><span class="cp-k">Retro</span><span class="cp-v">Fri 16:30 CST · #turnkey-coach</span></div>
    <div class="cp-note">Thresholds kick in at M1 (Jun 14). During Ramp (M0–M1) absolute-count floors replace rate-based alerts to avoid small-N spam.</div>`;

  const PHASES = [
    { name: 'Ramp', range: 'M0–M1', start: 0, end: 1 },
    { name: 'Validate', range: 'M1–M3', start: 1, end: 3 },
    { name: 'Systemize', range: 'M3–M6', start: 3, end: 6 },
    { name: 'Scale', range: 'M6–M9', start: 6, end: 9 },
    { name: 'Push', range: 'M9–M12', start: 9, end: 12 },
  ];
  const phasesEl = $('cp-phases');
  const monthsIntoPlan = isRunway ? -1 : daysBetween(PLAN_START, TODAY) / 30;
  PHASES.forEach(p => {
    let cls = 'cp-phase-seg';
    if (!isRunway) {
      if (monthsIntoPlan >= p.start && monthsIntoPlan < p.end) cls += ' current';
      else if (monthsIntoPlan >= p.end) cls += ' past';
    }
    const div = document.createElement('div');
    div.className = cls;
    div.innerHTML = `<div class="cp-pname">${p.name}</div><div class="cp-prange">${p.range}</div>`;
    phasesEl.appendChild(div);
  });

  let partnerCount = parseInt(localStorage.getItem('tkc-partners') || '0');
  function renderPartners() {
    $('cp-partner-count').textContent = partnerCount;
    const pctM4 = Math.min(100, (partnerCount / 2) * 100);
    const pctM12 = Math.min(100, (partnerCount / 4) * 100);
    $('cp-partner-bar-m4').style.width = pctM4 + '%';
    $('cp-partner-bar-m12').style.width = pctM12 + '%';
    $('cp-partner-m4-note').textContent = `${partnerCount}/2 toward M4 target (Sep 14, 2026)`;
    $('cp-partner-m12-note').textContent = `${partnerCount}/4 toward M12 target (May 14, 2027)`;
  }
  $('cp-partner-plus').onclick = () => { partnerCount++; localStorage.setItem('tkc-partners', partnerCount); renderPartners(); };
  $('cp-partner-minus').onclick = () => { partnerCount = Math.max(0, partnerCount - 1); localStorage.setItem('tkc-partners', partnerCount); renderPartners(); };
  renderPartners();

  function drawChart() {
    const svg = $('cp-chart');
    svg.innerHTML = '';
    const W = 720, H = 240, PAD_L = 60, PAD_R = 20, PAD_T = 20, PAD_B = 36;
    const chartW = W - PAD_L - PAD_R, chartH = H - PAD_T - PAD_B;
    const maxY = 45000, maxX = 12;
    const x = m => PAD_L + (m / maxX) * chartW;
    const y = r => PAD_T + chartH - (r / maxY) * chartH;

    for (let g = 0; g <= 40000; g += 10000) {
      svg.insertAdjacentHTML('beforeend', `<line x1="${PAD_L}" y1="${y(g)}" x2="${W - PAD_R}" y2="${y(g)}" stroke="#262626" stroke-width="1"/>`);
      svg.insertAdjacentHTML('beforeend', `<text x="${PAD_L - 8}" y="${y(g) + 4}" fill="#8a8a8a" font-size="10" text-anchor="end">$${g / 1000}k</text>`);
    }
    MS.forEach(m => {
      svg.insertAdjacentHTML('beforeend', `<text x="${x(m.monthIdx)}" y="${H - PAD_B + 16}" fill="#8a8a8a" font-size="10" text-anchor="middle">${m.name}</text>`);
    });
    const points = MS.map(m => `${x(m.monthIdx)},${y(m.rev)}`).join(' ');
    const areaPoints = `${x(0)},${y(0)} ${points} ${x(12)},${y(0)}`;
    svg.insertAdjacentHTML('beforeend', `<polygon points="${areaPoints}" fill="rgba(0,230,118,0.08)"/>`);
    svg.insertAdjacentHTML('beforeend', `<polyline points="${points}" fill="none" stroke="#00E676" stroke-width="2.5"/>`);
    MS.forEach(m => {
      svg.insertAdjacentHTML('beforeend', `<circle cx="${x(m.monthIdx)}" cy="${y(m.rev)}" r="5" fill="#3a7bff" stroke="#0a0a0a" stroke-width="2"/>`);
      svg.insertAdjacentHTML('beforeend', `<text x="${x(m.monthIdx)}" y="${y(m.rev) - 12}" fill="#f5f5f5" font-size="11" text-anchor="middle" font-weight="600">$${(m.rev / 1000).toFixed(m.rev < 10000 ? 1 : 0)}k</text>`);
    });
    if (!isRunway) {
      const monthsIn = daysBetween(PLAN_START, TODAY) / 30;
      const mx = x(Math.min(12, monthsIn));
      svg.insertAdjacentHTML('beforeend', `<line x1="${mx}" y1="${PAD_T}" x2="${mx}" y2="${H - PAD_B}" stroke="#ffb020" stroke-width="1.5" stroke-dasharray="4,4"/>`);
      svg.insertAdjacentHTML('beforeend', `<text x="${mx}" y="${PAD_T - 4}" fill="#ffb020" font-size="10" text-anchor="middle">you are here</text>`);
    } else {
      const mx = x(0);
      svg.insertAdjacentHTML('beforeend', `<line x1="${mx}" y1="${PAD_T}" x2="${mx}" y2="${H - PAD_B}" stroke="#ffb020" stroke-width="1.5" stroke-dasharray="4,4"/>`);
      svg.insertAdjacentHTML('beforeend', `<text x="${mx + 4}" y="${PAD_T - 4}" fill="#ffb020" font-size="10" text-anchor="start">launch in ${daysToLaunch}d</text>`);
    }
  }
  drawChart();

  const SCENARIOS = {
    cons: { name: 'Conservative', cfo: 7.5, web: 24, m12: 12500, verdict: 'Misses goal by ~$27k/mo. Tripwire would have fired repeatedly. Plan requires intervention every quarter.', verdictClass: 'bad', funnel: { cfoReply: '0.3%', webReply: '0.5%', cfoClose: '20%', webClose: '20%', connect: '8%', call: '0.10%' } },
    mod: { name: 'Moderate (plan base)', cfo: 26, web: 93, m12: 39950, verdict: 'Plan on target. ~37% buffer against single-stage slippage on CFO funnel.', verdictClass: 'good', funnel: { cfoReply: '0.4%', webReply: '0.9%', cfoClose: '25%', webClose: '30%', connect: '12%', call: '0.36%' } },
    str: { name: 'Stretch', cfo: 94, web: 331, m12: 65000, verdict: 'Upside case. Capacity becomes the constraint long before conversion — would trigger capacity recalibration, not target.', verdictClass: 'mid', funnel: { cfoReply: '0.8%', webReply: '1.5%', cfoClose: '35%', webClose: '45%', connect: '18%', call: '1.26%' } },
  };
  function setScenario(key) {
    const s = SCENARIOS[key];
    $('cp-sc-cfo').innerHTML = s.cfo + '<span class="cp-unit">gross</span>';
    $('cp-sc-web').innerHTML = s.web + '<span class="cp-unit">gross</span>';
    $('cp-sc-m12').innerHTML = '$' + s.m12.toLocaleString() + '<span class="cp-unit">/mo</span>';
    const v = $('cp-sc-verdict');
    v.className = 'cp-verdict ' + s.verdictClass;
    v.textContent = s.verdict;
    $('cp-sc-funnel').innerHTML = `
      <tr><td>Reply +</td><td class="cp-num">${s.funnel.cfoReply}</td><td class="cp-num">${s.funnel.webReply}</td><td class="cp-num">—</td></tr>
      <tr><td>Proposal close</td><td class="cp-num">${s.funnel.cfoClose}</td><td class="cp-num">${s.funnel.webClose}</td><td class="cp-num">${s.funnel.cfoClose}</td></tr>
      <tr><td>Call connect</td><td class="cp-num">—</td><td class="cp-num">—</td><td class="cp-num">${s.funnel.connect}</td></tr>
      <tr><td>Call → close</td><td class="cp-num">—</td><td class="cp-num">—</td><td class="cp-num">${s.funnel.call}</td></tr>`;
    document.querySelectorAll('.cp-scenario-tabs button').forEach(b => b.classList.toggle('active', b.dataset.cpS === key));
  }
  document.querySelectorAll('.cp-scenario-tabs button').forEach(b => { b.onclick = () => setScenario(b.dataset.cpS); });
  setScenario('mod');

  const LEVER_IMPACT = { sdr: 5000, web: 3000, maint: 750, cfo: 1000 };
  function updateStress() {
    let proj = 39950;
    let missing = [];
    document.querySelectorAll('.cp-lever').forEach(l => {
      const cb = l.querySelector('input');
      const key = l.dataset.cpL;
      l.classList.toggle('off', !cb.checked);
      if (!cb.checked) { proj -= LEVER_IMPACT[key]; missing.push(key); }
    });
    $('cp-m12-proj').textContent = proj.toLocaleString();
    const pct = Math.max(0, Math.min(100, (proj / 39950) * 100));
    const bar = $('cp-m12-bar');
    bar.style.width = pct + '%';
    const v = $('cp-m12-verdict');
    if (missing.length === 0) {
      v.className = 'cp-verdict good';
      v.textContent = 'All 4 levers firing — plan on target.';
      bar.style.background = 'var(--cp-accent)';
    } else if (missing.length <= 2) {
      v.className = 'cp-verdict mid';
      v.textContent = `${missing.length} lever(s) missing. Lands $${(39950 - proj).toLocaleString()}/mo short of goal — Track B recalibration would propose adjusted target $${Math.round(proj / 500) * 500}/mo by M12 or extended runway.`;
      bar.style.background = 'var(--cp-warn)';
    } else {
      v.className = 'cp-verdict bad';
      v.textContent = `${missing.length} levers missing. Plan lands $${(39950 - proj).toLocaleString()}/mo short — forced Track B recalibration; adjusted goal likely $${Math.round(proj / 500) * 500}/mo.`;
      bar.style.background = 'var(--cp-danger)';
    }
  }
  document.querySelectorAll('.cp-lever input').forEach(cb => { cb.addEventListener('change', updateStress); });
  updateStress();

  document.querySelectorAll('.cp-tab').forEach(t => {
    t.onclick = () => {
      document.querySelectorAll('.cp-tab').forEach(x => x.classList.remove('active'));
      document.querySelectorAll('.cp-tab-pane').forEach(x => x.classList.add('cp-hidden'));
      t.classList.add('active');
      $('cp-tab-' + t.dataset.cpTab).classList.remove('cp-hidden');
    };
  });
}

// ───── lead gen ─────
const LG_STATUS_COLORS = {
  new: "#6B7280", pending_verify: "#B45309", role_filtered: "#9CA3AF",
  valid: "#047857", invalid: "#991B1B", catch_all: "#B45309", unknown: "#6B7280",
  pushed: "#4F46E5", sent: "#0891B2", replied: "#047857",
  bounced: "#991B1B", unsubscribed: "#DB2777", suppressed: "#1F2937",
};

function fmtIso(ts) {
  if (!ts) return "—";
  try { return new Date(ts).toLocaleString(); } catch { return ts; }
}

async function loadLeadGen() {
  let s;
  try { s = await api("/api/lead-gen/summary"); }
  catch (e) {
    document.getElementById("lg-tiles").innerHTML = `<div class="tile"><div class="label">Error</div><div class="value">—</div><div class="sub">${esc(e.message)}</div></div>`;
    return;
  }
  if (!s.db_exists) {
    document.getElementById("lg-tiles").innerHTML = `<div class="tile"><div class="label">master.db</div><div class="value">missing</div><div class="sub">${esc(s.db_path)}</div></div>`;
    return;
  }
  const budgetPct = s.budget_cap_today ? Math.round((s.budget_used_today / s.budget_cap_today) * 100) : 0;
  const tiles = [
    `<div class="tile"><div class="label">Total leads</div><div class="value">${s.total_leads.toLocaleString()}</div><div class="sub">in master.db</div></div>`,
    `<div class="tile"><div class="label">Scraped today</div><div class="value">${s.scraped_today.toLocaleString()}</div><div class="sub">last 24h UTC</div></div>`,
    `<div class="tile"><div class="label">Pending verify</div><div class="value">${s.pending_verify.toLocaleString()}</div><div class="sub">awaiting Reoon</div></div>`,
    `<div class="tile"><div class="label">Verified valid</div><div class="value">${s.valid.toLocaleString()}</div><div class="sub">ready to push</div></div>`,
    `<div class="tile"><div class="label">Pushed to Instantly</div><div class="value">${s.pushed.toLocaleString()}</div><div class="sub">sent + replied + bounced</div></div>`,
    `<div class="tile"><div class="label">Replies</div><div class="value">${s.replies.toLocaleString()}</div><div class="sub">bounces: ${s.bounces}</div></div>`,
    `<div class="tile"><div class="label">Suppression</div><div class="value">${s.suppressed.toLocaleString()}</div><div class="sub">email + domain</div></div>`,
    `<div class="tile"><div class="label">Budget today</div><div class="value">${s.budget_used_today} / ${s.budget_cap_today || "—"}</div><div class="sub">${budgetPct}% of cap · listener HB ${s.latest_listener_heartbeat ? fmtIso(s.latest_listener_heartbeat) : "—"}</div></div>`,
  ];
  document.getElementById("lg-tiles").innerHTML = tiles.join("");

  // daily stacked
  try {
    const { rows } = await api("/api/lead-gen/by-source-daily?days=14");
    const days = [...new Set(rows.map(r => r.day))].sort();
    const sources = [...new Set(rows.map(r => r.source))];
    const datasets = sources.map((src, i) => ({
      label: src, data: days.map(d => {
        const rec = rows.find(r => r.day === d && r.source === src);
        return rec ? rec.n : 0;
      }),
      backgroundColor: PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length], borderWidth: 1,
    }));
    if (!days.length) { datasets.push({ label: "no scrapes yet", data: [0], backgroundColor: "#E5E7EB" }); days.push(""); }
    upsertChart("lg-chart-daily", {
      type: "bar", data: { labels: days, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 14 } },
          y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 } },
        },
      },
    });
  } catch {}

  // status doughnut
  try {
    const { rows } = await api("/api/lead-gen/status-breakdown");
    const labels = rows.map(r => r.status);
    const data = rows.map(r => r.n);
    const bg = labels.map((l, i) => LG_STATUS_COLORS[l] || PALETTE[i % PALETTE.length]);
    upsertChart("lg-chart-status", {
      type: "doughnut",
      data: { labels: labels.length ? labels : ["no leads"], datasets: [{ data: data.length ? data : [1], backgroundColor: labels.length ? bg : ["#E5E7EB"] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } } },
    });
  } catch {}

  // source doughnut
  try {
    const { rows } = await api("/api/lead-gen/source-breakdown");
    const labels = rows.map(r => r.source);
    const data = rows.map(r => r.n);
    upsertChart("lg-chart-source", {
      type: "doughnut",
      data: { labels: labels.length ? labels : ["no leads"], datasets: [{ data: data.length ? data : [1], backgroundColor: labels.length ? labels.map((_, i) => PALETTE[i % PALETTE.length]) : ["#E5E7EB"] }] },
      options: { responsive: true, maintainAspectRatio: false, plugins: { legend: { position: "right", labels: { boxWidth: 10, font: { size: 11 } } } } },
    });
  } catch {}

  // budget table
  try {
    const { rows } = await api("/api/lead-gen/budget");
    const tbody = document.querySelector("#lg-budget-table tbody");
    const meta = document.getElementById("lg-budget-meta");
    const total = rows.find(r => r.source === "__total__");
    if (total) meta.textContent = `total ${total.used}/${total.cap || "—"}`;
    const body = rows.filter(r => r.source !== "__total__");
    if (!body.length && !total) { tbody.innerHTML = '<tr><td colspan="5" class="muted center">No budget rows today.</td></tr>'; return; }
    const render = r => {
      const pct = r.cap ? Math.round((r.used / r.cap) * 100) : null;
      return `<tr><td>${esc(r.source)}</td><td>${r.used}</td><td>${r.cap ?? "—"}</td><td>${pct == null ? "—" : pct + "%"}</td><td>${esc(r.benched_until || "—")}</td></tr>`;
    };
    tbody.innerHTML = (total ? render(total) : "") + body.map(render).join("");
  } catch {}

  // runs table
  try {
    const { rows } = await api("/api/lead-gen/runs?limit=25");
    const tbody = document.querySelector("#lg-runs-table tbody");
    document.getElementById("lg-runs-count").textContent = `${rows.length} runs`;
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="8" class="muted center">No runs logged yet.</td></tr>'; return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${esc(r.pipeline)}</td>
        <td>${fmtIso(r.started_at)}</td>
        <td>${r.finished_at ? fmtIso(r.finished_at) : '<span class="muted">HB ' + fmtIso(r.heartbeat_at) + '</span>'}</td>
        <td>${r.scraped}</td><td>${r.verified}</td><td>${r.pushed}</td>
        <td>${r.errors ? '<span style="color:#B91C1C">' + r.errors + '</span>' : 0}</td>
        <td class="muted">${esc(r.notes || "")}</td>
      </tr>`).join("");
  } catch {}

  // aggregate table + chart (respects period selection)
  try { loadLeadGenAggregate(); } catch {}

  // transitions table
  try {
    const { rows } = await api("/api/lead-gen/transitions?limit=20");
    const tbody = document.querySelector("#lg-transitions-table tbody");
    if (!rows.length) { tbody.innerHTML = '<tr><td colspan="5" class="muted center">No transitions logged.</td></tr>'; return; }
    tbody.innerHTML = rows.map(r => `
      <tr>
        <td>${fmtIso(r.transition_at)}</td>
        <td class="muted" title="${esc(r.lead_id)}">${esc((r.lead_id || "").slice(0, 10))}…</td>
        <td>${esc(r.from_state || "—")}</td>
        <td><strong>${esc(r.to_state || "—")}</strong></td>
        <td class="muted">${esc(r.reason || "")}</td>
      </tr>`).join("");
  } catch {}
}

let _lgPeriod = 30;
async function loadLeadGenAggregate() {
  const days = _lgPeriod;
  const meta = document.getElementById("lg-period-meta");
  if (meta) meta.textContent = `window: last ${days} day${days === 1 ? "" : "s"}`;
  const tbody = document.querySelector("#lg-agg-table tbody");
  const tfoot = document.querySelector("#lg-agg-table tfoot tr");
  try {
    const { rows } = await api(`/api/lead-gen/aggregate?days=${days}`);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="12" class="muted center">No leads in this window.</td></tr>';
      tfoot.innerHTML = '<td colspan="12" class="muted center">—</td>';
    } else {
      const totals = rows.reduce((acc, r) => {
        for (const k of Object.keys(r)) {
          if (k === "source") continue;
          acc[k] = (acc[k] || 0) + (r[k] || 0);
        }
        return acc;
      }, {});
      const pct = (v, d) => d ? ((v / d) * 100).toFixed(1) + "%" : "—";
      const fmt = n => (n || 0).toLocaleString();
      tbody.innerHTML = rows.map(r => `
        <tr>
          <td><strong>${esc(r.source)}</strong></td>
          <td class="num">${fmt(r.scraped)}</td>
          <td class="num" style="color:${r.valid ? "#047857" : ""}">${fmt(r.valid)}</td>
          <td class="num">${fmt(r.invalid)}</td>
          <td class="num">${fmt(r.catch_all)}</td>
          <td class="num">${fmt(r.role)}</td>
          <td class="num muted">${fmt(r.unverified)}</td>
          <td class="num">${fmt(r.pushed)}</td>
          <td class="num">${fmt(r.sent)}</td>
          <td class="num" style="color:${r.replied ? "#047857" : ""}">${fmt(r.replied)}</td>
          <td class="num" style="color:${r.bounced ? "#B91C1C" : ""}">${fmt(r.bounced)}</td>
          <td class="num">${pct(r.valid, r.scraped)}</td>
        </tr>`).join("");
      tfoot.innerHTML = `
        <td>TOTAL</td>
        <td class="num">${fmt(totals.scraped)}</td>
        <td class="num">${fmt(totals.valid)}</td>
        <td class="num">${fmt(totals.invalid)}</td>
        <td class="num">${fmt(totals.catch_all)}</td>
        <td class="num">${fmt(totals.role)}</td>
        <td class="num">${fmt(totals.unverified)}</td>
        <td class="num">${fmt(totals.pushed)}</td>
        <td class="num">${fmt(totals.sent)}</td>
        <td class="num">${fmt(totals.replied)}</td>
        <td class="num">${fmt(totals.bounced)}</td>
        <td class="num">${pct(totals.valid, totals.scraped)}</td>`;
    }
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="12" class="muted center">Failed: ${esc(e.message)}</td></tr>`;
  }

  // Stacked bar: scraped per bucket per source
  try {
    const { rows } = await api(`/api/lead-gen/aggregate-timeseries?days=${days}&metric=scraped`);
    const buckets = [...new Set(rows.map(r => r.bucket))].sort();
    const sources = [...new Set(rows.map(r => r.source))];
    const datasets = sources.map((src, i) => ({
      label: src,
      data: buckets.map(b => {
        const rec = rows.find(r => r.bucket === b && r.source === src);
        return rec ? rec.n : 0;
      }),
      backgroundColor: PALETTE[i % PALETTE.length],
      borderColor: PALETTE[i % PALETTE.length], borderWidth: 1,
    }));
    if (!buckets.length) { datasets.push({ label: "no data", data: [0], backgroundColor: "#E5E7EB" }); buckets.push(""); }
    upsertChart("lg-chart-aggregate", {
      type: "bar",
      data: { labels: buckets, datasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { position: "bottom", labels: { boxWidth: 10, font: { size: 11 } } } },
        scales: {
          x: { stacked: true, grid: { display: false }, ticks: { font: { size: 10 }, maxTicksLimit: 16 } },
          y: { stacked: true, beginAtZero: true, ticks: { font: { size: 10 }, precision: 0 } },
        },
      },
    });
  } catch {}
}

// ───── scheduled jobs tab ─────
async function loadScheduledJobs() {
  await Promise.all([loadScheduledTimeline(), loadScheduledList()]);
}

function sjFmtDay(dt) {
  return dt.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}
function sjFmtTime(dt) {
  return dt.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

async function loadScheduledTimeline() {
  const host = document.getElementById("sj-timeline");
  const tiles = document.getElementById("sj-tiles");
  host.innerHTML = '<div class="muted center" style="padding:20px;">Loading timeline…</div>';
  let data;
  try { data = await api("/api/schedules/timeline?days=7"); }
  catch (e) {
    host.innerHTML = `<div class="muted center">Failed: ${esc(e.message)}</div>`;
    return;
  }
  const now = new Date(data.now);
  const ws = new Date(data.window_start);
  const we = new Date(data.window_end);
  const totalMs = we - ws;

  // Build day-label strip (7 columns, aligned to visible forward window now..we)
  const forwardStart = now;
  const forwardMs = we - forwardStart;
  const dayCount = 7;
  const dayEdges = [];
  for (let i = 0; i <= dayCount; i++) {
    dayEdges.push(new Date(forwardStart.getTime() + (forwardMs * i / dayCount)));
  }

  // tiles
  const running = (data.jobs || []).filter(j => (j.status || "").toLowerCase() === "running");
  const upcoming24 = (data.occurrences || []).filter(o => {
    const t = new Date(o.start_iso);
    return t >= now && (t - now) < 24 * 3600 * 1000;
  }).length;
  const nextOcc = (data.occurrences || []).find(o => new Date(o.start_iso) >= now);
  const nextLabel = nextOcc ? `${nextOcc.name.replace(/^\\/, "")} · ${sjFmtTime(new Date(nextOcc.start_iso))}` : "—";
  const tilesHtml = [
    `<div class="tile"><div class="label">Tracked jobs</div><div class="value">${data.jobs.length}</div><div class="sub">schtasks</div></div>`,
    `<div class="tile"><div class="label">Running now</div><div class="value">${running.length}</div><div class="sub">${running.length ? esc(running[0].name) : "—"}</div></div>`,
    `<div class="tile"><div class="label">Occurrences next 24h</div><div class="value">${upcoming24}</div><div class="sub">across all jobs</div></div>`,
    `<div class="tile"><div class="label">Next trigger</div><div class="value" style="font-size:18px">${esc(nextLabel)}</div><div class="sub">${nextOcc ? esc(nextOcc.source) : ""}</div></div>`,
    `<div class="tile"><div class="label">Total occurrences · 7d</div><div class="value">${data.occurrences.length}</div><div class="sub">window ${sjFmtDay(forwardStart)} → ${sjFmtDay(we)}</div></div>`,
  ].join("");
  tiles.innerHTML = tilesHtml;

  // Group occurrences and blocks per job name
  const byJob = new Map();
  for (const job of data.jobs) byJob.set(job.name, { meta: job, events: [], blocks: [] });
  for (const o of data.occurrences) {
    if (!byJob.has(o.name)) byJob.set(o.name, { meta: { name: o.name, source: o.source }, events: [], blocks: [] });
    byJob.get(o.name).events.push(o);
  }
  for (const b of (data.blocks || [])) {
    if (!byJob.has(b.name)) byJob.set(b.name, { meta: { name: b.name, source: b.source }, events: [], blocks: [] });
    byJob.get(b.name).blocks.push(b);
  }
  // Sort jobs: running first, then by soonest next event, then name
  const jobRows = [...byJob.entries()].map(([name, v]) => {
    const futureEvents = v.events.map(e => new Date(e.start_iso)).filter(d => d >= now);
    const futureBlocks = (v.blocks || []).map(b => new Date(b.start_iso)).filter(d => d >= now);
    const future = [...futureEvents, ...futureBlocks];
    const nextAt = future.length ? Math.min(...future.map(d => d.getTime())) : Infinity;
    const isRunning = (v.meta.status || "").toLowerCase() === "running";
    return { name, nextAt, isRunning, ...v };
  }).sort((a, b) => {
    if (a.isRunning !== b.isRunning) return a.isRunning ? -1 : 1;
    if (a.nextAt !== b.nextAt) return a.nextAt - b.nextAt;
    return a.name.localeCompare(b.name);
  });

  // Header
  const headerCells = [];
  for (let i = 0; i < dayCount; i++) {
    const d = dayEdges[i];
    const isToday = d.toDateString() === now.toDateString();
    headerCells.push(`<div class="sj-day-label ${isToday ? "today" : ""}">${sjFmtDay(d)}</div>`);
  }
  let html = `
    <div class="sj-timeline-header">
      <div>Job</div>
      <div class="sj-day-grid">${headerCells.join("")}</div>
    </div>`;

  // Rows — cap bar rendering at 150 per row for perf
  const MAX_BARS = 150;
  for (const row of jobRows) {
    const ev = row.events;
    const stride = ev.length > MAX_BARS ? Math.ceil(ev.length / MAX_BARS) : 1;
    const events = ev.filter((_, i) => i % stride === 0).map(e => {
      const t = new Date(e.start_iso);
      const pct = ((t - ws) / totalMs) * 100;
      const cls = [
        "sj-bar",
        t < now ? "past" : "",
        row.isRunning && Math.abs(t - now) < 5 * 60 * 1000 ? "running" : "",
      ].filter(Boolean).join(" ");
      const title = `${row.name}\n${t.toLocaleString()}${e.command ? "\n" + e.command : ""}`;
      return `<div class="${cls}" style="left:${pct.toFixed(2)}%;" title="${esc(title)}"></div>`;
    }).join("");
    const blocks = (row.blocks || []).map(b => {
      const s = new Date(b.start_iso);
      const e = new Date(b.end_iso);
      const l = ((s - ws) / totalMs) * 100;
      const w = ((e - s) / totalMs) * 100;
      const past = e < now;
      const title = `${row.name}\n${s.toLocaleDateString()} · every ${b.step_min}min · ~${b.count} runs`;
      return `<div class="sj-block ${past ? "past" : ""}" style="left:${l.toFixed(2)}%; width:${w.toFixed(2)}%;" title="${esc(title)}"><span class="sj-block-label">every ${b.step_min}m</span></div>`;
    }).join("");
    const nowPct = ((now - ws) / totalMs) * 100;
    const srcTag = "sched";
    const totalRuns = row.events.length + (row.blocks || []).reduce((a, b) => a + b.count, 0);
    const countTag = totalRuns ? `<span class="sj-count-tag">${totalRuns}</span>` : "";
    html += `
      <div class="sj-row">
        <div class="sj-name" title="${esc(row.name)}">${esc(row.name.replace(/^\\/, ""))}<span class="sj-src">${srcTag}</span>${countTag}</div>
        <div class="sj-lane">
          <div class="sj-now" style="left:${nowPct.toFixed(2)}%;"></div>
          ${blocks}
          ${events}
        </div>
      </div>`;
  }
  host.innerHTML = html;
  document.getElementById("sj-count").textContent = `${jobRows.length} jobs · ${data.occurrences.length} runs in 7d`;
}

async function loadScheduledList() {
  const filt = (document.getElementById("sj-filter").value || "").trim();
  const tbody = document.querySelector("#sj-table tbody");
  tbody.innerHTML = '<tr><td colspan="8" class="muted center">Loading…</td></tr>';
  try {
    const { rows } = await api(`/api/schedules/verbose?filter=${encodeURIComponent(filt)}`);
    if (!rows.length) {
      tbody.innerHTML = '<tr><td colspan="8" class="muted center">No matching tasks.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(r => {
      const resultClass = r.last_result_raw === "0" || r.last_result_raw === "0x0"
        ? 'style="color:#047857"' : (r.last_result === "—" ? "" : 'style="color:#B45309"');
      const sched = [r.schedule_type, r.start_time, r.repeat_every && `every ${r.repeat_every}`]
        .filter(Boolean).join(" · ");
      const cmd = r.task_to_run || "";
      return `
        <tr>
          <td>
            <div><strong>${esc(r.name)}</strong></div>
            ${r.comment ? `<div class="muted" style="font-size:11px;">${esc(r.comment)}</div>` : ""}
          </td>
          <td>${esc(r.state)}</td>
          <td>${esc(r.status)}</td>
          <td>${esc(r.last_run)}</td>
          <td ${resultClass} title="${esc(r.last_result_raw)}">${esc(r.last_result)}</td>
          <td>${esc(r.next_run)}</td>
          <td class="muted" style="font-size:12px;">${esc(sched || "—")}</td>
          <td class="muted" style="font-size:11px; max-width:420px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${esc(cmd)}">${esc(cmd)}</td>
        </tr>`;
    }).join("");
  } catch (e) {
    tbody.innerHTML = `<tr><td colspan="8" class="muted center">Failed: ${esc(e.message)}</td></tr>`;
  }
}

// ───── misc ─────
function tickClock() { document.getElementById("now").textContent = new Date().toLocaleTimeString(); }

function connectWS() {
  const proto = location.protocol === "https:" ? "wss" : "ws";
  const tokenParam = state.token ? `?token=${encodeURIComponent(state.token)}` : "";
  const ws = new WebSocket(`${proto}://${location.host}/ws${tokenParam}`);
  const statusEl = document.getElementById("ws-status");
  ws.onopen = () => { statusEl.textContent = "connected"; statusEl.classList.remove("err"); statusEl.classList.add("ok"); };
  ws.onclose = () => {
    statusEl.textContent = "reconnecting"; statusEl.classList.remove("ok"); statusEl.classList.add("err");
    setTimeout(connectWS, 3000);
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      if (msg.event === "tick") loadJobs();
      if (msg.event === "skill_triggered") { loadJobs(); loadCalls(); loadSpend(); loadSpendChart(); loadActivityChart(); }
    } catch {}
  };
}

// ───── crm (hubspot tkcfo pipeline) ─────
async function loadCrm() {
  const tilesEl = document.getElementById("crm-tiles");
  let d;
  try {
    d = await api("/api/crm/snapshot");
  } catch (e) {
    tilesEl.innerHTML = `<div class="tile"><div class="label">CRM</div><div class="value">error</div><div class="sub">${esc(e.message)}</div></div>`;
    return;
  }

  const s = d.summary || {};
  const fmtMrr = v => "$" + Number(v || 0).toLocaleString();

  tilesEl.innerHTML = [
    `<div class="tile"><div class="label">Active MRR</div><div class="value">${fmtMrr(s.active_mrr)}</div><div class="sub">${s.active_count || 0} active clients</div></div>`,
    `<div class="tile"><div class="label">Paused MRR</div><div class="value">${fmtMrr(s.paused_mrr)}</div><div class="sub">${s.paused_count || 0} paused</div></div>`,
    `<div class="tile"><div class="label">Pipeline potential</div><div class="value">${fmtMrr(s.pipeline_mrr)}</div><div class="sub">${s.pipeline_count || 0} open deals</div></div>`,
    `<div class="tile"><div class="label">Total if all close</div><div class="value">${fmtMrr(s.total_if_all_close)}</div><div class="sub">active + pipeline</div></div>`,
  ].join("");

  // ── Goal progress bar ──────────────────────────────────────────────────
  const GOAL_FULL = 15000;   // FULL TIME TURNKEY
  const GOAL_MILE = 9000;    // QUIT ALTERYX milestone
  const activeMrr = s.active_mrr || 0;
  const pct       = Math.min(100, (activeMrr / GOAL_FULL) * 100);
  const milePct   = (GOAL_MILE / GOAL_FULL) * 100; // 60%
  const hitMile   = activeMrr >= GOAL_MILE;
  const hitFull   = activeMrr >= GOAL_FULL;
  const fillColor = hitFull ? "#FFD700" : hitMile ? "#00E676" : "#047857";
  const pctLabel  = pct > 12 ? `<span style="font-size:11px;font-weight:700;color:#000;padding-right:6px;">${pct.toFixed(0)}%</span>` : "";

  document.getElementById("crm-goal-section").innerHTML = `
    <div class="card" style="margin-bottom:16px;">
      <div style="padding:20px 24px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:14px;">
          <div style="font-size:12px;font-weight:700;letter-spacing:.08em;color:#9CA3AF;">REVENUE GOAL</div>
          <div style="font-size:22px;font-weight:800;color:#fff;">
            ${fmtMrr(activeMrr)}
            <span style="font-size:13px;font-weight:400;color:#6B7280;">/ ${fmtMrr(GOAL_FULL)} MRR</span>
          </div>
        </div>
        <div style="position:relative;height:32px;background:#1F2937;border-radius:8px;overflow:visible;margin-bottom:28px;">
          <div style="position:absolute;left:0;top:0;height:100%;width:${pct}%;background:${fillColor};border-radius:8px;display:flex;align-items:center;justify-content:flex-end;">${pctLabel}</div>
          <div style="position:absolute;left:${milePct}%;top:-8px;bottom:-8px;width:2px;background:#F59E0B;z-index:2;border-radius:2px;"></div>
          <div style="position:absolute;left:${milePct}%;top:40px;transform:translateX(-50%);white-space:nowrap;text-align:center;">
            <span style="font-size:10px;font-weight:700;letter-spacing:.06em;color:#F59E0B;">QUIT ALTERYX</span>
            <span style="font-size:10px;color:#6B7280;display:block;">$9,000</span>
          </div>
        </div>
        <div style="display:flex;justify-content:space-between;align-items:center;">
          <span style="font-size:11px;color:#4B5563;">$0</span>
          <span style="font-size:${hitFull ? "13px" : "11px"};font-weight:${hitFull ? "800" : "400"};color:${hitFull ? "#FFD700" : "#4B5563"};">
            ${hitFull ? "★ FULL TIME TURNKEY ★" : "FULL TIME TURNKEY · $15,000"}
          </span>
        </div>
        ${hitFull ? '<div style="margin-top:16px;text-align:center;font-size:16px;font-weight:800;color:#FFD700;letter-spacing:.1em;">YOU DID IT — FULL TIME TURNKEY</div>' : ""}
      </div>
    </div>`;

  // ── Active clients table ────────────────────────────────────────────────
  const healthBadge = h => {
    if (!h) return '<span class="muted">—</span>';
    const cls = h === "Green" ? "ok" : h === "At-Risk" ? "warn" : "failed";
    return `<span class="badge ${cls}">${esc(h)}</span>`;
  };

  const clients = d.clients || [];
  document.getElementById("crm-active-count").textContent = `${clients.length} clients`;
  document.querySelector("#crm-clients-table tbody").innerHTML = clients.length
    ? clients.map(c => `<tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="num" style="font-weight:700;color:#047857;font-size:15px;">$${Number(c.mrr).toLocaleString()}</td>
        <td class="muted">${esc(c.tier || "—")}</td>
        <td>${healthBadge(c.health)}</td>
        <td class="muted">${esc(c.last_close || "—")}</td>
        <td style="font-size:12px;max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c.next_action)}">${esc(c.next_action || "—")}</td>
        <td><a href="${esc(c.hs_url)}" target="_blank" rel="noopener" class="muted" style="font-size:11px;">HS ↗</a></td>
      </tr>`).join("")
    : '<tr><td colspan="7" class="muted center">No active or paused clients found.</td></tr>';

  // ── Pipeline table ──────────────────────────────────────────────────────
  const pipeline = d.pipeline || [];
  document.getElementById("crm-pipeline-count").textContent = `${pipeline.length} open deals`;
  document.querySelector("#crm-pipeline-table tbody").innerHTML = pipeline.length
    ? pipeline.map(c => `<tr>
        <td><strong>${esc(c.name)}</strong></td>
        <td class="num">${c.mrr ? "$" + Number(c.mrr).toLocaleString() : '<span class="muted">—</span>'}</td>
        <td class="muted">${esc(c.source || "—")}</td>
        <td style="font-size:12px;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" title="${esc(c.next_action)}">${esc(c.next_action || "—")}</td>
        <td><a href="${esc(c.hs_url)}" target="_blank" rel="noopener" class="muted" style="font-size:11px;">HS ↗</a></td>
      </tr>`).join("")
    : '<tr><td colspan="5" class="muted center">No open pipeline deals.</td></tr>';
}

document.getElementById("crm-refresh").onclick = async () => {
  try { await api("/api/crm/refresh", { method: "POST" }); } catch {}
  loadCrm();
};

async function loadClients() {
  try {
    const { clients } = await api("/api/clients");
    const grid = document.getElementById("clients-grid");
    const cnt = document.getElementById("clients-count");
    if (!clients || !clients.length) {
      grid.innerHTML = `<div class="muted center">No clients registered in dashboard-builder/clients.json.</div>`;
      if (cnt) cnt.textContent = "0 clients";
      return;
    }
    if (cnt) cnt.textContent = `${clients.length} client${clients.length === 1 ? "" : "s"}`;
    grid.innerHTML = clients.map(c => {
      const types = (c.dashboard_types || []).map(t => `<span class="pill">${esc(t)}</span>`).join(" ");
      const links = (c.links && c.links.length)
        ? c.links.map(l => `<a href="${esc(l.url)}" target="_blank" rel="noopener" style="display:inline-block;margin:0 6px 6px 0;padding:5px 10px;background:#0F1623;border:1px solid #1E2D45;border-radius:6px;font-size:12px;color:#60A5FA;text-decoration:none;">${esc(l.label)} ↗</a>`).join("")
        : `<span class="muted" style="font-size:12px;">no dashboard yet</span>`;
      const repo = c.github_repo
        ? `<a href="https://github.com/${esc(c.github_repo)}" target="_blank" rel="noopener" class="muted">${esc(c.github_repo)}</a>`
        : "";
      return `
        <div class="card" style="padding:14px;">
          <div style="font-weight:600;margin-bottom:4px;">${esc(c.display_name)}</div>
          <div class="muted" style="font-size:12px;margin-bottom:8px;">${esc(c.business_type || "")}</div>
          <div style="margin-bottom:10px;">${types || '<span class="muted">—</span>'}</div>
          <div style="margin-bottom:2px;">${links}</div>
          ${repo ? `<div style="font-size:12px;margin-top:4px;">${repo}</div>` : ""}
        </div>`;
    }).join("");
  } catch (e) {
    const grid = document.getElementById("clients-grid");
    if (grid) grid.innerHTML = `<div class="muted center">Failed to load clients: ${esc(e.message)}</div>`;
  }
}



// ───── Agent Manager ─────
let _agentAutoRefresh = null;

async function loadAgentManager(force = false) {
  const container = document.getElementById("agents-container");
  if (!container) return;
  const lastEl = document.getElementById("agents-last-refresh");
  try {
    const endpoint = force ? "/api/agents/refresh" : "/api/agents";
    const d = force
      ? await api(endpoint, { method: "POST", body: "{}" })
      : await api(endpoint);
    const { groups, group_order, counts } = d;

    // Status bar
    const badgesEl = document.getElementById("agents-summary-badges");
    if (badgesEl) {
      const parts = [];
      if (counts.running) parts.push(`<span class="astat running">${counts.running} running</span>`);
      if (counts.ok)      parts.push(`<span class="astat ok">${counts.ok} healthy</span>`);
      if (counts.warn)    parts.push(`<span class="astat warn">${counts.warn} warn</span>`);
      if (counts.disabled)parts.push(`<span class="astat disabled">${counts.disabled} disabled</span>`);
      badgesEl.innerHTML = parts.join("");
    }
    if (lastEl) lastEl.textContent = `Refreshed ${new Date().toLocaleTimeString()}`;

    const order = group_order || Object.keys(groups);
    const html = order.filter(g => groups[g] && groups[g].length).map(grpName => {
      const cards = groups[grpName];
      const runningCount = cards.filter(c => c.status === "running").length;
      const okCount = cards.filter(c => c.status === "ok").length;
      const warnCount = cards.filter(c => c.status === "warn").length;

      const cardsHtml = cards.map(card => {
        const statusBadge = card.status === "running"
          ? '<span class="badge running">running</span>'
          : card.status === "disabled"
          ? '<span class="badge disabled">disabled</span>'
          : card.status === "warn"
          ? '<span class="badge warn">warn</span>'
          : card.status === "ok"
          ? '<span class="badge ok">ok</span>'
          : '<span class="badge idle">idle</span>';

        const schedule = card.repeat_every
          ? `every ${card.repeat_every}`
          : card.schedule_label || "—";
        const lastRun = card.last_run && card.last_run !== "N/A" ? card.last_run.slice(0, 16) : "—";
        const nextRun = card.next_run && card.next_run !== "N/A" ? card.next_run.slice(0, 16) : "—";
        const lastResult = card.last_result && card.last_result !== "—" ? esc(card.last_result).slice(0, 60) : "";

        return `<div class="agent-card status-${esc(card.status)}">
          <div class="agent-card-top">
            <span class="agent-icon">${esc(card.icon)}</span>
            <div class="agent-info">
              <div class="agent-label">${esc(card.label)}</div>
              <div class="agent-name">${esc(card.name.replace(/^\\/,""))}</div>
            </div>
            <div class="agent-badge-row">${statusBadge}</div>
          </div>
          ${card.goal ? `<div class="agent-goal">${esc(card.goal)}</div>` : ""}
          ${card.live_note ? `<div class="agent-live">${esc(card.live_note)}</div>` : ""}
          <div class="agent-meta">
            <div class="agent-meta-item">⏱ <strong>${esc(schedule)}</strong></div>
            <div class="agent-meta-item">Last: <strong>${esc(lastRun)}</strong></div>
            <div class="agent-meta-item">Next: <strong>${esc(nextRun)}</strong></div>
            ${lastResult ? `<div class="agent-meta-item" style="${card.status==="warn"?"color:var(--warn)":""}">⇒ <strong>${lastResult}</strong></div>` : ""}
          </div>
        </div>`;
      }).join("");

      const groupMeta = [
        runningCount ? `<span class="astat running" style="font-size:10px;padding:2px 8px">${runningCount} running</span>` : "",
        warnCount    ? `<span class="astat warn"    style="font-size:10px;padding:2px 8px">${warnCount} warn</span>` : "",
        okCount      ? `<span class="astat ok"      style="font-size:10px;padding:2px 8px">${okCount} ok</span>` : "",
      ].filter(Boolean).join("");

      return `<div class="agent-group" data-group="${esc(grpName)}">
        <div class="agent-group-label">
          <span>${esc(grpName)}</span>
          ${groupMeta}
          <span class="ag-count">${cards.length} agents</span>
        </div>
        <div class="agent-grid">${cardsHtml}</div>
      </div>`;
    }).join("");
    container.innerHTML = html || '<div class="muted center" style="padding:40px">No Turnkey agents found.</div>';
  } catch (e) {
    if (container) container.innerHTML = `<div class="muted center" style="padding:40px">Error loading agents: ${esc(e.message)}</div>`;
    if (lastEl) lastEl.textContent = `Failed at ${new Date().toLocaleTimeString()}`;
  }
}

document.getElementById("agents-refresh-btn").onclick = () => loadAgentManager(true);

async function boot() {
  await loadBootstrap();
  await Promise.all([
    loadSpend(), loadCalls(), loadJobs(), loadSkills(),
    loadSpendChart(), loadActivityChart(), loadSkillBreakdown(), loadModelBreakdown(),
    loadClaudeCode(), loadCoach(), loadClients(), loadLeadGen(),
    loadOverviewGoal(), loadOverviewForecast(),
  ]);
  // hook refresh buttons for scheduled jobs (load on demand)
  const sjBtn = document.getElementById("sj-refresh");
  if (sjBtn) sjBtn.onclick = loadScheduledTimeline;
  const sjListBtn = document.getElementById("sj-refresh-list");
  if (sjListBtn) sjListBtn.onclick = loadScheduledList;
  const sjFilter = document.getElementById("sj-filter");
  if (sjFilter) sjFilter.addEventListener("keydown", e => { if (e.key === "Enter") loadScheduledList(); });

  // lead-gen period tabs
  document.querySelectorAll("#lg-period-tabs .pill").forEach(btn => {
    btn.addEventListener("click", () => {
      document.querySelectorAll("#lg-period-tabs .pill").forEach(b => b.classList.remove("active"));
      btn.classList.add("active");
      _lgPeriod = parseInt(btn.dataset.period, 10) || 30;
      loadLeadGenAggregate();
    });
  });
  try { initCoachPlan(); } catch (e) { console.error("coach-plan init failed", e); }
  connectWS();
  setInterval(tickClock, 1000); tickClock();
  setInterval(() => { loadSpend(); loadCalls(); loadSpendChart(); loadActivityChart(); loadSkillBreakdown(); loadModelBreakdown(); loadOverviewGoal(); loadOverviewForecast(); }, 30000);
  setInterval(() => {
    loadSkills(); loadJobs(); loadClaudeCode(); loadCoach(); loadLeadGen();
    if (state.tabsLoaded.has("crm")) loadCrm();
    if (state.tabsLoaded.has("hubspot")) loadHubspot();
    if (state.tabsLoaded.has("instantly")) loadInstantly();
    // refresh Agent Manager in background if tab is visible
    if (document.querySelector('.tab[data-tab="agents"]')?.classList.contains("active")) loadAgentManager();
  }, 30000);
}
boot().catch(e => { document.body.innerHTML = `<pre style="padding:40px;color:#B91C1C">Boot failed: ${e.message}</pre>`; });
