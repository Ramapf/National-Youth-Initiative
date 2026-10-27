"""Build simplified GeoJSON for the NYI dashboard map from DataMeet shapefiles (CC BY 4.0).

Source : https://github.com/datameet/maps at commit b3fbbde595310b397a55d718e0958ce249a4fa1f
         States/Admin2.* (current states/UTs) and Districts/Census_2011/2011_Dist.*
Usage  : pip install pyshp shapely; python tools/build_geo.py <dir with the .shp/.shx/.dbf files> national_youth_initiative/public/data/geo
Output : india_states.json and districts/<state-slug>.json; districts are re-assigned to the current state that contains them.
"""
import json, os, re, sys

import shapefile
from shapely.geometry import mapping, shape
from shapely.ops import unary_union

SRC, OUT = sys.argv[1], sys.argv[2]
os.makedirs(os.path.join(OUT, "districts"), exist_ok=True)

# names used in the NYI State / District masters (and older spellings) -> DataMeet name
STATE_ALIASES = {
	"Telangana": ["Telengana"],
	"Delhi": ["New Delhi", "NCT of Delhi"],
	"Jammu & Kashmir": ["Jammu and Kashmir", "Kashmir"],
	"Andaman & Nicobar": ["Andaman and Nicobar Islands", "Andaman & Nicobar Islands"],
	"Dadra and Nagar Haveli and Daman and Diu": ["Daman and Diu", "Dadra and Nagar Haveli", "DNH and DD"],
	"Odisha": ["Orissa"],
	"Puducherry": ["Pondicherry"],
	"Uttarakhand": ["Uttaranchal"],
}
DISTRICT_ALIASES = {
	"Bangalore": ["Bengaluru Urban", "Bengaluru"],
	"Bangalore Rural": ["Bengaluru Rural"],
	"Faizabad": ["Ayodhya"],
	"Allahabad": ["Prayagraj"],
	"Gurgaon": ["Gurugram"],
	"Mewat": ["Nuh"],
	"Gulbarga": ["Kalaburagi"],
	"Bijapur": ["Vijayapura"],
	"Bellary": ["Ballari"],
	"Bagalkot": ["Bagalkote"],
	"Chamrajnagar": ["Chamarajanagar"],
	"Osmanabad": ["Dharashiv"],
	"Aurangabad": ["Chhatrapati Sambhajinagar"],
	"Purbi Singhbhum": ["East Singhbhum", "East Singhbum"],
	"Pashchimi Singhbhum": ["West Singhbhum"],
	"Hugli": ["Hooghly"],
	"Darjiling": ["Darjeeling"],
	"Maldah": ["Malda"],
	"Bandipore": ["Bandipora"],
	"Baramula": ["Baramulla"],
	"Ahmadabad": ["Ahmedabad"],
	"Aligarh": ["Aligrah"],
	"Sant Ravi Das Nagar(bhadohi)": ["Bhadohi", "Sant Ravidas Nagar"],
	"Bauda": ["Boudh", "Baudh"],
	"Dohad": ["Dahod"],
	"Debagarh": ["Deogarh"],
	"Jagatsinghapur": ["Jagatsinghpur"],
	"Jalna": ["Jalana"],
	"Leh (ladakh)": ["Leh"],
	"Nagappattinam": ["Nagapattinam"],
	"Panch Mahals": ["Panchmahal", "Panchmahals"],
	"Punch": ["Poonch"],
	"Barddhaman": ["Purba Bardhaman", "Paschim Bardhaman", "Bardhaman"],
	"Sonbhadra": ["Sonebhadra"],
	"Subarnapur": ["Sonepur"],
	"South 24 Parganas": ["South Twenty Four Parganas", "South 24 Paraganas"],
	"North 24 Parganas": ["North Twenty Four Parganas"],
	"Ramgarh": ["Jharkhand: Ramgarh"],
}


def slug(s):
	return re.sub(r"[^a-z0-9]+", "-", s.lower().replace("&", "and")).strip("-")


def simple(geom, tol, min_area):
	g = geom.buffer(0).simplify(tol, preserve_topology=True)
	parts = list(getattr(g, "geoms", [g]))
	keep = [p for p in parts if p.area >= min_area] or [max(parts, key=lambda p: p.area)]
	return unary_union(keep)


def rounded(geom):
	def r(c):
		if isinstance(c[0], (int, float)):
			return [round(c[0], 3), round(c[1], 3)]
		return [r(x) for x in c]

	m = mapping(geom)
	return {"type": m["type"], "coordinates": r(m["coordinates"])}


states = []
for sr in shapefile.Reader(os.path.join(SRC, "Admin2")).shapeRecords():
	name = sr.record[0]
	states.append((name, shape(sr.shape.__geo_interface__)))

features = []
for name, geom in states:
	g = simple(geom, 0.02, 0.002)
	features.append({"type": "Feature", "properties": {"name": name, "slug": slug(name), "names": STATE_ALIASES.get(name, [])}, "geometry": rounded(g)})
json.dump({"type": "FeatureCollection", "features": features}, open(os.path.join(OUT, "india_states.json"), "w"), separators=(",", ":"))

by_state = {}
for sr in shapefile.Reader(os.path.join(SRC, "2011_Dist")).shapeRecords():
	dname = sr.record[0]
	geom = shape(sr.shape.__geo_interface__).buffer(0)
	pt = geom.representative_point()
	home = next((n for n, sg in states if sg.contains(pt)), None)
	if not home:  # coastal slivers: nearest state
		home = min(states, key=lambda s: s[1].distance(pt))[0]
	by_state.setdefault(home, []).append({"type": "Feature", "properties": {"name": dname, "names": DISTRICT_ALIASES.get(dname, [])}, "geometry": rounded(simple(geom, 0.006, 0.0002))})

total = 0
for st, feats in by_state.items():
	path = os.path.join(OUT, "districts", slug(st) + ".json")
	json.dump({"type": "FeatureCollection", "features": feats}, open(path, "w"), separators=(",", ":"))
	total += os.path.getsize(path)
print("states:", len(features), os.path.getsize(os.path.join(OUT, "india_states.json")) // 1024, "KB")
print("district files:", len(by_state), total // 1024, "KB total")
print({k: len(v) for k, v in sorted(by_state.items())})
