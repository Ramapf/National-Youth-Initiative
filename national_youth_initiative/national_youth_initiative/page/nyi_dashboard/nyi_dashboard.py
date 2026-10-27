"""Data for the NYI Dashboard page.

One endpoint returns every Youth Programme Effects report the user may read (all three form
variants), already normalised. The page does all filtering, apportioning and charting client-side,
so the permission scope is applied exactly once, here, through frappe.get_list.
"""

import re

import frappe
from frappe.utils import cint, flt, getdate, now_datetime

# The cloud site has three variants of the same form; each stores the numbers in different fields.
SOURCES = [
	{
		"doctype": "Youth Programme- effects",
		"trainers": "no_of_field_trainers_field_workers",
		"youth": "number_of_youth_engaged_directly",
		"leaders": "no_of_youth_leaders",
		"maturity": "what_is_the_maturity_level_of_youth_groups",
		"sap": "listed_all_information_on_social_action_project",
	},
	{
		"doctype": "Youth Programme Effects",
		"trainers": "no_of_field_workers",
		"youth": "number_of_youth_engaged_directly",
		"leaders": "no_of_youth_leaders",
		"maturity": "maturity_level_youth",
		"sap": "social_action_project",
	},
	{
		"doctype": "Youth Programme - Effects",
		"trainers": "no_of_field_trainers_field_workers",
		"youth": "total_number",
		"leaders": "yl",
		"maturity": "what_is_the_maturity_level_of_youth_groups",
		"sap": "listed_all_information_on_social_action_project",
	},
]

MATURITY = {
	"Early stage groups": "emerging",
	"Active groups that need some support": "developing",
	"Independent groups engaged in continuous social actions": "mature",
}

# Block values people type when they don't know the block; counted as "block not specified".
UNKNOWN_BLOCK = re.compile(r"^\s*(do\s*n[o']?t\s*know|dont\s*know|na|n/a|nil|none|unknown|not\s*known|-+)\s*$", re.I)


def _int(value):
	"""First whole number in a Data field ("23", "23 groups") -> 23."""
	if isinstance(value, (int, float)):
		return int(value)
	m = re.search(r"\d+", str(value or "").replace(",", ""))
	return int(m.group()) if m else 0


def _children(meta, fieldname, parents, fields):
	df = meta.get_field(fieldname)
	if not df or df.fieldtype not in ("Table", "Table MultiSelect") or not parents:
		return {}
	rows = frappe.get_all(
		df.options,
		filters={"parent": ["in", parents], "parenttype": meta.name, "parentfield": fieldname},
		fields=["parent", *fields],
		order_by="idx asc",
		limit_page_length=0,
	)
	out = {}
	for r in rows:
		out.setdefault(r.parent, []).append(r)
	return out


def _year(r):
	dates = [getdate(d) for d in (r.reporting_from, r.reporting_to) if d]
	if not dates and r.date_of_filling_form:
		dates = [getdate(r.date_of_filling_form)]
	return max(dates).year if dates else None


def _load_source(src):
	dt = src["doctype"]
	if not frappe.db.exists("DocType", dt) or not frappe.has_permission(dt, "read"):
		return []
	meta = frappe.get_meta(dt)
	plain = [f for f in ("groups", "is_submitted", src["youth"], src["leaders"]) if meta.get_field(f) and not meta.get_field(f).fieldtype.startswith("Table")]
	parents = frappe.get_list(
		dt,
		filters={"docstatus": ["<", 2]},
		fields=["name", "name_of_the_organization", "reporting_from", "reporting_to", "date_of_filling_form", "docstatus", *plain],
		order_by="reporting_to desc",
		limit_page_length=0,
	)
	names = [p.name for p in parents]
	geo = _children(meta, "geography_covered", names, ["state", "district", "block", "area_type", "sub_area", "number_covered"])
	trainers = _children(meta, src["trainers"], names, ["field_wor", "count"])
	youth = _children(meta, src["youth"], names, ["total_number"])
	leaders = _children(meta, src["leaders"], names, ["yl"])
	maturity = _children(meta, src["maturity"], names, ["maturity", "total_number"])
	sap = _children(meta, src["sap"], names, ["project_name", "how_many_people_were_reached_through_social_action_project as reached"])

	submitted = (lambda p: p.docstatus == 1) if meta.is_submittable else (lambda p: cint(p.get("is_submitted")) == 1)
	reports = []
	for p in parents:
		mat = {"emerging": 0, "developing": 0, "mature": 0}
		for m in maturity.get(p.name, []):
			if m.maturity in MATURITY:
				mat[MATURITY[m.maturity]] += cint(m.total_number)
		actions = [s for s in sap.get(p.name, []) if (s.project_name or "").strip() or cint(s.reached)]

		rows = geo.get(p.name, [])
		total_cov = sum(max(cint(g.number_covered), 0) for g in rows)
		geo_rows = []
		for g in rows:
			block = None if not g.block or UNKNOWN_BLOCK.match(g.block) else g.block
			geo_rows.append(
				{
					"state": g.state or None,
					"district": g.district or None,
					"block": block,
					"block_raw": g.block or None,
					"area": g.area_type or None,
					"sub_area": g.sub_area or None,
					"covered": cint(g.number_covered),
					"w": (max(cint(g.number_covered), 0) / total_cov) if total_cov else 1 / len(rows),
				}
			)
		if not geo_rows:
			geo_rows = [{"state": None, "district": None, "block": None, "block_raw": None, "area": None, "sub_area": None, "covered": 0, "w": 1}]

		reports.append(
			{
				"doctype": dt,
				"name": p.name,
				"org": p.name_of_the_organization or None,
				"from": str(p.reporting_from) if p.reporting_from else None,
				"to": str(p.reporting_to) if p.reporting_to else None,
				"year": _year(p),
				"status": "Submitted" if submitted(p) else "Draft",
				"youth": sum(cint(y.total_number) for y in youth[p.name]) if p.name in youth else _int(p.get(src["youth"])),
				"groups": _int(p.get("groups")),
				"leaders": sum(cint(y.yl) for y in leaders[p.name]) if p.name in leaders else _int(p.get(src["leaders"])),
				"trainers": sum(cint(t.count) for t in trainers.get(p.name, [])),
				"maturity": mat,
				"actions": len(actions),
				"reach": sum(cint(s.reached) for s in actions),
				"geo": geo_rows,
			}
		)
	return reports


@frappe.whitelist()
def get_dashboard_data():
	reports = []
	for src in SOURCES:
		reports.extend(_load_source(src))
	return {"reports": reports, "generated_at": str(now_datetime())}
