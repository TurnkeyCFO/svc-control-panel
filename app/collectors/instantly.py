"""Instantly collector — campaigns, warmup accounts, analytics. Read-only."""
import time
import threading
from datetime import date, timedelta
from typing import Any

import httpx

from app import config

_CACHE_TTL = 300
_cache: dict = {}
_lock = threading.Lock()
_BASE = "https://api.instantly.ai/api/v2"


def _key() -> str | None:
    return config.env().get("INSTANTLY_API_KEY")


def _get(path: str, params: dict | None = None) -> Any | None:
    key = _key()
    if not key:
        return None
    r = httpx.get(
        f"{_BASE}{path}",
        params=params,
        headers={"Authorization": f"Bearer {key}"},
        timeout=20,
    )
    r.raise_for_status()
    return r.json()


def _cached(cache_key: str, fn):
    now = time.time()
    with _lock:
        entry = _cache.get(cache_key)
        if entry and now - entry["ts"] < _CACHE_TTL:
            return entry["data"]
    data = fn()
    with _lock:
        _cache[cache_key] = {"ts": now, "data": data}
    return data


def summary() -> dict:
    def _fetch() -> dict:
        out: dict = {
            "connected": False,
            "campaigns": [],
            "accounts": [],
            "totals": {"leads": 0, "sent": 0, "opened": 0, "replied": 0, "bounced": 0},
            "per_campaign": [],
        }
        if not _key():
            return out
        out["connected"] = True

        # Campaigns list
        try:
            r = _get("/campaigns", {"limit": 100, "skip": 0})
            items = (r or {}).get("items") or (r or {}).get("campaigns") or []
            out["campaigns"] = [
                {
                    "id": c.get("id"),
                    "name": c.get("name"),
                    "status": c.get("status"),
                    "created_at": c.get("created_at") or c.get("timestamp"),
                }
                for c in items
            ]
        except Exception as e:
            out["campaigns_error"] = str(e)

        # Campaign analytics — v2 returns ALL campaigns in one array from a single
        # call (no per-campaign loop). Field names per Instantly v2.
        start = (date.today() - timedelta(days=30)).isoformat()
        end = date.today().isoformat()
        totals = out["totals"]
        per_campaign = []
        try:
            r = _get("/campaigns/analytics", {"start_date": start, "end_date": end})
            rows = r if isinstance(r, list) else (r.get("items") if isinstance(r, dict) else []) or []
            by_id = {}
            for row in rows:
                key = row.get("campaign_id") or row.get("id")
                if key:
                    by_id[key] = row
            for c in out["campaigns"]:
                s = by_id.get(c.get("id"), {})
                sent = int(s.get("emails_sent_count") or 0)
                opened = int(s.get("open_count_unique") or s.get("open_count") or 0)
                replied = int(s.get("reply_count_unique") or s.get("reply_count") or 0)
                bounced = int(s.get("bounced_count") or 0)
                leads = int(s.get("leads_count") or 0)
                totals["sent"] += sent
                totals["opened"] += opened
                totals["replied"] += replied
                totals["bounced"] += bounced
                totals["leads"] += leads
                per_campaign.append({
                    "id": c.get("id"),
                    "name": c.get("name") or c.get("id"),
                    "status": c.get("status"),
                    "sent": sent,
                    "opened": opened,
                    "replied": replied,
                    "bounced": bounced,
                    "leads": leads,
                    "open_rate": round(opened / sent * 100, 1) if sent else 0,
                    "reply_rate": round(replied / sent * 100, 2) if sent else 0,
                    "bounce_rate": round(bounced / sent * 100, 2) if sent else 0,
                })
        except Exception as e:
            out["analytics_error"] = str(e)
        # sort by sent desc
        per_campaign.sort(key=lambda x: x["sent"], reverse=True)
        out["per_campaign"] = per_campaign

        # Warmup accounts
        try:
            r = _get("/accounts", {"limit": 100, "skip": 0})
            items = (r or {}).get("items") or (r or {}).get("accounts") or []
            out["accounts"] = [
                {
                    "email": a.get("email"),
                    "warmup_score": (
                        a.get("stat_warmup_score")
                        if a.get("stat_warmup_score") is not None
                        else a.get("warmup_score") or (a.get("warmup") or {}).get("score")
                    ),
                    "warmup_enabled": (
                        a.get("warmup_status") == 1 or bool(a.get("warmup"))
                    ),
                    "status": a.get("status"),
                    "daily_limit": a.get("daily_limit"),
                }
                for a in items
            ]
        except Exception as e:
            out["accounts_error"] = str(e)

        return out

    return _cached("instantly_summary", _fetch)


def invalidate():
    with _lock:
        _cache.clear()
