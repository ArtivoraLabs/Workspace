from __future__ import annotations

import asyncio
import json
import logging
import uuid

import httpx
from fastapi import Depends, FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse, StreamingResponse
from contextlib import asynccontextmanager

from .agent import stream_agent
from .cache import build_cache
from .config import Settings, get_settings
from .llm.registry import build_providers, load_catalog, plan
from .odoo.client import OdooClient, OdooConfig, OdooError, assert_safe_client_url
from .odoo.guard import Guard
from .odoo.tools import ToolContext
from .schemas import ChatRequest
from .security import Principal, authenticate, rate_limit

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
log = logging.getLogger("api")


def create_app(settings: Settings | None = None, *, providers: dict | None = None,
               transport: httpx.AsyncBaseTransport | None = None) -> FastAPI:
    settings = settings or get_settings()

    @asynccontextmanager
    async def lifespan(app: FastAPI):
        app.state.settings = settings
        app.state.cache = build_cache(settings.redis_url)
        app.state.http = httpx.AsyncClient(
            transport=transport,
            limits=httpx.Limits(max_connections=100, max_keepalive_connections=20),
            headers={"User-Agent": "dashview-ai-service/1.0"},
        )
        app.state.providers = providers if providers is not None else build_providers(settings)
        app.state.catalog = load_catalog(settings)
        if settings.env == "prod" and (settings.cors_list == ["*"] or not settings.jwt_secret):
            log.warning("PROD with open CORS or empty JWT_SECRET - fix before exposing this service.")
        yield
        await app.state.http.aclose()
        await app.state.cache.close()

    app = FastAPI(title="DashView AI Service", version="1.0.0", lifespan=lifespan,
                  docs_url=None if settings.env == "prod" else "/docs", redoc_url=None)
    app.add_middleware(CORSMiddleware, allow_origins=settings.cors_list, allow_methods=["GET", "POST"],
                       allow_headers=["Authorization", "Content-Type", "X-API-Key"])

    @app.exception_handler(OdooError)
    async def odoo_error_handler(request: Request, exc: OdooError):
        return JSONResponse({"ok": False, "error": str(exc)}, status_code=exc.status)

    async def resolve_client(request: Request, body_odoo) -> OdooClient:
        s: Settings = request.app.state.settings
        cfg = None
        if body_odoo is not None:
            await assert_safe_client_url(body_odoo.url, s)
            cfg = OdooConfig(body_odoo.url, body_odoo.db, body_odoo.username, body_odoo.api_key)
        cfg = cfg or OdooConfig.from_settings(s)
        if cfg is None:
            raise HTTPException(400, "Odoo is not configured on the server (ODOO_URL/DB/USERNAME/API_KEY).")
        return OdooClient(cfg, request.app.state.http, request.app.state.cache, s)

    @app.get("/health")
    async def health():
        return {"ok": True}

    @app.get("/v1/models")
    async def models(request: Request, principal: Principal = Depends(authenticate)):
        avail = set(request.app.state.providers)
        return {"models": [m.__dict__ for m in request.app.state.catalog if m.provider in avail],
                "providers": sorted(avail)}

    @app.post("/v1/odoo/test")
    async def odoo_test(request: Request, principal: Principal = Depends(authenticate)):
        client = await resolve_client(request, None)
        try:
            return {"ok": True, **await client.test()}
        except OdooError as e:
            return JSONResponse({"ok": False, "error": str(e)}, status_code=e.status)

    @app.post("/v1/chat")
    async def chat(req: ChatRequest, request: Request, principal: Principal = Depends(authenticate)):
        await rate_limit(request, principal)
        st = request.app.state
        client = await resolve_client(request, req.odoo)
        ctx = ToolContext(client=client, guard=Guard(st.settings))
        history = [m.model_dump() for m in req.messages]
        if history[-1]["role"] != "user":
            raise HTTPException(400, "The last message must be from the user.")
        chain = plan(st.catalog, set(st.providers), st.settings.priority, history[-1]["content"], req.tier, req.model)
        rid = uuid.uuid4().hex[:8]
        log.info("chat rid=%s user=%s chain=%s", rid, principal.id, [m.id for m in chain][:3])
        events = stream_agent(history=history, ctx=ctx, chain=chain, providers=st.providers, settings=st.settings)

        if not req.stream:
            tools_used, final, error = [], None, None
            async for ev in events:
                if ev["type"] == "tool_start":
                    tools_used.append(ev["name"])
                elif ev["type"] == "final":
                    final = ev
                elif ev["type"] == "error":
                    error = ev["message"]
            if final is None:
                return JSONResponse({"ok": False, "error": error or "No answer produced."}, status_code=502)
            return {"ok": True, "text": final["text"], "model": final["model"], "provider": final["provider"],
                    "usage": final["usage"], "tools": tools_used}

        async def sse():
            try:
                async for ev in events:
                    yield f"event: {ev['type']}\ndata: {json.dumps(ev, default=str)}\n\n"
            except asyncio.CancelledError:
                raise
            except Exception:  # noqa: BLE001
                log.exception("stream failed rid=%s", rid)
                yield 'event: error\ndata: {"type":"error","message":"Internal error."}\n\n'
            yield "event: done\ndata: {}\n\n"

        return StreamingResponse(sse(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"})

    return app


app = create_app() if __name__ != "__main__" else None
