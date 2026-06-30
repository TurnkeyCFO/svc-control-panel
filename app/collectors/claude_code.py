"""Claude Code usage collector.

Walks ~/.claude/projects/*/*.jsonl session logs. For every assistant turn,
extracts model + token usage + cache info + timestamp, computes USD, writes to
claude_code_turns (UNIQUE on session_id+turn_uuid → safe to re-run).
"""
import json
from datetime import datetime
from pathlib import Path

from app.db import connect, upsert_session_meta
from app.config import MAX_PLAN_MONTHLY_USD

CLAUDE_PROJECTS_ROOT = Path.home() / ".claude" / "projects"

# $ per million tokens. Keep conservative — covers the models you actually use.
# Anything not here falls back to sonnet-4.6 rates.
PRICING = {
    # Claude 4.6 family
    "claude-sonnet-4-6":      {"in": 3.00,  "out": 15.00, "cache_read": 0.30, "cache_5m": 3.75, "cache_1h": 6.00},
    "claude-sonnet-4-6-1m":   {"in": 6.00,  "out": 22.50, "cache_read": 0.60, "cache_5m": 7.50, "cache_1h": 12.00},
    "claude-haiku-4-5":       {"in": 1.00,  "out":  5.00, "cache_read": 0.10, "cache_5m": 1.25, "cache_1h": 2.00},
    "claude-opus-4-7":        {"in": 15.00, "out": 75.00, "cache_read": 1.50, "cache_5m": 18.75,"cache_1h": 30.00},
    "claude-opus-4-7-1m":     {"in": 30.00, "out":112.50, "cache_read": 3.00, "cache_5m": 37.50,"cache_1h": 60.00},
    # 4.5 legacy
    "claude-sonnet-4-5":      {"in": 3.00,  "out": 15.00, "cache_read": 0.30, "cache_5m": 3.75, "cache_1h": 6.00},
    "claude-haiku-4-5-20251001": {"in": 1.00, "out": 5.00, "cache_read": 0.10, "cache_5m": 1.25, "cache_1h": 2.00},
}
_DEFAULT = PRICING["claude-sonnet-4-6"]


def _model_key(model: str) -> str:
    if not model:
        return "claude-sonnet-4-6"
    m = model.lower()
    # Anthropic sometimes prefixes version suffix; strip long hashes
    for k in PRICING:
        if m.startswith(k):
            return k
    return "claude-sonnet-4-6"


def _cost(model: str, usage: dict) -> float:
    p = PRICING.get(_model_key(model), _DEFAULT)
    tin = usage.get("input_tokens", 0) or 0
    tout = usage.get("output_tokens", 0) or 0
    cr = usage.get("cache_read_input_tokens", 0) or 0
    cc = usage.get("cache_creation", {}) if isinstance(usage.get("cache_creation"), dict) else {}
    c5 = cc.get("ephemeral_5m_input_tokens", 0) or 0
    c1 = cc.get("ephemeral_1h_input_tokens", 0) or 0
    # Fallback if granular cache_creation not present
    if not c5 and not c1:
        c5 = usage.get("cache_creation_input_tokens", 0) or 0
    return (
        tin * p["in"] + tout * p["out"] +
        cr * p["cache_read"] + c5 * p["cache_5m"] + c1 * p["cache_1h"]
    ) / 1_000_000.0


def _project_slug(session_file: Path) -> str:
    return session_file.parent.name


def _parse_ts(s: str | None) -> float | None:
    if not s:
        return None
    try:
        return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()
    except Exception:
        return None


# Lines whose user "content" is harness noise, not a real prompt — skipped when
# deriving a fallback session title.
_NOISE_PREFIXES = (
    "<local-command-caveat", "<command-name", "<command-message", "<command-args",
    "<system-reminder", "caveat:", "<bash-", "[request interrupted",
    "<user-prompt-submit-hook", "<session-start-hook",
)


def _clean_title(text: str) -> str:
    t = " ".join((text or "").split())
    return t[:70].strip()


def _looks_like_noise(text: str) -> bool:
    low = (text or "").lstrip().lower()
    return (not low) or low.startswith(_NOISE_PREFIXES)


def _user_text(msg: dict) -> str | None:
    c = msg.get("content")
    if isinstance(c, str):
        return c
    if isinstance(c, list):
        for b in c:
            if isinstance(b, dict) and b.get("type") == "text":
                return b.get("text")
    return None


def scan(max_files_per_run: int = 200) -> dict:
    if not CLAUDE_PROJECTS_ROOT.exists():
        return {"turns": 0, "files": 0, "inserted": 0}

    files = list(CLAUDE_PROJECTS_ROOT.glob("*/*.jsonl"))
    # process most recent first so live sessions get picked up fast
    files.sort(key=lambda p: p.stat().st_mtime, reverse=True)
    files = files[:max_files_per_run]

    inserted = 0
    turns = 0

    # session_id -> {"ai": <ai-title>, "fallback": <first real user msg>, "ts": <last ts>}
    titles: dict[str, dict] = {}

    with connect() as c:
        for fp in files:
            project = _project_slug(fp)
            try:
                with open(fp, "r", encoding="utf-8", errors="replace") as f:
                    for line in f:
                        try:
                            d = json.loads(line)
                        except Exception:
                            continue
                        dtype = d.get("type")
                        sid = d.get("sessionId") or fp.stem
                        if dtype == "ai-title":
                            at = d.get("aiTitle")
                            if at:
                                titles.setdefault(sid, {}).update(ai=_clean_title(at), project=project)
                            continue
                        if dtype == "user":
                            slot = titles.setdefault(sid, {})
                            if not slot.get("fallback"):
                                txt = _user_text(d.get("message") or {})
                                if txt and not _looks_like_noise(txt):
                                    slot["fallback"] = _clean_title(txt)
                                    slot["project"] = project
                            continue
                        if dtype != "assistant":
                            continue
                        msg = d.get("message") or {}
                        usage = msg.get("usage") or {}
                        if not usage:
                            continue
                        turns += 1
                        turn_uuid = d.get("uuid") or msg.get("id") or ""
                        session_id = d.get("sessionId") or fp.stem
                        ts = _parse_ts(d.get("timestamp"))
                        if ts is None:
                            ts = fp.stat().st_mtime
                        model = msg.get("model") or ""
                        cc = usage.get("cache_creation") if isinstance(usage.get("cache_creation"), dict) else {}
                        row = (
                            ts, session_id, turn_uuid, project,
                            model,
                            usage.get("input_tokens"),
                            usage.get("output_tokens"),
                            usage.get("cache_read_input_tokens"),
                            (cc or {}).get("ephemeral_5m_input_tokens") or usage.get("cache_creation_input_tokens"),
                            (cc or {}).get("ephemeral_1h_input_tokens"),
                            _cost(model, usage),
                        )
                        cur = c.execute(
                            """INSERT OR IGNORE INTO claude_code_turns
                               (ts, session_id, turn_uuid, project_slug, model,
                                input_tokens, output_tokens, cache_read_tokens,
                                cache_write_5m_tokens, cache_write_1h_tokens, usd)
                               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                            row,
                        )
                        if cur.rowcount:
                            inserted += 1
            except OSError:
                continue

    # Persist a readable title per session: prefer the model's ai-title, else
    # fall back to the first non-noise user prompt.
    import time as _time
    now = _time.time()
    for sid, slot in titles.items():
        label = slot.get("ai") or slot.get("fallback")
        if not label:
            continue
        source = "ai-title" if slot.get("ai") else "first-prompt"
        try:
            upsert_session_meta(sid, label, source, slot.get("project", ""), now)
        except Exception:
            pass

    return {"turns": turns, "files": len(files), "inserted": inserted, "titled": len(titles)}


# ── read-side helpers ──────────────────────────────────────────────────
#
# All read endpoints reframe raw API-equivalent dollars as a share of the
# flat Claude Max plan ($200/mo by default). The allocation is weighted by
# API-equivalent cost — an Opus session that would have cost $40 on the API
# takes a proportionally larger bite of the $200 than a $2 Haiku session.
#
#     plan_share_usd(row) = (row_api_usd / MTD_api_usd_total) * MAX_PLAN_MONTHLY_USD
#
# The denominator is always the current month's API-equivalent total, so
# plan-share dollars across MTD sum to exactly MAX_PLAN_MONTHLY_USD.


def _mtd_api_total(c) -> float:
    row = c.execute("""
        SELECT COALESCE(SUM(usd), 0) AS s
        FROM claude_code_turns
        WHERE ts >= strftime('%s', 'now', 'start of month')
    """).fetchone()
    return float(row["s"] or 0.0)


def _alloc(api_usd: float, mtd_total: float) -> float:
    if not mtd_total or mtd_total <= 0:
        return 0.0
    return (float(api_usd or 0) / mtd_total) * MAX_PLAN_MONTHLY_USD


def summary() -> dict:
    with connect() as c:
        totals = c.execute("""
            SELECT
              COUNT(*) AS turns,
              COALESCE(SUM(usd), 0) AS usd_total,
              COALESCE(SUM(input_tokens), 0) AS tin,
              COALESCE(SUM(output_tokens), 0) AS tout,
              COALESCE(SUM(cache_read_tokens), 0) AS cr,
              COALESCE(SUM(cache_write_5m_tokens), 0) + COALESCE(SUM(cache_write_1h_tokens), 0) AS cw
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', 'start of month')
        """).fetchone()
        today = c.execute("""
            SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS turns
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', 'start of day')
        """).fetchone()
        week = c.execute("""
            SELECT COALESCE(SUM(usd), 0) AS usd, COUNT(*) AS turns
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', '-7 days')
        """).fetchone()
        sessions = c.execute("""
            SELECT COUNT(DISTINCT session_id) AS n
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', 'start of month')
        """).fetchone()

    mtd_api = float(totals["usd_total"] or 0)
    total_input_side = (totals["tin"] or 0) + (totals["cr"] or 0) + (totals["cw"] or 0)
    cache_hit = (totals["cr"] or 0) / total_input_side if total_input_side else 0
    total_tokens_mtd = total_input_side + (totals["tout"] or 0)

    leverage = (mtd_api / MAX_PLAN_MONTHLY_USD) if MAX_PLAN_MONTHLY_USD else 0
    savings = max(0.0, mtd_api - MAX_PLAN_MONTHLY_USD)

    eff_per_turn = (MAX_PLAN_MONTHLY_USD / totals["turns"]) if totals["turns"] else 0.0
    eff_per_session = (MAX_PLAN_MONTHLY_USD / sessions["n"]) if sessions["n"] else 0.0
    eff_per_mtok = (MAX_PLAN_MONTHLY_USD / (total_tokens_mtd / 1_000_000)) if total_tokens_mtd else 0.0

    return {
        # plan-share view — real dollars out of the $200 plan
        "plan": {
            "monthly_usd": MAX_PLAN_MONTHLY_USD,
            "api_equivalent_mtd": round(mtd_api, 2),
            "leverage_x": round(leverage, 2),
            "savings_mtd": round(savings, 2),
            "effective_usd_per_turn": round(eff_per_turn, 4),
            "effective_usd_per_session": round(eff_per_session, 2),
            "effective_usd_per_mtok": round(eff_per_mtok, 4),
        },
        "today": {
            "usd": round(_alloc(today["usd"], mtd_api), 2),
            "api_usd": round(today["usd"] or 0, 2),
            "turns": today["turns"],
        },
        "week": {
            "usd": round(_alloc(week["usd"], mtd_api), 2),
            "api_usd": round(week["usd"] or 0, 2),
            "turns": week["turns"],
        },
        "month": {
            "usd": round(_alloc(mtd_api, mtd_api), 2),  # == MAX_PLAN_MONTHLY_USD when any usage
            "api_usd": round(mtd_api, 2),
            "turns": totals["turns"],
            "sessions": sessions["n"],
        },
        "tokens": {
            "input": totals["tin"], "output": totals["tout"],
            "cache_read": totals["cr"], "cache_write": totals["cw"],
            "cache_hit_rate": round(cache_hit, 3),
        },
    }


def timeseries_daily(days: int = 30) -> list[dict]:
    with connect() as c:
        mtd_total = _mtd_api_total(c)
        rows = c.execute(f"""
            SELECT
              strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
              model,
              SUM(usd) AS usd,
              SUM(input_tokens + COALESCE(cache_read_tokens,0) + COALESCE(cache_write_5m_tokens,0) + COALESCE(cache_write_1h_tokens,0)) AS tokens_in,
              SUM(output_tokens) AS tokens_out,
              COUNT(*) AS turns
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY day, model
            ORDER BY day ASC
        """).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["api_usd"] = round(d.pop("usd") or 0, 4)
        d["usd"] = round(_alloc(d["api_usd"], mtd_total), 4)
        out.append(d)
    return out


def by_project(days: int = 30) -> list[dict]:
    with connect() as c:
        mtd_total = _mtd_api_total(c)
        rows = c.execute(f"""
            SELECT project_slug, COUNT(*) AS turns, SUM(usd) AS usd,
                   COUNT(DISTINCT session_id) AS sessions
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY project_slug
            ORDER BY usd DESC
            LIMIT 20
        """).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["api_usd"] = round(d.pop("usd") or 0, 4)
        d["usd"] = round(_alloc(d["api_usd"], mtd_total), 4)
        out.append(d)
    return out


def by_model(days: int = 30) -> list[dict]:
    with connect() as c:
        mtd_total = _mtd_api_total(c)
        rows = c.execute(f"""
            SELECT model, COUNT(*) AS turns, SUM(usd) AS usd,
                   SUM(input_tokens) AS tin, SUM(output_tokens) AS tout,
                   SUM(cache_read_tokens) AS cache_read
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY model
            ORDER BY usd DESC
        """).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["api_usd"] = round(d.pop("usd") or 0, 4)
        d["usd"] = round(_alloc(d["api_usd"], mtd_total), 4)
        out.append(d)
    return out


def top_sessions(days: int = 30, limit: int = 15) -> list[dict]:
    with connect() as c:
        mtd_total = _mtd_api_total(c)
        rows = c.execute(f"""
            SELECT session_id, project_slug, COUNT(*) AS turns, SUM(usd) AS usd,
                   MAX(ts) AS last_ts, MIN(ts) AS first_ts
            FROM claude_code_turns
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY session_id
            ORDER BY usd DESC
            LIMIT ?
        """, (limit,)).fetchall()
    out = []
    for r in rows:
        d = dict(r)
        d["api_usd"] = round(d.pop("usd") or 0, 4)
        d["usd"] = round(_alloc(d["api_usd"], mtd_total), 4)
        out.append(d)
    return out
