import asyncio
import os
import secrets as _secrets
import sys
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles

from app import config
from app.db import (
    init_db, recent_llm_calls, spend_summary, recent_jobs, record_action,
    timeseries_spend_daily, timeseries_activity_hourly,
    breakdown_by_skill, breakdown_by_model, breakdown_by_session,
)
from app.middleware.localhost_only import LocalhostOnlyMiddleware
from app.collectors import skills_state, env_audit, processes, task_scheduler, claude_code, coach, lead_gen, hubspot, instantly, crm_hs, control_center, agents
from app.controls import registry, skill_runner


def _assert_bind_safety() -> None:
    for bad in ("UVICORN_HOST", "HOST"):
        v = os.environ.get(bad, "")
        if v and v not in ("127.0.0.1", "localhost"):
            sys.stderr.write(f"FATAL: {bad}={v!r} not allowed; control-panel is loopback-only\n")
            raise SystemExit(2)
    for i, arg in enumerate(sys.argv):
        if arg in ("--host",) and i + 1 < len(sys.argv) and sys.argv[i + 1] not in ("127.0.0.1", "localhost"):
            sys.stderr.write("FATAL: --host override not allowed\n")
            raise SystemExit(2)


_assert_bind_safety()


def _read_csrf() -> str:
    if config.CSRF_FILE.exists():
        try:
            return config.CSRF_FILE.read_text(encoding="utf-8").strip()
        except OSError:
            pass
    token = _secrets.token_urlsafe(32)
    config.CSRF_FILE.write_text(token, encoding="utf-8")
    return token


class WSManager:
    def __init__(self) -> None:
        self.active: set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.active.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.active.discard(ws)

    async def broadcast(self, msg: dict) -> None:
        dead = []
        for ws in self.active:
            try:
                await ws.send_json(msg)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.active.discard(ws)


ws_manager = WSManager()


async def _poll_loop() -> None:
    loop_count = 0
    while True:
        try:
            result = claude_code.scan()
            if result.get("inserted"):
                await ws_manager.broadcast({"event": "claude_code_ingested", "data": result})
        except Exception:
            pass
        try:
            await ws_manager.broadcast({"event": "tick", "jobs": recent_jobs(20)})
        except Exception:
            pass
        if loop_count % 5 == 0:
            try:
                from app.collectors import openrouter as orc
                snap = await orc.poll()
                if snap is not None:
                    await ws_manager.broadcast({"event": "openrouter_snapshot", "data": snap})
            except Exception:
                pass
        loop_count += 1
        await asyncio.sleep(60)


@asynccontextmanager
async def lifespan(app: FastAPI):
    init_db()
    _read_csrf()
    task = asyncio.create_task(_poll_loop())
    try:
        yield
    finally:
        task.cancel()


app = FastAPI(lifespan=lifespan, debug=False, docs_url=None, redoc_url=None, openapi_url=None)
app.add_middleware(LocalhostOnlyMiddleware)

WEB_DIR = Path(__file__).resolve().parent.parent / "web"
app.mount("/static", StaticFiles(directory=str(WEB_DIR)), name="static")


@app.exception_handler(Exception)
async def _generic_error(_req: Request, _exc: Exception):
    return JSONResponse({"error": "internal"}, status_code=500)


@app.get("/")
def index():
    return FileResponse(str(WEB_DIR / "index.html"))


@app.get("/health")
def health():
    return {"ok": True, "port": config.PORT}


@app.get("/api/bootstrap")
def bootstrap():
    return {"csrf": _read_csrf(), "base_url": config.BASE_URL}


@app.get("/api/spend")
def spend():
    return {"summary": spend_summary()}


@app.get("/api/control-center/summary")
@app.get("/ api/control-center/summary", include_in_schema=False)
def control_center_summary():
    return control_center.summary(refresh=False)


@app.post("/api/control-center/refresh")
@app.post("/ api/control-center/refresh", include_in_schema=False)
def control_center_refresh():
    data = control_center.summary(refresh=True)
    control_center.record_run("manual_refresh", "ok", notes="Control Center refreshed from dashboard")
    return data


@app.get("/api/control-center/notes")
def control_center_notes(limit: int = 50):
    return {"notes": control_center.summary(refresh=False).get("notes", [])[:limit]}


@app.post("/api/control-center/notes")
async def control_center_note_add(request: Request):
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    try:
        return control_center.add_note(
            body=(body or {}).get("body", ""),
            title=(body or {}).get("title", ""),
            note_type=(body or {}).get("note_type", "note"),
        )
    except ValueError:
        raise HTTPException(400, "empty_note")


@app.get("/api/calls")
def calls():
    return {"calls": recent_llm_calls(100)}


@app.get("/api/jobs")
def jobs():
    return {
        "task_scheduler": task_scheduler.list_tasks(filter_substr="Turnkey"),
        "recent_runs": recent_jobs(50),
    }


@app.get("/api/skills")
def skills():
    return {
        "registry": registry.list_skills(),
        "states": skills_state.list_skill_states(),
        "errors": skills_state.recent_errors(10),
        "processes": processes.list_processes(),
    }


@app.get("/api/hubspot/summary")
def hs_summary():
    return hubspot.summary()


@app.get("/api/instantly/summary")
def inst_summary():
    return instantly.summary()


@app.get("/api/timeseries/spend")
def ts_spend(days: int = 30):
    return {"days": days, "rows": timeseries_spend_daily(days)}


@app.get("/api/timeseries/activity")
def ts_activity(hours: int = 24):
    return {"hours": hours, "rows": timeseries_activity_hourly(hours)}


@app.get("/api/breakdown/skill")
def bd_skill(days: int = 30):
    return {"days": days, "rows": breakdown_by_skill(days)}


@app.get("/api/breakdown/model")
def bd_model(days: int = 30):
    return {"days": days, "rows": breakdown_by_model(days)}


@app.get("/api/breakdown/session")
def bd_session(days: int = 30):
    return {"days": days, "rows": breakdown_by_session(days)}


@app.get("/api/claude-code/summary")
def cc_summary():
    return claude_code.summary()


@app.get("/api/claude-code/timeseries")
def cc_timeseries(days: int = 30):
    return {"days": days, "rows": claude_code.timeseries_daily(days)}


@app.get("/api/claude-code/by-project")
def cc_by_project(days: int = 30):
    return {"days": days, "rows": claude_code.by_project(days)}


@app.get("/api/claude-code/by-model")
def cc_by_model(days: int = 30):
    return {"days": days, "rows": claude_code.by_model(days)}


@app.get("/api/claude-code/sessions")
def cc_sessions(days: int = 30, limit: int = 15):
    return {"days": days, "rows": claude_code.top_sessions(days, limit)}


@app.post("/api/claude-code/scan")
def cc_scan():
    return claude_code.scan()


@app.get("/api/agents")
def agents_summary():
    return agents.summary()


@app.post("/api/agents/refresh")
def agents_refresh():
    from app.collectors import agents as _agents
    _agents._CACHE["ts"] = 0.0  # invalidate cache
    return _agents.summary()


@app.post("/api/skills/{skill_id}/nonce")
async def issue_nonce(skill_id: str, request: Request):
    spec = registry.get(skill_id)
    if spec is None:
        raise HTTPException(404, "unknown_skill")
    if not spec.write_action:
        return {"nonce": None, "required": False}
    nonce = skill_runner.issue_nonce(skill_id)
    record_action("nonce", skill_id, request.headers.get("origin", ""), True, "issued")
    return {"nonce": nonce, "required": True, "expires_in": 30}


@app.post("/api/skills/{skill_id}/trigger")
async def trigger(skill_id: str, request: Request):
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    nonce = body.get("nonce") if isinstance(body, dict) else None
    result = skill_runner.run(skill_id, nonce=nonce)
    record_action(
        "trigger", skill_id, request.headers.get("origin", ""),
        True, "ok" if result.get("ok") else "failed",
    )
    await ws_manager.broadcast({"event": "skill_triggered", "skill_id": skill_id, "result": result})
    return result


@app.get("/api/clients")
def clients_list():
    import json
    path = Path(r"C:\Users\ricky_j3cdbqw\CLAUDE CODE PROJECTS\.claude\Skills\dashboard-builder\clients.json")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {"clients": []}
    rows = []
    for slug, c in (data.get("clients") or {}).items():
        links = c.get("links") or []
        # Back-compat: synthesize a single link from portal_url if no links array.
        if not links and c.get("portal_url"):
            links = [{"label": "Open portal", "url": c.get("portal_url")}]
        rows.append({
            "slug": slug,
            "display_name": c.get("display_name") or slug,
            "portal_url": c.get("portal_url") or "",
            "links": links,
            "github_repo": c.get("github_repo") or "",
            "dashboard_types": c.get("dashboard_types") or [],
            "business_type": c.get("business_type") or "",
        })
    rows.sort(key=lambda r: r["display_name"].lower())
    return {"clients": rows}


@app.get("/api/crm/snapshot")
def crm_snapshot():
    return crm_hs.fetch()


@app.get("/api/crm/forecast")
def crm_forecast():
    return crm_hs.forecast()


@app.post("/api/crm/refresh")
def crm_refresh():
    crm_hs.invalidate()
    return crm_hs.fetch()


@app.get("/api/lead-gen/summary")
def lg_summary():
    return lead_gen.summary()


@app.get("/api/lead-gen/by-source-daily")
def lg_by_source_daily(days: int = 14):
    return {"days": days, "rows": lead_gen.by_source_daily(days)}


@app.get("/api/lead-gen/status-breakdown")
def lg_status():
    return {"rows": lead_gen.status_breakdown()}


@app.get("/api/lead-gen/source-breakdown")
def lg_source():
    return {"rows": lead_gen.source_breakdown()}


@app.get("/api/lead-gen/runs")
def lg_runs(limit: int = 25):
    return {"rows": lead_gen.recent_runs(limit)}


@app.get("/api/lead-gen/budget")
def lg_budget():
    return {"rows": lead_gen.scrape_budget_today()}


@app.get("/api/lead-gen/transitions")
def lg_transitions(limit: int = 20):
    return {"rows": lead_gen.recent_transitions(limit)}


@app.get("/api/schedules/verbose")
def schedules_verbose(filter: str = "Turnkey"):
    return {"rows": task_scheduler.list_tasks_verbose(filter_substr=filter)}


@app.get("/api/schedules/timeline")
def schedules_timeline(days: int = 7):
    return task_scheduler.list_timeline(days=days)


@app.get("/api/lead-gen/aggregate")
def lg_aggregate(days: int = 7):
    return {"days": days, "rows": lead_gen.aggregate_by_source(days)}


@app.get("/api/lead-gen/aggregate-timeseries")
def lg_aggregate_ts(days: int = 7, metric: str = "scraped"):
    return {
        "days": days,
        "metric": metric,
        "rows": lead_gen.aggregate_timeseries(days, metric=metric),
    }


@app.get("/api/coach/summary")
def coach_summary():
    return coach.summary()


@app.get("/api/coach/journal")
def coach_journal(limit: int = 100):
    return {"entries": coach.list_journal(limit)}


@app.post("/api/coach/journal")
async def coach_journal_add(request: Request):
    body = await request.json() if request.headers.get("content-type", "").startswith("application/json") else {}
    text = (body or {}).get("text", "")
    try:
        row_id = coach.insert_dashboard_entry(text)
    except ValueError:
        raise HTTPException(400, "empty_text")
    return {"ok": True, "id": row_id}


@app.get("/api/coach/reviews")
def coach_reviews(limit: int = 20):
    return {"reviews": coach.list_reviews(limit)}


@app.api_route("/{bad_path:path}", methods=["GET", "POST"], include_in_schema=False)
def typo_api_alias(bad_path: str):
    """Gracefully handle a common copied URL typo: '/ api/...' or '/%20api/...'."""
    normalized = bad_path.lstrip().removeprefix("%20")
    if normalized == "api/control-center/summary":
        return control_center_summary()
    if normalized == "api/control-center/refresh":
        return control_center_refresh()
    raise HTTPException(404, "not_found")


@app.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    # Allow token-authenticated connections (remote / tunnel access).
    _access_token = config.env().get("CONTROL_PANEL_ACCESS_TOKEN", "")
    token_param = websocket.query_params.get("token", "")
    if not (_access_token and token_param == _access_token):
        origin = websocket.headers.get("origin")
        if origin and origin not in config.ALLOWED_ORIGINS:
            await websocket.close(code=4403)
            return
        host = websocket.headers.get("host", "")
        if host not in config.ALLOWED_HOSTS:
            await websocket.close(code=4403)
            return
    await ws_manager.connect(websocket)
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        ws_manager.disconnect(websocket)


def main() -> None:
    import uvicorn
    uvicorn.run(app, host=config.HOST, port=config.PORT, log_level="warning")


if __name__ == "__main__":
    main()
