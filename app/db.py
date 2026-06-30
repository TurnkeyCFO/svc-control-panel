import sqlite3
import threading
from contextlib import contextmanager

from app import config

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS llm_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    provider TEXT NOT NULL,
    model TEXT,
    skill_tag TEXT,
    tokens_in INTEGER,
    tokens_out INTEGER,
    usd REAL,
    latency_ms INTEGER,
    status TEXT,
    pid INTEGER
);
CREATE INDEX IF NOT EXISTS idx_llm_calls_ts ON llm_calls(ts DESC);
CREATE INDEX IF NOT EXISTS idx_llm_calls_provider ON llm_calls(provider);

CREATE TABLE IF NOT EXISTS provider_usage_snapshots (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    provider TEXT NOT NULL,
    metric TEXT NOT NULL,
    value_usd REAL,
    value_raw TEXT
);
CREATE INDEX IF NOT EXISTS idx_usage_ts ON provider_usage_snapshots(ts DESC);

CREATE TABLE IF NOT EXISTS job_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source TEXT NOT NULL,
    job_id TEXT NOT NULL,
    started_at REAL,
    finished_at REAL,
    status TEXT,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_job_runs_started ON job_runs(started_at DESC);

CREATE TABLE IF NOT EXISTS claude_code_turns (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    session_id TEXT NOT NULL,
    turn_uuid TEXT NOT NULL,
    project_slug TEXT,
    model TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    cache_read_tokens INTEGER,
    cache_write_5m_tokens INTEGER,
    cache_write_1h_tokens INTEGER,
    usd REAL,
    UNIQUE(session_id, turn_uuid)
);
CREATE INDEX IF NOT EXISTS idx_cct_ts ON claude_code_turns(ts DESC);
CREATE INDEX IF NOT EXISTS idx_cct_project ON claude_code_turns(project_slug);
CREATE INDEX IF NOT EXISTS idx_cct_model ON claude_code_turns(model);
CREATE INDEX IF NOT EXISTS idx_cct_session ON claude_code_turns(session_id);

CREATE TABLE IF NOT EXISTS action_audit (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    route TEXT,
    skill_id TEXT,
    origin TEXT,
    csrf_ok INTEGER,
    outcome TEXT
);

CREATE TABLE IF NOT EXISTS action_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    source TEXT NOT NULL,
    source_ref TEXT,
    category TEXT NOT NULL DEFAULT 'general',
    title TEXT NOT NULL,
    detail TEXT,
    priority TEXT NOT NULL DEFAULT 'normal',
    owner TEXT DEFAULT 'ricky',
    status TEXT NOT NULL DEFAULT 'open',
    recommended_action TEXT,
    evidence_path TEXT,
    expires_at REAL,
    UNIQUE(source, source_ref, title)
);
CREATE INDEX IF NOT EXISTS idx_action_items_status ON action_items(status, priority, ts DESC);
CREATE INDEX IF NOT EXISTS idx_action_items_category ON action_items(category, status);

CREATE TABLE IF NOT EXISTS executive_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    note_type TEXT NOT NULL DEFAULT 'note',
    title TEXT,
    body TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'control-panel',
    status TEXT NOT NULL DEFAULT 'open'
);
CREATE INDEX IF NOT EXISTS idx_executive_notes_ts ON executive_notes(ts DESC);

CREATE TABLE IF NOT EXISTS control_center_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ts REAL NOT NULL,
    run_type TEXT NOT NULL,
    status TEXT NOT NULL,
    summary_path TEXT,
    notes TEXT
);
CREATE INDEX IF NOT EXISTS idx_control_center_runs_ts ON control_center_runs(ts DESC);

CREATE TABLE IF NOT EXISTS session_meta (
    session_id TEXT PRIMARY KEY,
    title TEXT,
    title_source TEXT,
    project_slug TEXT,
    updated REAL
);
"""


def init_db() -> None:
    with _lock:
        conn = sqlite3.connect(config.DB_PATH)
        conn.executescript(SCHEMA)
        conn.commit()
        conn.close()


@contextmanager
def connect():
    with _lock:
        conn = sqlite3.connect(config.DB_PATH)
        conn.row_factory = sqlite3.Row
        try:
            yield conn
            conn.commit()
        finally:
            conn.close()


# ── Unified LLM-call view ────────────────────────────────────────────────
# The Overview tab is fed from a single logical "llm_calls" stream. In practice
# the bulk of real telemetry lands in `claude_code_turns` (Claude Code CLI usage
# on the Max subscription) and OpenRouter spend lands in
# `provider_usage_snapshots`. `llm_calls` itself is kept in the UNION so any
# future direct-API writer is picked up automatically. The subquery below
# normalises claude_code_turns into the llm_calls column shape.
_UNIFIED_CALLS = """
    SELECT ts,
           'claude-code'        AS provider,
           model                AS model,
           project_slug         AS skill_tag,
           input_tokens         AS tokens_in,
           output_tokens        AS tokens_out,
           usd                  AS usd,
           NULL                 AS latency_ms
    FROM claude_code_turns
    UNION ALL
    SELECT ts, provider, model, skill_tag, tokens_in, tokens_out, usd, latency_ms
    FROM llm_calls
"""


def recent_llm_calls(limit: int = 50):
    with connect() as c:
        rows = c.execute(
            f"SELECT * FROM ({_UNIFIED_CALLS}) ORDER BY ts DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def _openrouter_window_spend(c, since_expr: str) -> float:
    """OpenRouter total_usage is cumulative; spend in a window = max-min delta."""
    r = c.execute(
        """SELECT MAX(value_usd) - MIN(value_usd) AS d
           FROM provider_usage_snapshots
           WHERE provider = 'openrouter' AND metric = 'total_usage'
             AND ts >= strftime('%s', 'now', ?)""",
        (since_expr,),
    ).fetchone()
    return (r["d"] or 0) if r else 0


def spend_summary():
    rows: list[dict] = []
    with connect() as c:
        totals = c.execute(f"""
            SELECT provider,
                   COALESCE(SUM(CASE WHEN ts >= strftime('%s','now','start of month') THEN usd END), 0) AS mtd,
                   COALESCE(SUM(CASE WHEN ts >= strftime('%s','now','start of day')   THEN usd END), 0) AS today
            FROM ({_UNIFIED_CALLS})
            GROUP BY provider
        """).fetchall()
        for r in totals:
            if r["mtd"] or r["today"]:
                rows.append({"provider": r["provider"], "today": r["today"] or 0, "mtd": r["mtd"] or 0})
        # OpenRouter spend from cumulative-usage snapshots
        or_today = _openrouter_window_spend(c, "start of day")
        or_mtd = _openrouter_window_spend(c, "start of month")
        if or_today or or_mtd:
            rows.append({"provider": "openrouter", "today": or_today, "mtd": or_mtd})
    return rows


def recent_jobs(limit: int = 50):
    with connect() as c:
        rows = c.execute(
            "SELECT * FROM job_runs ORDER BY started_at DESC LIMIT ?", (limit,)
        ).fetchall()
    return [dict(r) for r in rows]


def timeseries_spend_daily(days: int = 30) -> list[dict]:
    with connect() as c:
        rows = c.execute(f"""
            SELECT
                strftime('%Y-%m-%d', ts, 'unixepoch', 'localtime') AS day,
                provider,
                SUM(COALESCE(usd, 0)) AS usd
            FROM ({_UNIFIED_CALLS})
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY day, provider
            ORDER BY day ASC
        """).fetchall()
    return [dict(r) for r in rows]


def timeseries_activity_hourly(hours: int = 24) -> list[dict]:
    with connect() as c:
        rows = c.execute(f"""
            SELECT
                strftime('%Y-%m-%d %H:00', ts, 'unixepoch', 'localtime') AS hour,
                skill_tag,
                COUNT(*) AS calls,
                SUM(COALESCE(tokens_in, 0) + COALESCE(tokens_out, 0)) AS tokens
            FROM ({_UNIFIED_CALLS})
            WHERE ts >= strftime('%s', 'now', '-{int(hours)} hours')
            GROUP BY hour, skill_tag
            ORDER BY hour ASC
        """).fetchall()
    return [dict(r) for r in rows]


def breakdown_by_skill(days: int = 30) -> list[dict]:
    with connect() as c:
        rows = c.execute(f"""
            SELECT
                COALESCE(skill_tag, 'untagged') AS skill_tag,
                COUNT(*) AS calls,
                SUM(COALESCE(usd, 0)) AS usd,
                SUM(COALESCE(tokens_in, 0)) AS tokens_in,
                SUM(COALESCE(tokens_out, 0)) AS tokens_out
            FROM ({_UNIFIED_CALLS})
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY skill_tag
            ORDER BY usd DESC
        """).fetchall()
    return [dict(r) for r in rows]


def breakdown_by_model(days: int = 30) -> list[dict]:
    with connect() as c:
        rows = c.execute(f"""
            SELECT
                COALESCE(model, 'unknown') AS model,
                COUNT(*) AS calls,
                SUM(COALESCE(usd, 0)) AS usd,
                AVG(latency_ms) AS avg_latency_ms
            FROM ({_UNIFIED_CALLS})
            WHERE ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY model
            ORDER BY usd DESC
        """).fetchall()
    return [dict(r) for r in rows]


def upsert_session_meta(session_id: str, title: str, title_source: str,
                        project_slug: str, updated: float) -> None:
    """Store a human-readable title per Claude Code session (from ai-title or
    first real user prompt). Re-runnable: an ai-title always wins over a
    fallback-derived label."""
    if not session_id:
        return
    with connect() as c:
        c.execute(
            """INSERT INTO session_meta (session_id, title, title_source, project_slug, updated)
               VALUES (?, ?, ?, ?, ?)
               ON CONFLICT(session_id) DO UPDATE SET
                 title = CASE
                     WHEN excluded.title_source = 'ai-title' THEN excluded.title
                     WHEN session_meta.title_source = 'ai-title' THEN session_meta.title
                     ELSE excluded.title END,
                 title_source = CASE
                     WHEN excluded.title_source = 'ai-title' THEN 'ai-title'
                     ELSE session_meta.title_source END,
                 project_slug = excluded.project_slug,
                 updated = excluded.updated""",
            (session_id, title, title_source, project_slug, updated),
        )


def breakdown_by_session(days: int = 30, top: int = 14) -> list[dict]:
    """Spend grouped by Claude Code session, labelled with its readable title.
    Returns the top `top` sessions by spend; the remainder is folded into a
    single 'Other sessions' slice so the doughnut stays legible."""
    with connect() as c:
        rows = c.execute(f"""
            SELECT
                t.session_id AS session_id,
                COALESCE(NULLIF(m.title, ''), 'session ' || substr(t.session_id, 1, 8)) AS label,
                COUNT(*) AS calls,
                SUM(COALESCE(t.usd, 0)) AS usd
            FROM claude_code_turns t
            LEFT JOIN session_meta m ON m.session_id = t.session_id
            WHERE t.ts >= strftime('%s', 'now', '-{int(days)} days')
            GROUP BY t.session_id
            ORDER BY usd DESC
        """).fetchall()
    out = [dict(r) for r in rows]
    if len(out) > top:
        head = out[:top]
        tail = out[top:]
        head.append({
            "session_id": "",
            "label": f"Other ({len(tail)} sessions)",
            "calls": sum(r["calls"] for r in tail),
            "usd": sum(r["usd"] for r in tail),
        })
        return head
    return out


def record_action(route: str, skill_id: str, origin: str, csrf_ok: bool, outcome: str) -> None:
    import time
    with connect() as c:
        c.execute(
            "INSERT INTO action_audit (ts, route, skill_id, origin, csrf_ok, outcome) VALUES (?, ?, ?, ?, ?, ?)",
            (time.time(), route, skill_id, origin, 1 if csrf_ok else 0, outcome),
        )


def upsert_action_item(row: dict) -> int:
    import time
    now = float(row.get("ts") or time.time())
    values = {
        "ts": now,
        "source": row.get("source") or "manual",
        "source_ref": row.get("source_ref") or row.get("title") or "",
        "category": row.get("category") or "general",
        "title": row.get("title") or "Untitled action",
        "detail": row.get("detail") or "",
        "priority": row.get("priority") or "normal",
        "owner": row.get("owner") or "ricky",
        "status": row.get("status") or "open",
        "recommended_action": row.get("recommended_action") or "",
        "evidence_path": row.get("evidence_path") or "",
        "expires_at": row.get("expires_at"),
    }
    with connect() as c:
        c.execute("""
            INSERT INTO action_items (
                ts, source, source_ref, category, title, detail, priority, owner, status,
                recommended_action, evidence_path, expires_at
            ) VALUES (:ts, :source, :source_ref, :category, :title, :detail, :priority, :owner, :status,
                :recommended_action, :evidence_path, :expires_at)
            ON CONFLICT(source, source_ref, title) DO UPDATE SET
                ts=excluded.ts,
                category=excluded.category,
                detail=excluded.detail,
                priority=excluded.priority,
                owner=excluded.owner,
                status=excluded.status,
                recommended_action=excluded.recommended_action,
                evidence_path=excluded.evidence_path,
                expires_at=excluded.expires_at
        """, values)
        row_id = c.execute(
            "SELECT id FROM action_items WHERE source=? AND source_ref=? AND title=?",
            (values["source"], values["source_ref"], values["title"]),
        ).fetchone()["id"]
    return int(row_id)


def open_action_items(limit: int = 100) -> list[dict]:
    with connect() as c:
        rows = c.execute("""
            SELECT * FROM action_items
            WHERE status IN ('open', 'pending', 'watch')
            ORDER BY CASE priority WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
                     ts DESC
            LIMIT ?
        """, (limit,)).fetchall()
    return [dict(r) for r in rows]


def add_executive_note(body: str, title: str = "", note_type: str = "note", source: str = "control-panel", status: str = "open") -> int:
    import time
    if not body or not body.strip():
        raise ValueError("empty_note")
    with connect() as c:
        cur = c.execute(
            "INSERT INTO executive_notes (ts, note_type, title, body, source, status) VALUES (?, ?, ?, ?, ?, ?)",
            (time.time(), note_type or "note", title or "", body.strip(), source or "control-panel", status or "open"),
        )
        return int(cur.lastrowid)


def list_executive_notes(limit: int = 50) -> list[dict]:
    with connect() as c:
        rows = c.execute("SELECT * FROM executive_notes ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]


def record_control_center_run(run_type: str, status: str, summary_path: str = "", notes: str = "") -> int:
    import time
    with connect() as c:
        cur = c.execute(
            "INSERT INTO control_center_runs (ts, run_type, status, summary_path, notes) VALUES (?, ?, ?, ?, ?)",
            (time.time(), run_type, status, summary_path or "", notes or ""),
        )
        return int(cur.lastrowid)


def recent_control_center_runs(limit: int = 10) -> list[dict]:
    with connect() as c:
        rows = c.execute("SELECT * FROM control_center_runs ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
    return [dict(r) for r in rows]
