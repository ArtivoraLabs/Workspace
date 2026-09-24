"""Tools the LLM can call. Provider-neutral JSON-schema definitions plus
async handlers. Every handler validates through Guard and returns compact,
token-cheap JSON (many2one -> name, False -> null, long text clipped)."""
from __future__ import annotations

import asyncio
import json
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from typing import Any, Awaitable, Callable

from .client import OdooClient, OdooError
from .guard import Guard, GuardError

MAX_RESULT_CHARS = 24_000
MAX_CELL_CHARS = 300
FIELD_CATALOG_LIMIT = 120
SKIP_FIELD_TYPES = {"binary", "html", "image", "one2many", "many2many", "serialized", "properties", "json"}


@dataclass
class ToolContext:
    client: OdooClient
    guard: Guard


@dataclass
class ToolSpec:
    name: str
    description: str
    input_schema: dict
    handler: Callable[[ToolContext, dict], Awaitable[dict]]


# ── result shaping ───────────────────────────────────────────────────
def _cell(v: Any) -> Any:
    if v is False:
        return None
    if isinstance(v, list) and len(v) == 2 and isinstance(v[0], int) and isinstance(v[1], str):
        return v[1]  # many2one -> display name
    if isinstance(v, str) and len(v) > MAX_CELL_CHARS:
        return v[:MAX_CELL_CHARS] + "…"
    return v


def _compact_rows(rows: list[dict]) -> list[dict]:
    return [{k: _cell(v) for k, v in r.items()} for r in rows]


def shrink(obj: dict, max_chars: int = MAX_RESULT_CHARS) -> dict:
    """Trim the largest list in a result until it fits the token budget."""
    text = json.dumps(obj, default=str)
    if len(text) <= max_chars:
        return obj
    for key, val in list(obj.items()):
        if isinstance(val, list) and len(val) > 1:
            keep = max(1, int(len(val) * max_chars / len(text) * 0.8))
            obj = {**obj, key: val[:keep], "truncated": f"showing {keep} of {len(val)} {key}"}
            break
    return obj


def _now() -> datetime:
    return datetime.now(timezone.utc)


# ── handlers ─────────────────────────────────────────────────────────
async def h_list_models(ctx: ToolContext, a: dict) -> dict:
    q = str(a.get("query", "")).strip()[:60]
    domain: list = [["transient", "=", False]]
    if q:
        domain += ["|", ["name", "ilike", q], ["model", "ilike", q]]
    rows = await ctx.client.search_read("ir.model", domain, ["model", "name"], 60, "model")
    models = [{"model": r["model"], "label": r["name"]} for r in rows if ctx.guard.model_allowed(r["model"])]
    return {"models": models[:40]}


async def h_get_fields(ctx: ToolContext, a: dict) -> dict:
    model = ctx.guard.check_model(a.get("model"))
    q = str(a.get("query", "")).strip().lower()[:40]
    raw = await ctx.client.fields_get(model)
    out = {}
    for name, meta in sorted(raw.items()):
        if meta.get("type") in SKIP_FIELD_TYPES or ctx.guard.field_sensitive(name):
            continue
        if q and q not in name.lower() and q not in str(meta.get("string", "")).lower():
            continue
        entry = f"{meta.get('type')}|{meta.get('string')}"
        if meta.get("relation"):
            entry += f"|->{meta['relation']}"
        if meta.get("selection") and isinstance(meta["selection"], list):
            entry += "|" + ",".join(str(s[0]) for s in meta["selection"][:12])
        if meta.get("store") is False:
            entry += "|not stored (can't filter/group)"
        out[name] = entry
    keys = list(out)[:FIELD_CATALOG_LIMIT]
    res: dict = {"model": model, "fields": {k: out[k] for k in keys}}
    if len(out) > len(keys):
        res["note"] = f"{len(out)} fields match; showing {len(keys)}. Pass 'query' to narrow."
    return res


async def h_search_read(ctx: ToolContext, a: dict) -> dict:
    g = ctx.guard
    model = g.check_model(a.get("model"))
    domain = g.check_domain(a.get("domain"))
    fields = g.check_fields(a.get("fields"))
    limit = g.check_limit(a.get("limit"))
    order = g.check_order(a.get("order"))
    if not fields:  # never pull "all fields": choose scalar, non-sensitive ones
        meta = await ctx.client.fields_get(model)
        fields = [n for n, m in meta.items()
                  if m.get("type") not in SKIP_FIELD_TYPES and m.get("store", True)
                  and not g.field_sensitive(n)][:25]
    rows, total = await asyncio.gather(
        ctx.client.search_read(model, domain, fields, limit, order),
        ctx.client.search_count(model, domain),
    )
    return shrink({"model": model, "total_matching": total, "returned": len(rows), "rows": _compact_rows(rows)})


async def h_count(ctx: ToolContext, a: dict) -> dict:
    model = ctx.guard.check_model(a.get("model"))
    return {"model": model, "count": await ctx.client.search_count(model, ctx.guard.check_domain(a.get("domain")))}


def _pick(row: dict, key: str) -> Any:
    if key in row:
        return row[key]
    return row.get(key.split(":")[0])


async def h_aggregate(ctx: ToolContext, a: dict) -> dict:
    g = ctx.guard
    model = g.check_model(a.get("model"))
    domain = g.check_domain(a.get("domain"))
    groupby = g.check_groupby(a.get("groupby"))
    measures = g.check_measures(a.get("measures"))
    order = g.check_order(a.get("order"))
    limit = g.check_limit(a.get("limit"), default=20)
    raw = await ctx.client.read_group(model, domain, measures, groupby, order, limit)
    groups = []
    for row in raw[:limit]:
        item = {gb: _cell(_pick(row, gb)) for gb in groupby}
        for m in measures:
            item[m] = row.get("__count") if m == "__count" else _pick(row, m)
        if "__count" not in item:
            item["count"] = row.get("__count", row.get("count"))
        groups.append(item)
    return shrink({"model": model, "groupby": groupby, "measures": measures, "groups": groups})


async def h_get_record(ctx: ToolContext, a: dict) -> dict:
    g = ctx.guard
    model = g.check_model(a.get("model"))
    try:
        rid = int(a.get("id"))
    except (TypeError, ValueError):
        raise GuardError("id must be an integer.")
    fields = g.check_fields(a.get("fields"))
    rows = await ctx.client.read(model, [rid], fields or [])
    if not rows:
        return {"model": model, "found": False}
    row = {k: v for k, v in rows[0].items() if not g.field_sensitive(k)}
    return {"model": model, "found": True, "record": _compact_rows([row])[0]}


def _dt(d: datetime) -> str:
    return d.strftime("%Y-%m-%d %H:%M:%S")


async def h_snapshot(ctx: ToolContext, a: dict) -> dict:
    days = max(1, min(int(a.get("days") or 30), 365))
    since = _dt(_now() - timedelta(days=days))
    # (label, model, domain, sum_field or None)
    items = [
        ("sales_orders_confirmed", "sale.order", [["state", "in", ["sale", "done"]], ["date_order", ">=", since]], "amount_total"),
        ("open_quotations", "sale.order", [["state", "in", ["draft", "sent"]]], "amount_total"),
        ("customer_invoices_unpaid", "account.move",
         [["move_type", "=", "out_invoice"], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]], "amount_residual"),
        ("vendor_bills_unpaid", "account.move",
         [["move_type", "=", "in_invoice"], ["state", "=", "posted"], ["payment_state", "in", ["not_paid", "partial"]]], "amount_residual"),
        ("purchase_orders_confirmed", "purchase.order", [["state", "in", ["purchase", "done"]], ["date_order", ">=", since]], "amount_total"),
        ("open_crm_opportunities", "crm.lead", [["type", "=", "opportunity"], ["probability", "<", 100], ["active", "=", True]], "expected_revenue"),
        ("customers", "res.partner", [["customer_rank", ">", 0]], None),
        ("sellable_products", "product.template", [["sale_ok", "=", True]], None),
    ]

    async def one(label, model, domain, sum_field):
        try:
            if not ctx.guard.model_allowed(model):
                return label, {"available": False}
            if sum_field:
                grp = await ctx.client.read_group(model, domain, [sum_field + ":sum"], [])
                row = (grp or [{}])[0]
                return label, {"count": row.get("__count", row.get("count", 0)), f"total_{sum_field}": _pick(row, sum_field + ":sum") or 0}
            return label, {"count": await ctx.client.search_count(model, domain)}
        except (OdooError, GuardError) as e:
            return label, {"available": False, "reason": str(e)[:120]}

    pairs = await asyncio.gather(*(one(*i) for i in items))
    return {
        "window_days": days,
        "since_utc": since,
        "metrics": dict(pairs),
        "note": "Amounts are in each document's own currency; on multi-currency databases totals may mix currencies.",
    }


# ── registry ─────────────────────────────────────────────────────────
_DOMAIN_HELP = ("Odoo domain: list of [field, operator, value] terms, optionally with '&','|','!' prefix operators. "
                "Example: [[\"state\",\"=\",\"sale\"],[\"date_order\",\">=\",\"2026-09-01\"]]. Dates are 'YYYY-MM-DD'.")

TOOLS: list[ToolSpec] = [
    ToolSpec("odoo_business_snapshot",
             "Headline KPIs across Sales, Purchasing, Invoicing (receivables/payables), CRM, customers and products for the last N days. "
             "Good first call for broad questions like 'how is the business doing'. Modules that aren't installed are reported as unavailable.",
             {"type": "object", "properties": {"days": {"type": "integer", "default": 30, "description": "Look-back window, 1-365."}}},
             h_snapshot),
    ToolSpec("odoo_list_models",
             "Find Odoo models (tables) by keyword in their technical or display name, e.g. 'sale', 'invoice', 'employee'.",
             {"type": "object", "properties": {"query": {"type": "string"}}}, h_list_models),
    ToolSpec("odoo_get_fields",
             "List the fields of a model (name -> type|label|relation|selection values). Call this before filtering/grouping on a model you haven't used yet.",
             {"type": "object", "properties": {"model": {"type": "string"}, "query": {"type": "string", "description": "Optional substring to narrow fields."}},
              "required": ["model"]}, h_get_fields),
    ToolSpec("odoo_search_read",
             "Read records from a model. Returns total_matching plus up to `limit` rows. Prefer odoo_aggregate for totals/rankings.",
             {"type": "object", "properties": {
                 "model": {"type": "string"}, "domain": {"type": "array", "description": _DOMAIN_HELP},
                 "fields": {"type": "array", "items": {"type": "string"}}, "limit": {"type": "integer", "default": 25},
                 "order": {"type": "string", "description": "e.g. 'date_order desc'"}}, "required": ["model"]}, h_search_read),
    ToolSpec("odoo_count", "Count records matching a domain.",
             {"type": "object", "properties": {"model": {"type": "string"}, "domain": {"type": "array", "description": _DOMAIN_HELP}},
              "required": ["model"]}, h_count),
    ToolSpec("odoo_aggregate",
             "Server-side grouped totals (Odoo read_group): sums/averages/counts grouped by one or more fields. "
             "groupby items may carry a date granularity, e.g. 'date_order:month'. measures like 'amount_total:sum' or '__count'.",
             {"type": "object", "properties": {
                 "model": {"type": "string"}, "domain": {"type": "array", "description": _DOMAIN_HELP},
                 "groupby": {"type": "array", "items": {"type": "string"}},
                 "measures": {"type": "array", "items": {"type": "string"}},
                 "order": {"type": "string", "description": "e.g. 'amount_total desc'"}, "limit": {"type": "integer", "default": 20}},
              "required": ["model", "groupby"]}, h_aggregate),
    ToolSpec("odoo_get_record", "Read one record by id.",
             {"type": "object", "properties": {"model": {"type": "string"}, "id": {"type": "integer"},
                                                "fields": {"type": "array", "items": {"type": "string"}}},
              "required": ["model", "id"]}, h_get_record),
]
TOOL_INDEX = {t.name: t for t in TOOLS}


async def run_tool(ctx: ToolContext, name: str, args: dict) -> dict:
    """Never raises: errors go back to the model as data so it can self-correct."""
    spec = TOOL_INDEX.get(name)
    if not spec:
        return {"error": f"Unknown tool '{name}'."}
    try:
        return await spec.handler(ctx, args if isinstance(args, dict) else {})
    except GuardError as e:
        return {"error": str(e)}
    except OdooError as e:
        return {"error": f"Odoo: {e}"}
    except (TypeError, ValueError, KeyError) as e:
        return {"error": f"Bad arguments: {e}"}
