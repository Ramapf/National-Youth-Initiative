frappe.pages["nyi-dashboard"].on_page_load = function (wrapper) {
	const page = frappe.ui.make_app_page({
		parent: wrapper,
		title: __("NYI Dashboard"),
		single_column: true,
	});
	wrapper.nyi = new NYIDashboard(page);
};

frappe.pages["nyi-dashboard"].on_page_show = function (wrapper) {
	wrapper.nyi && wrapper.nyi.resize();
};

const NYI_ASSETS = "/assets/national_youth_initiative";
const NYI_METHOD = "national_youth_initiative.national_youth_initiative.page.nyi_dashboard.nyi_dashboard.get_dashboard_data";

// metric key -> label; every metric is summed from the report and apportioned to its geography rows
const NYI_METRICS = {
	youth: __("Youth Engaged"),
	groups: __("Youth Groups"),
	leaders: __("Youth Leaders"),
	actions: __("Social Actions"),
	reach: __("Community Reach"),
};
const NYI_MATURITY = [
	["emerging", __("Emerging")],
	["developing", __("Developing")],
	["mature", __("Mature")],
];
const NYI_EMPTY = { year: "", org: "", state: "", district: "", block: "", area: "", status: "" };

const esc = (s) => frappe.utils.escape_html(s == null ? "" : String(s));
const norm = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z]/g, "");
const slug = (s) => String(s || "").toLowerCase().replace(/&/g, "and").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
const fmt = (n) => (n == null || isNaN(n) ? "—" : Math.round(n).toLocaleString("en-IN"));
const fmt1 = (n) => (n == null || !isFinite(n) ? "—" : n < 10 ? n.toFixed(1) : Math.round(n).toLocaleString("en-IN"));

class NYIDashboard {
	constructor(page) {
		this.page = page;
		this.F = { ...NYI_EMPTY };
		this.map_metric = "youth";
		this.table_sort = { key: "youth", dir: -1 };
		this.table_search = "";
		this.charts = {};
		this.district_geo = {};

		this.page.set_secondary_action(__("Refresh"), () => this.load(), "refresh");
		this.inject_css();
		this.$root = $(`<div class="nyi-root"></div>`).appendTo(this.page.main);
		this.$root.html(`<div class="nyi-loading text-muted">${__("Loading dashboard…")}</div>`);

		Promise.all([
			this.load_script(`${NYI_ASSETS}/js/lib/echarts.min.js`),
			fetch(`${NYI_ASSETS}/data/geo/india_states.json`).then((r) => r.json()),
		])
			.then(([, states]) => {
				this.state_index = {};
				states.features.forEach((f) => {
					[f.properties.name, ...(f.properties.names || [])].forEach((n) => (this.state_index[norm(n)] = f.properties.name));
				});
				echarts.registerMap("nyi-india", states);
				this.render_shell();
				this.load();
			})
			.catch((e) => {
				console.error(e);
				this.$root.html(`<div class="nyi-loading text-danger">${__("Could not load the map/chart library.")}</div>`);
			});

		new MutationObserver(() => this.data && this.render_all()).observe(document.documentElement, {
			attributes: true,
			attributeFilter: ["data-theme"],
		});
	}

	load_script(src) {
		if (window.echarts) return Promise.resolve();
		return new Promise((resolve, reject) => {
			const s = document.createElement("script");
			s.src = src;
			s.onload = resolve;
			s.onerror = reject;
			document.head.appendChild(s);
		});
	}

	load() {
		return frappe.call({ method: NYI_METHOD, freeze: !this.data }).then((r) => {
			const data = r.message || { reports: [] };
			// one spelling per state, matching the map (Kashmir / Jammu and Kashmir -> Jammu & Kashmir)
			data.reports.forEach((rep) => rep.geo.forEach((g) => (g.state = g.state && (this.state_index[norm(g.state)] || g.state))));
			this.data = data;
			this.$root.find(".nyi-updated").text(__("Updated {0}", [String(data.generated_at).slice(11, 16)]));
			this.render_all();
		});
	}

	// ---------- filtering & aggregation ----------

	report_ok(r) {
		const F = this.F;
		if (F.year && String(r.year || "none") !== F.year) return false;
		if (F.org && r.org !== F.org) return false;
		if (F.status && r.status !== F.status) return false;
		return true;
	}

	geo_ok(g, skip = {}) {
		const F = this.F;
		if (!skip.state && F.state && g.state !== F.state) return false;
		if (!skip.district && F.district && g.district !== F.district) return false;
		if (!skip.block && F.block && g.block !== F.block) return false;
		if (F.area && g.area !== F.area) return false;
		return true;
	}

	// matched (report, geography row) pairs; skip lets the map ignore its own level's filter
	pairs(skip = {}) {
		const out = [];
		this.data.reports.forEach((r) => {
			if (!this.report_ok(r)) return;
			r.geo.forEach((g) => this.geo_ok(g, skip) && out.push({ r, g }));
		});
		return out;
	}

	aggregate(pairs, key_fn) {
		const groups = new Map();
		pairs.forEach(({ r, g }) => {
			const key = key_fn(r, g);
			if (key == null) return;
			let a = groups.get(key);
			if (!a) {
				a = { key, youth: 0, groups: 0, leaders: 0, actions: 0, reach: 0, trainers: 0, emerging: 0, developing: 0, mature: 0, reports: new Set(), orgs: new Set(), status: new Set(), g };
				groups.set(key, a);
			}
			["youth", "groups", "leaders", "actions", "reach", "trainers"].forEach((m) => (a[m] += (r[m] || 0) * g.w));
			NYI_MATURITY.forEach(([m]) => (a[m] += (r.maturity[m] || 0) * g.w));
			a.reports.add(r);
			r.org && a.orgs.add(r.org);
			a.status.add(r.status);
		});
		return [...groups.values()];
	}

	compute() {
		const pairs = this.pairs();
		const reports = new Map();
		pairs.forEach(({ r, g }) => reports.set(r, (reports.get(r) || 0) + g.w));
		const total = this.aggregate(pairs, () => "all")[0] || { youth: 0, groups: 0, leaders: 0, actions: 0, reach: 0, trainers: 0, orgs: new Set() };

		const area = {};
		const seen = new Set();
		let villages = 0;
		let no_block = 0;
		pairs.forEach(({ g }) => {
			const k = `${g.state}|${g.district}|${g.block || ""}`;
			if (!seen.has(k)) {
				seen.add(k);
				if (g.area) area[g.area] = (area[g.area] || 0) + 1;
			}
			if (g.sub_area === "Villages") villages += g.covered || 0;
			if (!g.block && g.district) no_block++;
		});
		const distinct = (fn) => new Set(pairs.map(({ g }) => fn(g)).filter((v) => v)).size;
		const years = [...new Set([...reports.keys()].map((r) => r.year).filter((y) => y))].sort();

		return {
			pairs,
			reports,
			total,
			orgs: total.orgs.size,
			states: distinct((g) => g.state),
			districts: distinct((g) => g.district && `${g.state}|${g.district}`),
			blocks: distinct((g) => g.block && `${g.state}|${g.district}|${g.block}`),
			no_block,
			area,
			villages,
			years,
		};
	}

	// chart grouping follows the drill level: districts, or the blocks of the chosen district
	level() {
		return this.F.district || this.F.block ? "block" : "district";
	}

	level_groups(pairs) {
		const block_level = this.level() === "block";
		const rows = this.aggregate(pairs, (r, g) => (block_level ? `${g.state}|${g.district}|${g.block || ""}` : g.district ? `${g.state}|${g.district}` : null));
		rows.forEach((a) => {
			a.label = block_level ? a.g.block || __("Block not specified") : a.g.district;
			a.sub = block_level ? `${a.g.district}, ${a.g.state || ""}` : a.g.state || "";
		});
		return rows;
	}

	// ---------- shell ----------

	render_shell() {
		const card = (id, title, tip) => `
			<div class="nyi-card" data-card="${id}" tabindex="0" role="button">
				<div class="nyi-card-head"><span class="nyi-card-title">${esc(title)}</span>
					<span class="nyi-info" title="${esc(tip)}" aria-label="${esc(tip)}">ⓘ</span></div>
				<div class="nyi-card-value" data-v="${id}">—</div>
				<div class="nyi-card-sub" data-s="${id}"></div>
			</div>`;
		const filt = (id, label) => `
			<label class="nyi-filter"><span>${esc(label)}</span>
				<select class="form-control input-sm" data-f="${id}"></select></label>`;
		const info = (tip) => `<span class="nyi-info" title="${esc(tip)}" aria-label="${esc(tip)}">ⓘ</span>`;
		const apportion = __("Where a report covers several locations, its numbers are shared across them by the sub-areas covered in each row (equal shares when that is blank).");

		this.$root.html(`
			<div class="nyi-filters">
				${filt("year", __("Reporting Year"))}
				${filt("org", __("Organisation"))}
				${filt("state", __("State"))}
				${filt("district", __("District"))}
				${filt("block", __("Block"))}
				${filt("area", __("Area Type"))}
				${filt("status", __("Reporting Status"))}
				<div class="nyi-filter-actions">
					<button class="btn btn-default btn-sm" data-action="reset">${__("Reset")}</button>
					<span class="nyi-updated text-muted"></span>
				</div>
			</div>

			<div class="nyi-section-title">${__("Summary")}</div>
			<div class="nyi-grid">
				${card("orgs", __("Organisations Reporting"), __("Organisations with at least one report in the current filters."))}
				${card("states", __("States Covered"), __("Distinct states in the Geography Covered rows of matching reports."))}
				${card("districts", __("Districts"), __("Distinct districts in the Geography Covered rows of matching reports."))}
				${card("blocks", __("Blocks"), __("Distinct named blocks. Rows where the block was entered as 'dont know' / 'NA' are not counted as blocks."))}
				${card("area", __("Area Type (Urban / Rural)"), __("Number of locations by area type. A location is a block, or the district when no block was entered."))}
				${card("trainers", __("Field Trainers"), __("Sum of 'No. of field workers' across matching reports.") + " " + apportion)}
				${card("year", __("Reporting Year"), __("Calendar year January–December, aligned with the Summary of Effects (SoE). A report counts in the year its reporting period ends."))}
			</div>

			<div class="nyi-section-title">${__("Youth Journey")}</div>
			<div class="nyi-grid">
				${card("youth", __("Youth Engaged"), __("Sum of 'Number of youth engaged directly'.") + " " + apportion)}
				${card("groups", __("Youth Groups"), __("Sum of 'Number of youth groups formed'.") + " " + apportion)}
				${card("leaders", __("Youth Leaders"), __("Sum of 'No. of youth leaders identified and trained'.") + " " + apportion)}
				${card("actions", __("Social Actions"), __("Number of social action projects listed in the reports.") + " " + apportion)}
				${card("reach", __("Community Members Reached"), __("Sum of people reached through social action projects.") + " " + apportion)}
				${card("avg", __("Avg Youth per Group"), __("Youth Engaged ÷ Youth Groups for the current filters."))}
				${card("villages", __("Villages Covered"), __("Sum of 'Sub area number covered' on geography rows whose sub area type is Villages."))}
			</div>

			<div class="nyi-panel">
				<div class="nyi-panel-head">
					<div>
						<div class="nyi-panel-title">${__("Geographic Coverage")}</div>
						<div class="nyi-crumbs"></div>
					</div>
					<label class="nyi-inline">${__("Colour by")}
						<select class="form-control input-sm" data-action="map-metric">
							${Object.entries(NYI_METRICS).map(([k, v]) => `<option value="${k}">${esc(v)}</option>`).join("")}
						</select></label>
				</div>
				<div class="nyi-map-wrap">
					<div class="nyi-map" data-chart="map"></div>
					<div class="nyi-map-side">
						<div class="nyi-side-title"></div>
						<div class="nyi-side-list"></div>
					</div>
				</div>
				<div class="nyi-note">${__("Click a state, then a district, to filter the whole dashboard. Block boundaries are not available, so blocks are picked from the list.")}
					${__("Boundaries: DataMeet (CC BY 4.0); districts as per Census 2011.")}</div>
			</div>

			<div class="nyi-two">
				<div class="nyi-panel">
					<div class="nyi-panel-head"><div class="nyi-panel-title" data-title="journey"></div>
						${info(__("Youth engaged, youth groups and youth leaders side by side for each location. Click a bar to drill down.") + " " + apportion)}</div>
					<div class="nyi-chart" data-chart="journey"></div>
				</div>
				<div class="nyi-panel">
					<div class="nyi-panel-head"><div class="nyi-panel-title" data-title="maturity"></div>
						${info(__("Share of youth groups at each maturity level. Emerging = early stage groups; Developing = active groups that need some support; Mature = independent groups engaged in continuous social actions."))}</div>
					<div class="nyi-chart" data-chart="maturity"></div>
				</div>
			</div>

			<div class="nyi-panel">
				<div class="nyi-panel-head"><div class="nyi-panel-title" data-title="actions"></div>
					${info(__("Number of social action projects per location. Click a bar to drill down.") + " " + apportion)}</div>
				<div class="nyi-actions-wrap">
					<div class="nyi-chart" data-chart="actions"></div>
					${card("per_action", __("Average People Reached per Social Action"), __("Community Reach ÷ Number of Social Actions for the current filters."))}
				</div>
			</div>

			<div class="nyi-panel">
				<div class="nyi-panel-head">
					<div class="nyi-panel-title">${__("Performance Table")}</div>
					<div class="nyi-table-tools">
						<input class="form-control input-sm" data-action="search" placeholder="${esc(__("Search location"))}">
						<button class="btn btn-default btn-sm" data-action="csv">${__("Export CSV")}</button>
					</div>
				</div>
				<div class="nyi-table-wrap" data-table="perf"></div>
			</div>
		`);

		this.$root.on("change", "[data-f]", (e) => this.set_filter(e.target.dataset.f, e.target.value));
		this.$root.on("click", "[data-action=reset]", () => this.apply({ ...NYI_EMPTY }));
		this.$root.on("change", "[data-action=map-metric]", (e) => {
			this.map_metric = e.target.value;
			this.render_map();
		});
		this.$root.on(
			"input",
			"[data-action=search]",
			frappe.utils.debounce((e) => {
				this.table_search = e.target.value.toLowerCase();
				this.render_table(this.computed);
			}, 200)
		);
		this.$root.on("click", "[data-action=csv]", () => this.export_csv(this.perf_columns(), this.perf_rows, "nyi-performance"));
		this.$root.on("click keydown", ".nyi-card", (e) => {
			if (e.type === "keydown" && e.key !== "Enter") return;
			if ($(e.target).hasClass("nyi-info")) return;
			this.card_drill(e.currentTarget.dataset.card);
		});
		this.$root.on("click", "[data-crumb]", (e) => {
			const lvl = e.currentTarget.dataset.crumb;
			const F = { ...this.F };
			if (lvl === "india") Object.assign(F, { state: "", district: "", block: "" });
			if (lvl === "state") Object.assign(F, { district: "", block: "" });
			if (lvl === "district") F.block = "";
			this.apply(F);
		});
		this.$root.on("click", "[data-pick]", (e) => {
			const level = { state: "state", district: "district", block: "block" }[e.currentTarget.dataset.level];
			this.pick_place(JSON.parse(decodeURIComponent(e.currentTarget.dataset.pick)), level);
		});

		["map", "journey", "maturity", "actions"].forEach((k) => {
			this.charts[k] = echarts.init(this.$root.find(`[data-chart=${k}]`)[0]);
		});
		this.charts.map.on("click", (p) => this.map_click(p));
		["journey", "maturity", "actions"].forEach((k) =>
			this.charts[k].on("click", (p) => {
				const row = (this[`${k}_rows`] || [])[p.dataIndex];
				row && this.pick_place(row.g, this.level());
			})
		);
		new ResizeObserver(frappe.utils.debounce(() => this.resize(), 100)).observe(this.$root[0]);
	}

	set_filter(key, value) {
		const F = { ...this.F, [key]: value };
		if (key === "state") Object.assign(F, { district: "", block: "" });
		if (key === "district") {
			F.block = "";
			if (value) [F.state, F.district] = value.split("|");
		}
		if (key === "block" && value) [F.state, F.district, F.block] = value.split("|");
		this.apply(F);
	}

	// select a place from the map, side list or a bar; level says how deep to go
	pick_place(g, level) {
		const F = { ...this.F };
		if (level === "state") Object.assign(F, { state: g.state, district: "", block: "" });
		else if (level === "district") Object.assign(F, { state: g.state, district: g.district, block: "" });
		else Object.assign(F, { state: g.state, district: g.district, block: g.block || "" });
		this.apply(F);
	}

	apply(F) {
		this.F = F;
		this.render_all();
	}

	resize() {
		Object.values(this.charts).forEach((c) => c && c.resize());
	}

	// ---------- rendering ----------

	render_all() {
		if (!this.data) return;
		this.colors = this.read_colors();
		const C = (this.computed = this.compute());
		this.render_filters();
		this.render_cards(C);
		this.render_map();
		this.render_charts(C);
		this.render_table(C);
	}

	read_colors() {
		const css = getComputedStyle(this.$root[0]);
		const v = (n) => css.getPropertyValue(n).trim();
		return {
			s: [v("--nyi-s1"), v("--nyi-s2"), v("--nyi-s3")],
			m: [v("--nyi-m1"), v("--nyi-m2"), v("--nyi-m3")],
			ramp: v("--nyi-ramp").split(",").map((x) => x.trim()),
			surface: v("--nyi-surface"),
			text: v("--nyi-text"),
			muted: v("--nyi-muted"),
			grid: v("--nyi-grid"),
			nodata: v("--nyi-nodata"),
			hi: v("--nyi-hi"),
		};
	}

	render_filters() {
		const all = this.data.reports;
		const geo = [];
		all.forEach((r) => r.geo.forEach((g) => geo.push(g)));
		const F = this.F;
		const uniq = (arr) => [...new Map(arr.map((o) => [o.value, o])).values()];
		const by_label = (a, b) => a.label.localeCompare(b.label);

		const years = [...new Set(all.map((r) => String(r.year || "none")))].sort().reverse();
		const opts = {
			year: years.map((y) => ({ value: y, label: y === "none" ? __("Year not set") : __("{0} (Jan–Dec)", [y]) })),
			org: uniq(all.filter((r) => r.org).map((r) => ({ value: r.org, label: r.org }))).sort(by_label),
			state: uniq(geo.filter((g) => g.state).map((g) => ({ value: g.state, label: g.state }))).sort(by_label),
			// options narrow under the chosen state/district, but every level stays selectable on its own
			district: uniq(
				geo
					.filter((g) => g.district && (!F.state || g.state === F.state))
					.map((g) => ({ value: `${g.state}|${g.district}`, label: F.state ? g.district : `${g.district} (${g.state || "—"})` }))
			).sort(by_label),
			block: uniq(
				geo
					.filter((g) => g.block && (!F.state || g.state === F.state) && (!F.district || g.district === F.district))
					.map((g) => ({ value: `${g.state}|${g.district}|${g.block}`, label: F.district ? g.block : `${g.block} (${g.district})` }))
			).sort(by_label),
			area: uniq(geo.filter((g) => g.area).map((g) => ({ value: g.area, label: g.area }))).sort(by_label),
			status: [
				{ value: "Submitted", label: __("Submitted") },
				{ value: "Draft", label: __("Draft") },
			],
		};
		const any = { year: __("All years"), org: __("All organisations"), state: __("All states"), district: __("All districts"), block: __("All blocks"), area: __("Urban & Rural"), status: __("All") };
		const current = {
			...F,
			district: F.district ? `${F.state}|${F.district}` : "",
			block: F.block ? `${F.state}|${F.district}|${F.block}` : "",
		};
		Object.entries(opts).forEach(([k, list]) => {
			const $s = this.$root.find(`[data-f=${k}]`);
			$s.html(`<option value="">${esc(any[k])}</option>` + list.map((o) => `<option value="${esc(o.value)}">${esc(o.label)}</option>`).join(""));
			$s.val(current[k]);
			$s.toggleClass("nyi-active", !!current[k]);
		});
	}

	set_card(id, value_html, sub) {
		this.$root.find(`[data-v=${id}]`).html(value_html);
		this.$root.find(`[data-s=${id}]`).text(sub || "");
	}

	render_cards(C) {
		const T = C.total;
		const n = C.reports.size;
		const from = n === 1 ? __("from 1 report") : __("from {0} reports", [fmt(n)]);
		this.set_card("orgs", fmt(C.orgs), from);
		this.set_card("states", fmt(C.states), "");
		this.set_card("districts", fmt(C.districts), "");
		this.set_card("blocks", fmt(C.blocks), C.no_block ? __("+{0} rows with no block named", [C.no_block]) : "");
		const area = Object.entries(C.area).sort();
		this.set_card(
			"area",
			area.length ? area.map(([k, v]) => `<span class="nyi-area"><small>${esc(k)}</small>${fmt(v)}</span>`).join("") : "—",
			__("locations")
		);
		this.set_card("trainers", fmt(T.trainers), from);
		const yr = this.F.year && this.F.year !== "none" ? this.F.year : null;
		const span = C.years.length ? (C.years[0] === C.years.at(-1) ? C.years[0] : `${C.years[0]}–${C.years.at(-1)}`) : "—";
		this.set_card("year", yr ? esc(yr) : `<span class="nyi-small-value">${esc(span)}</span>`, yr ? __("Jan – Dec {0}", [yr]) : __("All years · calendar Jan–Dec"));
		this.set_card("youth", fmt(T.youth), from);
		this.set_card("groups", fmt(T.groups), from);
		this.set_card("leaders", fmt(T.leaders), from);
		this.set_card("actions", fmt(T.actions), from);
		this.set_card("reach", fmt(T.reach), from);
		this.set_card("avg", T.groups ? fmt1(T.youth / T.groups) : "—", __("youth per group"));
		this.set_card("villages", fmt(C.villages), __("villages listed"));
		this.set_card("per_action", T.actions ? fmt(T.reach / T.actions) : "—", __("Community Reach ÷ Social Actions"));
	}

	// ---------- map ----------

	async render_map() {
		const F = this.F;
		const metric = this.map_metric;
		const label = NYI_METRICS[metric];
		const crumbs = [`<a data-crumb="india">${__("India")}</a>`];
		if (F.state) crumbs.push(`<a data-crumb="state">${esc(F.state)}</a>`);
		if (F.district) crumbs.push(`<a data-crumb="district">${esc(F.district)}</a>`);
		if (F.block) crumbs.push(`<span>${esc(F.block)}</span>`);
		this.$root.find(".nyi-crumbs").html(crumbs.join(" › "));

		let map_name, index, side_rows, side_title, side_level, map_rows;
		if (!F.state) {
			map_rows = side_rows = this.aggregate(this.pairs({ state: true, district: true, block: true }), (r, g) => g.state);
			side_rows.forEach((a) => (a.label = a.g.state));
			map_name = "nyi-india";
			index = this.state_index;
			side_title = __("States");
			side_level = "state";
		} else {
			const geo = await this.get_district_geo(F.state);
			if (this.F !== F) return; // filters changed while the district map was loading
			map_rows = this.aggregate(this.pairs({ district: true, block: true }), (r, g) => g.district);
			map_rows.forEach((a) => (a.label = a.g.district));
			map_name = geo ? `nyi-st-${slug(F.state)}` : null;
			index = geo ? geo.index : {};
			side_rows = map_rows;
			side_title = __("Districts in {0}", [F.state]);
			side_level = "district";
			if (F.district) {
				side_rows = this.aggregate(this.pairs({ block: true }), (r, g) => g.block || "");
				side_rows.forEach((a) => (a.label = a.g.block || __("Block not specified")));
				side_title = __("Blocks in {0}", [F.district]);
				side_level = "block";
			}
		}

		// side list: every place at this level, so places without a polygon are never hidden
		side_rows.sort((a, b) => b[metric] - a[metric]);
		const max = Math.max(1, ...side_rows.map((a) => a[metric]));
		this.$root.find(".nyi-side-title").text(`${side_title} · ${label}`);
		this.$root.find(".nyi-side-list").html(
			side_rows.length
				? side_rows
						.map((a) => {
							const active = (side_level === "block" && F.block && a.g.block === F.block) || (side_level === "district" && F.district && a.g.district === F.district);
							const clickable = side_level !== "block" || a.g.block;
							return `<div class="nyi-side-row ${active ? "is-active" : ""} ${clickable ? "" : "is-static"}"
								${clickable ? `data-pick="${encodeURIComponent(JSON.stringify(a.g))}" data-level="${side_level}"` : ""}>
								<span class="nyi-side-name" title="${esc(a.label)}">${esc(a.label)}</span>
								<span class="nyi-side-bar"><i style="width:${((a[metric] / max) * 100).toFixed(1)}%"></i></span>
								<span class="nyi-side-val">${fmt(a[metric])}</span></div>`;
						})
						.join("")
				: `<div class="text-muted nyi-empty-small">${__("No reports match these filters.")}</div>`
		);

		const chart = this.charts.map;
		const c = this.colors;
		if (!map_name) {
			chart.clear();
			chart.setOption({ title: { text: __("No map available for {0}", [F.state]), left: "center", top: "middle", textStyle: { color: c.muted, fontSize: 13, fontWeight: 400 } } });
			return;
		}
		// colour polygons; with a district chosen the map stays on the state's districts
		const values = {};
		this.map_lookup = {};
		this.map_level = F.state ? "district" : "state";
		map_rows.forEach((a) => {
			const feature = index[norm(a.label)];
			if (!feature) return;
			values[feature] = (values[feature] || 0) + a[metric];
			if (!this.map_lookup[feature] || this.map_lookup[feature][metric] < a[metric]) this.map_lookup[feature] = a;
		});
		const vmax = Math.max(1, ...Object.values(values));
		const selected = F.district ? index[norm(F.district)] : null;
		chart.setOption(
			{
				tooltip: {
					trigger: "item",
					backgroundColor: c.surface,
					borderColor: c.grid,
					textStyle: { color: c.text, fontSize: 12 },
					formatter: (p) => {
						const a = this.map_lookup[p.name];
						return a
							? `<b>${esc(p.name)}</b><br>${esc(label)}: <b>${fmt(values[p.name])}</b><br><span style="opacity:.7">${__("{0} report(s)", [a.reports.size])}</span>`
							: `<b>${esc(p.name)}</b><br><span style="opacity:.7">${__("No reports")}</span>`;
					},
				},
				visualMap: {
					min: 0,
					max: vmax,
					orient: "horizontal",
					left: 8,
					bottom: 4,
					itemWidth: 10,
					itemHeight: 120,
					text: [fmt(vmax), "0"],
					textStyle: { color: c.muted, fontSize: 11 },
					inRange: { color: c.ramp },
					calculable: false,
				},
				series: [
					{
						type: "map",
						map: map_name,
						roam: false,
						aspectScale: this.aspect(map_name),
						layoutCenter: ["50%", "48%"],
						layoutSize: "95%",
						selectedMode: false,
						label: { show: false },
						emphasis: { label: { show: false }, itemStyle: { areaColor: c.hi } },
						itemStyle: { areaColor: c.nodata, borderColor: c.surface, borderWidth: 0.8 },
						data: Object.entries(values).map(([name, value]) => ({
							name,
							value,
							itemStyle: name === selected ? { borderColor: c.text, borderWidth: 2 } : undefined,
						})),
					},
				],
			},
			true
		);
	}

	// degrees of longitude are shorter than latitude away from the equator
	aspect(map_name) {
		const lat = map_name === "nyi-india" ? 22 : this.district_geo_lat || 22;
		return Math.cos((lat * Math.PI) / 180);
	}

	async get_district_geo(state) {
		const key = slug(state);
		if (!(key in this.district_geo)) {
			this.district_geo[key] = fetch(`${NYI_ASSETS}/data/geo/districts/${key}.json`)
				.then((r) => (r.ok ? r.json() : null))
				.then((gj) => {
					if (!gj) return null;
					echarts.registerMap(`nyi-st-${key}`, gj);
					const index = {};
					let lat = 0;
					let cnt = 0;
					const walk = (c) => (typeof c[0] === "number" ? ((lat += c[1]), cnt++) : c.forEach(walk));
					gj.features.forEach((f) => {
						[f.properties.name, ...(f.properties.names || [])].forEach((n) => (index[norm(n)] = f.properties.name));
						walk(f.geometry.coordinates);
					});
					return { index, lat: cnt ? lat / cnt : 22 };
				})
				.catch(() => null);
		}
		const geo = await this.district_geo[key];
		this.district_geo_lat = geo && geo.lat;
		return geo;
	}

	map_click(p) {
		const a = this.map_lookup && this.map_lookup[p.name];
		if (!a) {
			frappe.show_alert({ message: __("No reports for {0} in the current filters", [p.name]), indicator: "orange" });
			return;
		}
		this.pick_place(a.g, this.map_level);
	}

	// ---------- charts ----------

	render_charts(C) {
		const c = this.colors;
		const block_level = this.level() === "block";
		const place = block_level ? __("Block") : __("District");
		const where = block_level ? __("in {0}", [this.F.district]) : this.F.state ? __("in {0}", [this.F.state]) : "";
		this.$root.find("[data-title=journey]").text(`${__("Youth Journey by {0}", [place])} ${where}`);
		this.$root.find("[data-title=maturity]").text(`${__("Youth Group Maturity by {0}", [place])} ${where}`);
		this.$root.find("[data-title=actions]").text(`${__("Social Actions by {0}", [place])} ${where}`);

		const rows = this.level_groups(C.pairs);
		const axis = {
			axisLine: { lineStyle: { color: c.grid } },
			axisTick: { show: false },
			axisLabel: { color: c.muted, fontSize: 11 },
			splitLine: { lineStyle: { color: c.grid } },
		};
		const legend = { top: 4, left: 0, textStyle: { color: c.text }, itemWidth: 12, itemHeight: 12, icon: "roundRect" };
		const tooltip = {
			trigger: "axis",
			confine: true,
			backgroundColor: c.surface,
			borderColor: c.grid,
			textStyle: { color: c.text, fontSize: 12 },
			axisPointer: { type: "shadow", shadowStyle: { color: c.grid, opacity: 0.4 } },
		};
		const head = (a) => `<b>${esc(a.label)}</b> <span style="opacity:.7">${esc(a.sub)}</span><br>`;
		const empty = (chart) => {
			chart.clear();
			chart.setOption({ title: { text: __("No reports match these filters."), left: "center", top: "middle", textStyle: { color: c.muted, fontSize: 13, fontWeight: 400 } } });
		};
		const zoom = (n) => (n > 12 ? [{ type: "slider", height: 14, bottom: 4, startValue: 0, endValue: 11, showDetail: false, brushSelect: false }, { type: "inside" }] : []);
		const cat_axis = (list) => ({
			type: "category",
			data: list.map((a) => a.label),
			...axis,
			axisLabel: { ...axis.axisLabel, interval: 0, rotate: list.length > 6 ? 30 : 0, formatter: (v) => (v.length > 16 ? v.slice(0, 15) + "…" : v) },
		});

		// Section 3 - clustered bars
		const J = (this.journey_rows = [...rows].sort((a, b) => b.youth - a.youth));
		if (!J.length) empty(this.charts.journey);
		else
			this.charts.journey.setOption(
				{
					color: c.s,
					grid: { left: 28, right: 12, top: 40, bottom: J.length > 12 ? 34 : 8, containLabel: true },
					legend,
					tooltip: { ...tooltip, formatter: (ps) => head(J[ps[0].dataIndex]) + ps.map((p) => `${p.marker}${esc(p.seriesName)}: <b>${fmt(p.value)}</b>`).join("<br>") },
					xAxis: cat_axis(J),
					yAxis: { type: "value", ...axis, axisLabel: { ...axis.axisLabel, formatter: (v) => fmt(v) } },
					dataZoom: zoom(J.length),
					series: ["youth", "groups", "leaders"].map((m) => ({
						name: NYI_METRICS[m],
						type: "bar",
						barMaxWidth: 18,
						barGap: "15%",
						cursor: "pointer",
						itemStyle: { borderRadius: [4, 4, 0, 0] },
						data: J.map((a) => Math.round(a[m])),
					})),
				},
				true
			);

		// Section 4 - 100% stacked maturity
		const M = (this.maturity_rows = rows
			.map((a) => Object.assign(a, { mat_total: NYI_MATURITY.reduce((s, [k]) => s + a[k], 0) }))
			.filter((a) => a.mat_total > 0)
			.sort((a, b) => b.mature / b.mat_total - a.mature / a.mat_total || b.mat_total - a.mat_total));
		if (!M.length) empty(this.charts.maturity);
		else
			this.charts.maturity.setOption(
				{
					color: c.m,
					grid: { left: 28, right: 12, top: 40, bottom: M.length > 12 ? 34 : 8, containLabel: true },
					legend,
					tooltip: {
						...tooltip,
						formatter: (ps) => {
							const a = M[ps[0].dataIndex];
							return head(a) + ps.map((p, i) => `${p.marker}${esc(p.seriesName)}: <b>${p.value.toFixed(0)}%</b> <span style="opacity:.7">(${fmt(a[NYI_MATURITY[i][0]])} ${__("groups")})</span>`).join("<br>");
						},
					},
					xAxis: cat_axis(M),
					yAxis: { type: "value", max: 100, ...axis, axisLabel: { ...axis.axisLabel, formatter: "{value}%" } },
					dataZoom: zoom(M.length),
					series: NYI_MATURITY.map(([k, name]) => ({
						name,
						type: "bar",
						stack: "m",
						barMaxWidth: 34,
						cursor: "pointer",
						itemStyle: { borderColor: c.surface, borderWidth: 1 },
						data: M.map((a) => (a[k] / a.mat_total) * 100),
					})),
				},
				true
			);

		// Section 5 - horizontal bars, largest on top
		const A = (this.actions_rows = rows.filter((a) => a.actions > 0).sort((a, b) => a.actions - b.actions));
		this.$root.find("[data-chart=actions]").css("height", Math.max(220, A.length * 26 + 40));
		this.charts.actions.resize();
		if (!A.length) empty(this.charts.actions);
		else
			this.charts.actions.setOption(
				{
					color: [c.s[0]],
					grid: { left: 8, right: 48, top: 8, bottom: 8, containLabel: true },
					tooltip: {
						...tooltip,
						formatter: (ps) => {
							const a = A[ps[0].dataIndex];
							return head(a) + `${__("Social Actions")}: <b>${fmt(a.actions)}</b><br>${__("Community Reach")}: ${fmt(a.reach)}<br>${__("People per action")}: ${fmt(a.reach / a.actions)}`;
						},
					},
					xAxis: { type: "value", ...axis, axisLabel: { ...axis.axisLabel, formatter: (v) => fmt(v) } },
					yAxis: { type: "category", data: A.map((a) => a.label), ...axis, axisLabel: { ...axis.axisLabel, formatter: (v) => (v.length > 22 ? v.slice(0, 21) + "…" : v) } },
					series: [
						{
							name: __("Social Actions"),
							type: "bar",
							barMaxWidth: 16,
							cursor: "pointer",
							itemStyle: { borderRadius: [0, 4, 4, 0] },
							label: { show: true, position: "right", color: c.muted, fontSize: 11, formatter: (p) => (p.value < 1 ? p.value.toFixed(1) : fmt(p.value)) },
							data: A.map((a) => a.actions),
						},
					],
				},
				true
			);
	}

	// ---------- performance table ----------

	perf_columns() {
		return [
			{ key: "state", label: __("State") },
			{ key: "district", label: __("District") },
			{ key: "block", label: __("Block") },
			{ key: "youth", label: __("Youth"), num: true },
			{ key: "groups", label: __("Groups"), num: true },
			{ key: "leaders", label: __("Leaders"), num: true },
			{ key: "actions", label: __("Social Actions"), num: true },
			{ key: "reach", label: __("Community Reach"), num: true },
			{ key: "status", label: __("Reporting Status"), status: true },
		];
	}

	render_table(C) {
		const q = this.table_search;
		const ns = __("Not specified");
		const rows = this.aggregate(C.pairs, (r, g) => `${g.state}|${g.district}|${g.block || ""}`)
			.map((a) => ({
				state: a.g.state || ns,
				district: a.g.district || ns,
				block: a.g.block || ns,
				youth: a.youth,
				groups: a.groups,
				leaders: a.leaders,
				actions: a.actions,
				reach: a.reach,
				status: a.status.size > 1 ? __("Partly submitted") : [...a.status][0],
				_reports: [...a.reports],
				_g: a.g,
			}))
			.filter((r) => !q || `${r.state} ${r.district} ${r.block}`.toLowerCase().includes(q));
		this.perf_rows = rows;
		this.render_grid(this.$root.find("[data-table=perf]"), this.perf_columns(), rows, this.table_sort, {
			total: true,
			on_row: (row) => this.reports_dialog(__("Reports for {0}", [[row.block, row.district, row.state].filter((x) => x !== ns).join(", ")]), row._reports, row._g),
		});
	}

	// shared sortable table used on the page and inside drilldowns
	render_grid($wrap, cols, rows, sort, opts = {}) {
		const draw = () => {
			const sorted = [...rows].sort((a, b) => {
				const x = a[sort.key];
				const y = b[sort.key];
				return (typeof x === "number" && typeof y === "number" ? x - y : String(x ?? "").localeCompare(String(y ?? ""))) * sort.dir;
			});
			const cell = (col, r) => {
				const v = r[col.key];
				if (col.num) return `<td class="nyi-num">${col.pct ? (v == null ? "—" : v.toFixed(0) + "%") : fmt(v)}</td>`;
				if (col.status) return `<td><span class="nyi-status nyi-status-${slug(v)}">${esc(v)}</span></td>`;
				if (col.link) return `<td><a href="${esc(r._link)}" target="_blank" rel="noopener">${esc(v)}</a></td>`;
				return `<td title="${esc(v)}">${esc(v)}</td>`;
			};
			const totals = opts.total
				? `<tfoot><tr>${cols.map((col, i) => (col.num && !col.pct ? `<td class="nyi-num">${fmt(rows.reduce((s, r) => s + (r[col.key] || 0), 0))}</td>` : `<td>${i === 0 ? __("Total") : ""}</td>`)).join("")}</tr></tfoot>`
				: "";
			$wrap.html(
				rows.length
					? `<table class="nyi-table"><thead><tr>${cols
							.map((col) => `<th data-sort="${col.key}" class="${col.num ? "nyi-num" : ""}">${esc(col.label)}${sort.key === col.key ? (sort.dir > 0 ? " ▲" : " ▼") : ""}</th>`)
							.join("")}</tr></thead><tbody>${sorted
							.map((r, i) => `<tr data-i="${i}" class="${opts.on_row ? "is-click" : ""}">${cols.map((col) => cell(col, r)).join("")}</tr>`)
							.join("")}</tbody>${totals}</table>`
					: `<div class="text-muted nyi-empty-small">${__("No rows for these filters.")}</div>`
			);
			$wrap.find("th[data-sort]").on("click", (e) => {
				const key = e.currentTarget.dataset.sort;
				sort.dir = sort.key === key ? -sort.dir : cols.find((col) => col.key === key).num ? -1 : 1;
				sort.key = key;
				draw();
			});
			if (opts.on_row)
				$wrap.find("tbody tr").on("click", (e) => {
					if (e.target.tagName === "A") return;
					opts.on_row(sorted[+e.currentTarget.dataset.i]);
				});
		};
		draw();
	}

	// ---------- drilldowns ----------

	dialog(title, cols, rows, sort, opts = {}) {
		const d = new frappe.ui.Dialog({ title: esc(title), size: "extra-large" }); // Dialog inserts titles as HTML
		d.$wrapper.addClass("nyi-dialog");
		d.$body.html(`
			<div class="nyi-root nyi-drill">
				<div class="nyi-drill-tools"><span class="text-muted">${esc(__("{0} rows", [rows.length]))}${opts.note ? " · " + esc(opts.note) : ""}</span>
					<button class="btn btn-default btn-xs" data-action="dcsv">${__("Export CSV")}</button></div>
				<div class="nyi-drill-scroll"></div>
			</div>`);
		this.render_grid(d.$body.find(".nyi-drill-scroll"), cols, rows, sort, opts);
		d.$body.find("[data-action=dcsv]").on("click", () => this.export_csv(cols, rows, slug(title)));
		d.show();
		return d;
	}

	report_columns() {
		return [
			{ key: "name", label: __("Report"), link: true },
			{ key: "org", label: __("Organisation") },
			{ key: "period", label: __("Reporting Period") },
			{ key: "year", label: __("Year") },
			{ key: "status", label: __("Status"), status: true },
			{ key: "share", label: __("Share in Selection"), num: true, pct: true },
			{ key: "youth", label: __("Youth"), num: true },
			{ key: "groups", label: __("Groups"), num: true },
			{ key: "leaders", label: __("Leaders"), num: true },
			{ key: "trainers", label: __("Trainers"), num: true },
			{ key: "actions", label: __("Social Actions"), num: true },
			{ key: "reach", label: __("Community Reach"), num: true },
		];
	}

	// g = one location (performance-table row); without it, shares are those inside the current filters
	reports_dialog(title, reports, g, sort_key = "youth") {
		const share_of = (r) =>
			g
				? r.geo.filter((x) => x.state === g.state && x.district === g.district && (x.block || "") === (g.block || "") && this.geo_ok(x)).reduce((s, x) => s + x.w, 0)
				: this.computed.reports.get(r) || 0;
		const d = (s) => (s ? frappe.datetime.str_to_user(s) : "?");
		const rows = reports.map((r) => {
			const share = share_of(r);
			return {
				name: r.name,
				_link: frappe.utils.get_form_link(r.doctype, r.name),
				org: r.org || "—",
				period: `${d(r.from)} – ${d(r.to)}`,
				year: r.year || "—",
				status: r.status,
				share: share * 100,
				youth: r.youth * share,
				groups: r.groups * share,
				leaders: r.leaders * share,
				trainers: r.trainers * share,
				actions: r.actions * share,
				reach: r.reach * share,
			};
		});
		this.dialog(title, this.report_columns(), rows, { key: sort_key, dir: -1 }, {
			total: true,
			note: __("Click a report number to open the form. 'Share in Selection' is the part of the report that falls inside this selection."),
		});
	}

	card_drill(id) {
		const C = this.computed;
		if (!C) return;
		const title = this.$root.find(`[data-card=${id}] .nyi-card-title`).first().text();
		const metric_cards = { youth: "youth", groups: "groups", leaders: "leaders", actions: "actions", reach: "reach", trainers: "trainers", avg: "youth", per_action: "reach", year: "youth" };
		if (metric_cards[id]) return this.reports_dialog(__("{0}: reports", [title]), [...C.reports.keys()], null, metric_cards[id]);

		const metric_cols = Object.entries(NYI_METRICS).map(([key, label]) => ({ key, label, num: true }));
		if (id === "orgs") {
			const rows = this.aggregate(C.pairs, (r) => r.org || "—").map((a) => ({ ...a, org: a.key, report_count: a.reports.size, _reports: [...a.reports] }));
			return this.dialog(title, [{ key: "org", label: __("Organisation") }, { key: "report_count", label: __("Reports"), num: true }, ...metric_cols], rows, { key: "youth", dir: -1 }, {
				total: true,
				on_row: (row) => this.reports_dialog(__("Reports from {0}", [row.org]), row._reports, null),
			});
		}

		const level = { states: ["state"], districts: ["state", "district"], blocks: ["state", "district", "block"], villages: ["state", "district", "block"], area: ["area", "state", "district", "block"] }[id];
		if (!level) return;
		const ns = __("Not specified");
		const pairs = id === "blocks" ? C.pairs.filter(({ g }) => g.block) : id === "villages" ? C.pairs.filter(({ g }) => g.sub_area === "Villages") : C.pairs;
		const rows = this.aggregate(pairs, (r, g) => level.map((k) => g[k] || "").join("|")).map((a) => {
			const row = { ...a, _reports: [...a.reports] };
			level.forEach((k) => (row[k] = a.g[k] || ns));
			return row;
		});
		if (id === "villages")
			rows.forEach((row) => (row.villages = pairs.filter(({ g }) => level.every((k) => (g[k] || ns) === row[k])).reduce((s, { g }) => s + (g.covered || 0), 0)));
		const labels = { state: __("State"), district: __("District"), block: __("Block"), area: __("Area Type") };
		const cols = [...level.map((k) => ({ key: k, label: labels[k] })), ...(id === "villages" ? [{ key: "villages", label: __("Villages"), num: true }] : []), ...metric_cols];
		this.dialog(title, cols, rows, id === "villages" ? { key: "villages", dir: -1 } : { key: "youth", dir: -1 }, {
			total: true,
			on_row: (row) => this.reports_dialog(__("Reports for {0}", [level.map((k) => row[k]).reverse().join(", ")]), row._reports, null),
		});
	}

	export_csv(cols, rows, name) {
		const cell = (v) => {
			let s = v == null ? "" : typeof v === "number" ? String(Math.round(v * 100) / 100) : String(v);
			if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // stop spreadsheets running cell text as formulas
			return `"${s.replace(/"/g, '""')}"`;
		};
		const csv = [cols.map((col) => cell(col.label)).join(","), ...rows.map((r) => cols.map((col) => cell(r[col.key])).join(","))].join("\n");
		const a = document.createElement("a");
		a.href = URL.createObjectURL(new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" }));
		a.download = `${name || "nyi"}-${frappe.datetime.now_date()}.csv`;
		a.click();
		setTimeout(() => URL.revokeObjectURL(a.href), 1000);
	}

	// ---------- styles ----------

	inject_css() {
		if (document.getElementById("nyi-dashboard-css")) return;
		const style = document.createElement("style");
		style.id = "nyi-dashboard-css";
		style.textContent = `
#page-nyi-dashboard .page-body.container { max-width: none !important; }
.nyi-root {
	--nyi-surface: var(--card-bg, #fff); --nyi-text: var(--text-color, #1f272e); --nyi-muted: var(--text-muted, #6b7280);
	--nyi-border: var(--border-color, #e2e6ea); --nyi-grid: #e6e9ee; --nyi-head: #1A3550; --nyi-hi: #f2c14e;
	--nyi-s1: #2a78d6; --nyi-s2: #eb6834; --nyi-s3: #1baf7a;
	--nyi-m1: #86b6ef; --nyi-m2: #2a78d6; --nyi-m3: #104281;
	--nyi-ramp: #cde2fb, #9ec5f4, #6da7ec, #3987e5, #256abf, #184f95, #0d366b;
	--nyi-nodata: #eef0f3; --nyi-good: #2F7D4F; --nyi-warn: #B7651B;
	padding: 4px 0 40px; color: var(--nyi-text);
}
[data-theme="dark"] .nyi-root {
	--nyi-grid: #34383d; --nyi-head: #dbe6f3; --nyi-hi: #c9a13b;
	--nyi-s1: #3987e5; --nyi-s2: #d95926; --nyi-s3: #199e70;
	--nyi-m1: #184f95; --nyi-m2: #3987e5; --nyi-m3: #9ec5f4;
	--nyi-ramp: #104281, #1c5cab, #2a78d6, #5598e7, #86b6ef, #b7d3f6;
	--nyi-nodata: #2b2e33; --nyi-good: #4fae73; --nyi-warn: #e09a4f;
}
.nyi-loading { padding: 60px; text-align: center; }
.nyi-filters { display: grid; grid-template-columns: repeat(7, minmax(120px, 1fr)) auto; gap: 10px; align-items: end;
	background: var(--nyi-surface); border: 1px solid var(--nyi-border); border-radius: 8px; padding: 12px 14px; margin-bottom: 18px;
	position: sticky; top: var(--navbar-height, 48px); z-index: 5; }
.nyi-filter { margin: 0; min-width: 0; }
.nyi-filter span { display: block; font-size: 11px; font-weight: 600; color: var(--nyi-muted); text-transform: uppercase; letter-spacing: .03em; margin-bottom: 4px; }
.nyi-filter select.nyi-active { border-color: var(--nyi-s1); box-shadow: 0 0 0 1px var(--nyi-s1) inset; }
.nyi-filter-actions { display: flex; flex-direction: column; align-items: flex-end; gap: 4px; }
.nyi-updated { font-size: 11px; white-space: nowrap; }
.nyi-section-title { font-size: 13px; font-weight: 600; color: var(--nyi-head); text-transform: uppercase; letter-spacing: .04em;
	margin: 6px 0 10px; padding-bottom: 6px; border-bottom: 1px solid var(--nyi-border); }
.nyi-grid { display: grid; grid-template-columns: repeat(7, minmax(0, 1fr)); gap: 12px; margin-bottom: 22px; }
.nyi-card { background: var(--nyi-surface); border: 1px solid var(--nyi-border); border-radius: 8px; padding: 14px 16px; min-height: 112px;
	display: flex; flex-direction: column; cursor: pointer; transition: border-color .15s, box-shadow .15s; }
.nyi-card:hover, .nyi-card:focus { border-color: var(--nyi-s1); box-shadow: 0 2px 8px rgba(16, 40, 70, .08); outline: none; }
.nyi-card-head { display: flex; justify-content: space-between; gap: 6px; }
.nyi-card-title { font-size: 13px; font-weight: 600; color: var(--nyi-text); line-height: 1.3; }
.nyi-info { color: var(--nyi-muted); cursor: help; font-size: 13px; line-height: 1; }
.nyi-card-value { font-size: 28px; font-weight: 600; font-variant-numeric: tabular-nums; color: var(--nyi-head); margin-top: auto; padding-top: 8px; line-height: 1.15; }
.nyi-small-value { font-size: 22px; }
.nyi-area { display: inline-block; margin-right: 14px; font-size: 22px; }
.nyi-area small { display: block; font-size: 11px; font-weight: 500; color: var(--nyi-muted); }
.nyi-card-sub { font-size: 12px; color: var(--nyi-muted); margin-top: 2px; min-height: 16px; }
.nyi-panel { background: var(--nyi-surface); border: 1px solid var(--nyi-border); border-radius: 8px; padding: 14px 16px; margin-bottom: 18px; min-width: 0; }
.nyi-panel-head { display: flex; justify-content: space-between; align-items: flex-start; gap: 12px; margin-bottom: 8px; }
.nyi-panel-title { font-size: 15px; font-weight: 600; color: var(--nyi-head); }
.nyi-inline { display: flex; align-items: center; gap: 8px; font-size: 12px; color: var(--nyi-muted); white-space: nowrap; margin: 0; }
.nyi-inline select { width: auto; }
.nyi-crumbs { font-size: 12px; color: var(--nyi-muted); margin-top: 2px; }
.nyi-crumbs a { color: var(--nyi-s1); cursor: pointer; }
.nyi-map-wrap { display: grid; grid-template-columns: minmax(0, 3fr) minmax(240px, 2fr); gap: 16px; }
.nyi-map { height: 480px; }
.nyi-map-side { display: flex; flex-direction: column; min-height: 0; max-height: 480px; }
.nyi-side-title { font-size: 12px; font-weight: 600; color: var(--nyi-muted); margin-bottom: 6px; }
.nyi-side-list { overflow-y: auto; padding-right: 4px; }
.nyi-side-row { display: grid; grid-template-columns: minmax(0, 1.4fr) minmax(40px, 1fr) auto; gap: 8px; align-items: center;
	padding: 5px 6px; border-radius: 6px; cursor: pointer; font-size: 12.5px; }
.nyi-side-row:hover { background: var(--subtle-fg, rgba(0,0,0,.04)); }
.nyi-side-row.is-active { background: var(--subtle-fg, rgba(0,0,0,.06)); font-weight: 600; }
.nyi-side-row.is-static { cursor: default; color: var(--nyi-muted); }
.nyi-side-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nyi-side-bar { height: 8px; background: var(--nyi-nodata); border-radius: 4px; overflow: hidden; }
.nyi-side-bar i { display: block; height: 100%; background: var(--nyi-s1); border-radius: 4px; }
.nyi-side-val { font-variant-numeric: tabular-nums; text-align: right; min-width: 44px; }
.nyi-note { font-size: 11.5px; color: var(--nyi-muted); margin-top: 6px; }
.nyi-two { display: grid; grid-template-columns: 1fr 1fr; gap: 18px; }
.nyi-chart { height: 340px; min-width: 0; }
.nyi-actions-wrap { display: grid; grid-template-columns: minmax(0, 1fr) 260px; gap: 16px; align-items: start; }
.nyi-actions-wrap .nyi-card { min-height: 130px; }
.nyi-table-tools { display: flex; gap: 8px; }
.nyi-table-tools input { width: 200px; }
.nyi-table-wrap { overflow-x: auto; }
.nyi-table { width: 100%; border-collapse: collapse; font-size: 12.5px; }
.nyi-table th { position: sticky; top: 0; background: var(--nyi-surface); color: var(--nyi-muted); font-weight: 600; font-size: 11.5px;
	text-transform: uppercase; letter-spacing: .03em; padding: 8px 10px; border-bottom: 1px solid var(--nyi-border); cursor: pointer; white-space: nowrap; user-select: none; }
.nyi-table td { padding: 7px 10px; border-bottom: 1px solid var(--nyi-border); white-space: nowrap; max-width: 260px; overflow: hidden; text-overflow: ellipsis; }
.nyi-table tbody tr.is-click { cursor: pointer; }
.nyi-table tbody tr:hover { background: var(--subtle-fg, rgba(0,0,0,.03)); }
.nyi-table tfoot td { font-weight: 600; border-top: 2px solid var(--nyi-border); border-bottom: none; }
.nyi-num { text-align: right; font-variant-numeric: tabular-nums; }
.nyi-status { display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11.5px; border: 1px solid currentColor; }
.nyi-status-submitted { color: var(--nyi-good); }
.nyi-status-draft { color: var(--nyi-warn); }
.nyi-status-partly-submitted { color: var(--nyi-s1); }
.nyi-empty-small { padding: 16px 4px; font-size: 12.5px; }
.nyi-drill { padding: 0; }
.nyi-drill-tools { display: flex; justify-content: space-between; align-items: center; gap: 12px; margin-bottom: 8px; font-size: 12px; }
.nyi-drill-scroll { max-height: 62vh; overflow: auto; overscroll-behavior: contain; }
.nyi-dialog .modal-dialog { width: 96vw; max-width: 96vw; margin: 2vh auto; }
.nyi-dialog .modal-content { height: 96vh; display: flex; flex-direction: column; }
.nyi-dialog .modal-body { flex: 1; min-height: 0; display: flex; flex-direction: column; overflow: hidden; }
.nyi-dialog .nyi-drill { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 0; }
.nyi-dialog .nyi-drill-scroll { flex: 1; min-height: 0; max-height: none; }
.nyi-dialog .nyi-table td { max-width: 420px; }
@media (max-width: 1400px) {
	.nyi-grid { grid-template-columns: repeat(4, minmax(0, 1fr)); }
	.nyi-filters { grid-template-columns: repeat(4, minmax(120px, 1fr)); }
}
@media (max-width: 1000px) {
	.nyi-two, .nyi-map-wrap, .nyi-actions-wrap { grid-template-columns: 1fr; }
	.nyi-map-side { max-height: 320px; }
	.nyi-filters { position: static; }
}
@media (max-width: 640px) {
	.nyi-grid, .nyi-filters { grid-template-columns: repeat(2, minmax(0, 1fr)); }
	.nyi-map { height: 340px; }
}
`;
		document.head.appendChild(style);
	}
}
