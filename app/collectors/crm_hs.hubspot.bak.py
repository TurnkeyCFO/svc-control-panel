"""TKCFO CRM collector — reads the TKCFO Sales HubSpot pipeline.

Returns two views:
  clients  — Active + Paused records with MRR
  pipeline — all other open stages (forecast)
"""
import threading
import time
from typing import Any

import httpx

from app import config

_CACHE_TTL = 180  # 3-minute cache
_cache: dict = {}
_lock = threading.Lock()

_BASE = "https://api.hubapi.com"
_PIPELINE = "2220650202"

_ACTIVE_STAGE  = "3554966260"
_PAUSED_STAGE  = "3570473716"
_LOST_STAGE    = "3554966262"
_CHURNED_STAGE = "3554966261"

_STAGE_LABELS = {
    "3554966254": "New Lead",
    "3554966255": "Discovery Scheduled",
    "3554966256": "Discovery Complete",
    "3554966257": "Proposal Sent",
    "3554966258": "EL Sent",
    "3570982628": "Negotiating",
    "3554966259": "EL Signed",
    "3554966260": "Active",
    "3570473716": "Paused",
    "3554966261": "Churned",
    "3554966262": "Lost",
}

_PROPS = [
    "dealname", "dealstage", "tkcfo_mrr", "tkcfo_service_tier",
    "tkcfo_el_status", "tkcfo_health", "tkcfo_billing_status",
    "tkcfo_last_close", "tkcfo_next_action", "tkcfo_next_action_due",
    "tkcfo_source", "tkcfo_partner", "tkcfo_notes", "tkcfo_slug",
    "amount",
]

_EL_LABELS = {"not_sent": "Not Sent", "sent": "Sent", "approved": "Approved", "signed": "Signed"}
_HEALTH_LABELS = {"green": "Green", "yellow": "Yellow", "at_risk": "At-Risk"}


def _token() -> str | None:
    return config.env().get("HUBSPOT_PRIVATE_APP_TOKEN")


def _headers() -> dict:
    tok = _token()
    return {"Authorization": f"Bearer {tok}", "Content-Type": "application/json"} if tok else {}


def _search(body: dict) -> list[dict]:
    tok = _token()
    if not tok:
        return []
    r = httpx.post(
        f"{_BASE}/crm/v3/objects/deals/search",
        json=body, headers=_headers(), timeout=15,
    )
    r.raise_for_status()
    return r.json().get("results", [])


def _normalise(deal: dict) -> dict:
    p = deal["properties"]
    stage_id = p.get("dealstage", "")
    mrr = float(p.get("tkcfo_mrr") or p.get("amount") or 0)
    return {
        "id":          deal["id"],
        "name":        p.get("dealname") or "—",
        "stage":       _STAGE_LABELS.get(stage_id, stage_id),
        "stage_id":    stage_id,
        "mrr":         mrr,
        "tier":        p.get("tkcfo_service_tier") or "",
        "el_status":   _EL_LABELS.get(p.get("tkcfo_el_status") or "", p.get("tkcfo_el_status") or ""),
        "health":      _HEALTH_LABELS.get(p.get("tkcfo_health") or "", ""),
        "billing_status": p.get("tkcfo_billing_status") or "",
        "last_close":  (p.get("tkcfo_last_close") or "")[:10],
        "next_action": p.get("tkcfo_next_action") or "",
        "next_action_due": (p.get("tkcfo_next_action_due") or "")[:10],
        "source":      p.get("tkcfo_source") or "",
        "partner":     p.get("tkcfo_partner") or "",
        "hs_url":      f"https://app-na2.hubspot.com/contacts/245973988/record/0-3/{deal['id']}",
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


def _fetch_all() -> dict:
    try:
        deals = _search({
            "filterGroups": [{"filters": [
                {"propertyName": "pipeline", "operator": "EQ", "value": _PIPELINE},
            ]}],
            "properties": _PROPS,
            "limit": 200,
        })
    except Exception as e:
        return {"error": str(e), "clients": [], "pipeline": [], "summary": {}}

    clients = []
    pipeline = []

    for deal in deals:
        row = _normalise(deal)
        if row["stage_id"] in (_ACTIVE_STAGE, _PAUSED_STAGE):
            clients.append(row)
        elif row["stage_id"] not in (_LOST_STAGE, _CHURNED_STAGE):
            pipeline.append(row)

    clients.sort(key=lambda r: -r["mrr"])
    pipeline.sort(key=lambda r: (
        ["Negotiating","EL Sent","EL Signed","Proposal Sent","Discovery Complete",
         "Discovery Scheduled","New Lead"].index(r["stage"])
        if r["stage"] in ["Negotiating","EL Sent","EL Signed","Proposal Sent",
                          "Discovery Complete","Discovery Scheduled","New Lead"] else 99
    ))

    active_mrr  = sum(r["mrr"] for r in clients if r["stage_id"] == _ACTIVE_STAGE)
    paused_mrr  = sum(r["mrr"] for r in clients if r["stage_id"] == _PAUSED_STAGE)
    pipeline_mrr = sum(r["mrr"] for r in pipeline)

    return {
        "clients":  clients,
        "pipeline": pipeline,
        "summary": {
            "active_count":  sum(1 for r in clients if r["stage_id"] == _ACTIVE_STAGE),
            "paused_count":  sum(1 for r in clients if r["stage_id"] == _PAUSED_STAGE),
            "pipeline_count": len(pipeline),
            "active_mrr":   active_mrr,
            "paused_mrr":   paused_mrr,
            "pipeline_mrr": pipeline_mrr,
            "total_if_all_close": active_mrr + pipeline_mrr,
        },
    }


def fetch() -> dict:
    return _cached("tkcfo_crm", _fetch_all)


def invalidate() -> None:
    with _lock:
        _cache.pop("tkcfo_crm", None)
