import httpx
import pytest

from app.cache import MemoryCache
from app.odoo.client import OdooClient, OdooConfig, OdooError, assert_safe_client_url
from app.odoo.guard import Guard
from app.odoo.tools import ToolContext, run_tool
from tests.conftest import fake_odoo_transport, settings


def make_ctx(calls=None, key="good-key"):
    s = settings(odoo_api_key=key)
    http = httpx.AsyncClient(transport=fake_odoo_transport(calls))
    client = OdooClient(OdooConfig("https://x.odoo.com", "db", "u", key), http, MemoryCache(), s)
    return ToolContext(client, Guard(s)), http


async def test_write_methods_are_impossible():
    ctx, http = make_ctx()
    with pytest.raises(OdooError):
        await ctx.client.call("res.partner", "unlink", [[1]])
    with pytest.raises(OdooError):
        await ctx.client.call("res.partner", "write", [[1], {"name": "x"}])
    await http.aclose()


async def test_bad_key_fails_auth():
    ctx, http = make_ctx(key="wrong")
    with pytest.raises(OdooError) as e:
        await ctx.client.uid()
    assert e.value.status == 401
    await http.aclose()


async def test_aggregate_tool_shapes_result():
    ctx, http = make_ctx()
    r = await run_tool(ctx, "odoo_aggregate", {"model": "sale.order", "groupby": ["partner_id"],
                                              "measures": ["amount_total:sum"], "order": "amount_total desc"})
    assert r["groups"][0] == {"partner_id": "Acme", "amount_total:sum": 5000.0, "count": 4}
    await http.aclose()


async def test_tool_errors_are_returned_not_raised():
    ctx, http = make_ctx()
    assert "error" in await run_tool(ctx, "odoo_search_read", {"model": "res.users"})
    assert "error" in await run_tool(ctx, "odoo_count", {"model": "sale.order", "domain": [["password", "=", 1]]})
    assert "error" in await run_tool(ctx, "nope", {})
    await http.aclose()


async def test_get_fields_hides_sensitive_and_search_read_compacts():
    ctx, http = make_ctx()
    f = await run_tool(ctx, "odoo_get_fields", {"model": "res.partner"})
    assert "password" not in f["fields"] and "name" in f["fields"]
    r = await run_tool(ctx, "odoo_search_read", {"model": "sale.order", "limit": 5})
    assert r["total_matching"] == 42 and r["rows"][0] == {"id": 1, "name": "SO001", "partner_id": "Acme", "note": None}
    await http.aclose()


async def test_snapshot_survives_missing_modules():
    ctx, http = make_ctx()
    r = await run_tool(ctx, "odoo_business_snapshot", {"days": 7})
    assert r["window_days"] == 7 and "sales_orders_confirmed" in r["metrics"]
    await http.aclose()


async def test_results_are_cached():
    calls = []
    ctx, http = make_ctx(calls)
    ctx.client._s = settings(cache_ttl_data_s=60)
    await ctx.client.search_count("sale.order", [])
    await ctx.client.search_count("sale.order", [])
    assert sum(1 for c in calls if c[1] == "execute_kw") == 1
    await http.aclose()


async def test_client_url_policy():
    with pytest.raises(OdooError):  # disabled by default
        await assert_safe_client_url("https://a.odoo.com", settings())
    on = settings(odoo_allow_client_credentials=True, odoo_allowed_hosts="*.odoo.com")
    await assert_safe_client_url("https://a.odoo.com", on)
    with pytest.raises(OdooError):
        await assert_safe_client_url("https://evil.example.com", on)
    with pytest.raises(OdooError):  # no allow-list: loopback refused
        await assert_safe_client_url("http://127.0.0.1:8069", settings(odoo_allow_client_credentials=True))


async def test_health_reports_connection_and_areas():
    ctx, http = make_ctx()
    r = await run_tool(ctx, "odoo_health", {})
    assert r["connection"]["ok"] is True and r["connection"]["server_version"] == "18.0"
    assert r["areas"]["Sales"]["status"] == "ok" and r["areas"]["Sales"]["records"] == 42
    assert r["summary"]["checked_areas"] >= 10
    await http.aclose()


async def test_health_reports_bad_login_instead_of_raising():
    ctx, http = make_ctx(key="wrong")
    r = await run_tool(ctx, "odoo_health", {})
    assert r["connection"]["ok"] is False and "error" in r["connection"]
    await http.aclose()


async def test_in_progress_lists_open_work_with_totals():
    ctx, http = make_ctx()
    r = await run_tool(ctx, "odoo_in_progress", {})
    ip = r["in_progress"]
    assert ip["quotations_open"]["count"] == 6 and ip["quotations_open"]["total_amount_total"] == 8000.0
    assert "INFERRED" in r["note"] and len(ip) == 10
    await http.aclose()
