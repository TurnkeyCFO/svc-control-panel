"""TKCFO CRM collector — reads the canonical TurnkeyCFO_CRM Google Sheet.

Single source of truth (2026-06-24): the dashboard MRR now reflects the
TurnkeyCFO_CRM sheet that Ricky actually maintains (👥 Clients + 🎯 Leads
tabs), NOT the stale HubSpot pipeline. The previous HubSpot-backed collector
is preserved as crm_hs.hubspot.bak.py.

Returns the same shape the frontend already consumes:
  clients  — Active + Paused client rows, mrr = durable fee + in-window temp add
  pipeline — open Leads (not Closed Won / Closed Lost / Ghosted), mrr = Opp midpoint
  summary  — counts + active/paused/pipeline MRR (+ durable/temp/onetime breakdown)
"""
from __future__ import annotations

import datetime
import json
import pathlib
import threading
import time

import gspread
from google.oauth2.service_account import Credentials

from app import config

_CACHE_TTL = 180  # 3-minute cache
_cache: dict = {}
_lock = threading.Lock()

_SCOPES = ["https://www.googleapis.com/auth/spreadsheets.readonly"]

# Canonical CRM sheet (overridable via env). Real tabs are emoji-prefixed.
_SHEET_ID = config.env().get("CONTROL_PANEL_CRM_SHEET_ID") or \
    "1FlkQ45f0kBP3QHcIqSYuG1yFblRwBImYd4B_G_rzTfg"
_CLIENTS_GID = 1980509545   # 👥 Clients
_LEADS_GID = 1982545045     # 🎯 Leads
_SHEET_URL = f"https://docs.google.com/spreadsheets/d/{_SHEET_ID}/edit"

# Pseudo stage ids so the frontend's stage_id bucketing keeps working.
_ACTIVE_STAGE = "active"
_PAUSED_STAGE = "paused"

_EXCLUDE_LEAD_STATUS = {"closed won", "closed lost", "ghosted"}


def _gc() -> gspread.Client:
    creds = Credentials.from_service_account_file(
        config.env().get("GOOGLE_SERVICE_ACCOUNT_JSON"), scopes=_SCOPES
    )
    return gspread.authorize(creds)


def _f(v) -> float:
    try:
        return float(str(v).replace(",", "").replace("$", "").strip() or 0)
    except (TypeError, ValueError):
        return 0.0


def _temp_in_window(temp: float, end: str, today: datetime.date) -> bool:
    """A temp monthly add counts toward MRR only until its end date."""
    if not temp:
        return False
    end = (end or "").strip()
    if not end:
        return True
    try:
        m, d, y = [int(x) for x in end.split("/")]
        return datetime.date(y, m, d) >= today
    except (ValueError, TypeError):
        return True


def _fetch_all() -> dict:
    try:
        sh = _gc().open_by_key(_SHEET_ID)
        clients_ws = sh.get_worksheet_by_id(_CLIENTS_GID)
        leads_ws = sh.get_worksheet_by_id(_LEADS_GID)
        cvals = clients_ws.get_all_values()
        lvals = leads_ws.get_all_values()
    except Exception as e:  # noqa: BLE001 — surface as dashboard error, don't crash
        return {"error": str(e), "clients": [], "pipeline": [], "summary": {},
                "source": "sheet"}

    today = datetime.date.today()
    clients: list[dict] = []

    # 👥 Clients — data rows start at row 7 (index 6), keyed on a non-empty name.
    for r in cvals[6:]:
        r = (r + [""] * 17)[:17]
        name = r[2].strip()
        if not name:
            continue
        status = r[7].strip()
        durable = _f(r[6])
        temp_raw = _f(r[14])
        temp = temp_raw if _temp_in_window(temp_raw, r[15], today) else 0.0
        is_paused = status.lower() == "paused"
        clients.append({
            "id": f"c{r[1]}",
            "name": name,
            "stage": "Paused" if is_paused else "Active",
            "stage_id": _PAUSED_STAGE if is_paused else _ACTIVE_STAGE,
            "mrr": durable + temp,
            "tier": r[4].strip(),
            "el_status": "Signed",
            "health": "",
            "billing_status": r[5].strip(),
            "last_close": "",
            "next_action": r[8].strip(),
            "next_action_due": (r[15] or "").strip(),
            "source": (r[16] or "").strip() or "Turnkey CFO",
            "partner": "",
            "durable": durable,
            "temp": temp,
            "onetime": _f(r[13]),
            "service_line": r[16].strip() or "Turnkey CFO",
            "hs_url": f"{_SHEET_URL}#gid={_CLIENTS_GID}",
        })

    # 🎯 Leads — data rows start at row 7 (index 6); skip closed/ghosted.
    pipeline: list[dict] = []
    for r in lvals[6:]:
        r = (r + [""] * 19)[:19]
        name = (r[2].strip() or r[3].strip())
        if not name:
            continue
        status = r[6].strip()
        if status.lower() in _EXCLUDE_LEAD_STATUS:
            continue
        low, high = _f(r[11]), _f(r[12])
        mid = (low + high) / 2 if (low or high) else 0.0
        pipeline.append({
            "id": f"l{r[1]}",
            "name": name,
            "stage": status or "Lead",
            "stage_id": "lead",
            "mrr": mid,
            "tier": "",
            "el_status": "",
            "health": "",
            "billing_status": "",
            "last_close": "",
            "next_action": r[9].strip(),
            "next_action_due": (r[8] or "").strip(),
            "source": (r[15] or "").strip() or "Turnkey CFO",
            "service_line": (r[15] or "").strip() or "Turnkey CFO",
            "partner": "",
            "hs_url": f"{_SHEET_URL}#gid={_LEADS_GID}",
        })

    clients.sort(key=lambda x: -x["mrr"])
    pipeline.sort(key=lambda x: -x["mrr"])

    active = [c for c in clients if c["stage_id"] == _ACTIVE_STAGE]
    paused = [c for c in clients if c["stage_id"] == _PAUSED_STAGE]
    active_mrr = sum(c["mrr"] for c in active)
    paused_mrr = sum(c["mrr"] for c in paused)
    pipeline_mrr = sum(p["mrr"] for p in pipeline)
    durable_mrr = sum(c["durable"] for c in active)
    temp_mrr = sum(c["temp"] for c in active)
    onetime_booked = sum(c["onetime"] for c in clients)

    return {
        "clients": clients,
        "pipeline": pipeline,
        "summary": {
            "active_count": len(active),
            "paused_count": len(paused),
            "pipeline_count": len(pipeline),
            "active_mrr": active_mrr,
            "paused_mrr": paused_mrr,
            "pipeline_mrr": pipeline_mrr,
            "total_if_all_close": active_mrr + pipeline_mrr,
            "durable_mrr": durable_mrr,
            "temp_mrr": temp_mrr,
            "onetime_booked": onetime_booked,
        },
        "source": "sheet",
    }


def _cached(key: str, fn):
    now = time.time()
    with _lock:
        entry = _cache.get(key)
        if entry and now - entry["ts"] < _CACHE_TTL:
            return entry["data"]
    data = fn()
    with _lock:
        _cache[key] = {"ts": now, "data": data}
    return data


def fetch() -> dict:
    return _cached("tkcfo_crm", _fetch_all)


def invalidate() -> None:
    with _lock:
        _cache.pop("tkcfo_crm", None)


# ── 6-month EARNINGS forecast (3 service lines, config-driven) ─────────────
# Base MRR (CFO + Web) is pulled LIVE from the CRM by service line; the config
# layers expected pipeline starts, temp roll-offs, and one-time events on top.
_CONFIG_PATH = pathlib.Path(__file__).resolve().parent.parent / "forecast_config.json"


def _forecast_config() -> dict:
    try:
        return json.loads(_CONFIG_PATH.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}


def _ramped(monthly: float, m: int, start_month: int, ramp_to, ramp_months) -> float:
    """Monthly value at month m for a client that starts at start_month and
    optionally ramps from `monthly` toward `ramp_to` over `ramp_months`."""
    if m < start_month:
        return 0.0
    if not ramp_to or not ramp_months:
        return float(monthly)
    val = monthly + (float(ramp_to) - monthly) * (m - start_month) / float(ramp_months)
    return float(min(float(ramp_to), max(monthly, val)))


def forecast() -> dict:
    """Earnings-potential forecast across 3 service lines for Now..+6 months.
    CFO + Web are recurring MRR (live base + expected starts - temp roll-offs);
    Recruiting + Web builds are one-time events. Total = recurring + one-time
    that month; Net = Total x margin."""
    cfg = _forecast_config()
    months = int(cfg.get("months") or 6)
    margin = float(cfg.get("margin") or 0.70)
    data = fetch()

    # Live recurring base by service line (active clients only).
    cfo_base = web_base = 0.0
    for c in data.get("clients", []):
        if c.get("stage_id") != _ACTIVE_STAGE:
            continue
        sl = (c.get("service_line") or "").lower()
        mrr = float(c.get("mrr") or 0)
        if "web" in sl:
            web_base += mrr
        elif "recruit" in sl:
            continue  # recruiting has no recurring base
        else:
            cfo_base += mrr

    cfo = cfg.get("cfo", {})
    web = cfg.get("web", {})
    rec = cfg.get("recruiting", {})
    cpv = float(web.get("care_plan_value") or 147)
    per_mo = float(web.get("new_care_plans_per_month") or 0)
    cps = int(web.get("care_plans_start_month") or 1)

    out = []
    for m in range(0, months + 1):
        # CFO recurring: live base - temp roll-offs reached + new clients started.
        cfo_mrr = cfo_base
        for t in cfo.get("temp_rolloffs", []):
            if m >= int(t.get("end_month", 99)):
                cfo_mrr -= float(t.get("amount") or 0)
        for nc in cfo.get("new_clients", []):
            cfo_mrr += _ramped(float(nc.get("monthly") or 0), m,
                               int(nc.get("start_month") or 0),
                               nc.get("ramp_to"), nc.get("ramp_months"))

        # Web recurring: live base + named care plans + funnel ramp.
        web_mrr = web_base
        for cp in web.get("new_care_plans", []):
            if m >= int(cp.get("start_month") or 0):
                web_mrr += float(cp.get("monthly") or 0)
        if per_mo and m >= cps:
            web_mrr += cpv * per_mo * (m - cps + 1)

        # One-time events landing this month.
        web_ot = sum(float(o.get("amount") or 0) for o in web.get("one_time", [])
                     if int(o.get("month", -1)) == m)
        rec_ot = sum(float(o.get("amount") or 0) for o in rec.get("one_time", [])
                     if int(o.get("month", -1)) == m)

        recurring = cfo_mrr + web_mrr
        onetime = web_ot + rec_ot
        total = recurring + onetime
        out.append({
            "month": m,
            "label": "Now" if m == 0 else f"+{m}mo",
            "cfo_mrr": round(cfo_mrr),
            "web_mrr": round(web_mrr),
            "web_onetime": round(web_ot),
            "recruiting_onetime": round(rec_ot),
            "recurring": round(recurring),
            "onetime": round(onetime),
            "total": round(total),
            "net": round(total * margin),
        })

    fut = out[1:]  # next 6 months (exclude "Now")
    peak = max(out, key=lambda x: x["total"])
    kpis = {
        "six_month_total": round(sum(x["total"] for x in fut)),
        "six_month_net": round(sum(x["net"] for x in fut)),
        "exit_mrr": out[-1]["recurring"],
        "recruiting_total": round(sum(x["recruiting_onetime"] for x in out)),
        "peak_label": peak["label"],
        "peak_total": peak["total"],
    }

    return {
        "months": out,
        "margin": margin,
        "cfo_base": round(cfo_base),
        "web_base": round(web_base),
        "kpis": kpis,
        "assumptions": {
            "cfo_new_clients": cfo.get("new_clients", []),
            "temp_rolloffs": cfo.get("temp_rolloffs", []),
            "web": web,
            "recruiting": rec.get("one_time", []),
        },
    }
