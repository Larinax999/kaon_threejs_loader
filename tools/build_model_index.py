"""Build viewer/models.json: an index of every lepton scene under dumps/.

Walks dumps/, joins each lepton.xml with metadata from dumps/catalog/catalog.json,
and emits a stable, sorted list the viewer's model picker can consume.

Run from the repo root:  python tools/build_model_index.py
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
DUMPS = ROOT / "dumps"
CATALOG_JSON = DUMPS / "catalog" / "catalog.json"
OUT = ROOT / "viewer" / "models.json"

PRODUCT_PATH_RE = re.compile(r"^catalog/(\d+/\d+)/lepton$")
MODULE_LEPTON_RE = re.compile(r"^([^/]+)/(?:catalog/.+/)?lepton$")
VRNULL_RE = re.compile(r"^([^/]+)/vrnull$")


def walk_catalog(node, breadcrumb, products, modules, racks):
    """Recursively flatten catalog.json into three lookup tables."""
    name_en = (node.get("name") or {}).get("en", "").strip()
    here = breadcrumb + [name_en] if name_en else breadcrumb
    kind = node.get("type")

    if kind == "product":
        path = node.get("path")
        if path:
            entry = {
                "id": node.get("id"),
                "name": name_en or f"product {node.get('id')}",
                "revision": node.get("revision", ""),
                "project": node.get("project", ""),
                "category": " › ".join(b for b in breadcrumb if b),
                "hide": bool(node.get("hide")),
            }
            # Multiple catalog entries can point at the same path with different
            # display names (e.g. rack-unit aliases). Keep the first non-hidden,
            # but record alternates for completeness.
            existing = products.get(path)
            if existing is None or (existing.get("hide") and not entry["hide"]):
                if existing is not None:
                    entry.setdefault("aliases", []).extend(existing.get("aliases", []))
                    entry["aliases"].append({"name": existing["name"], "category": existing["category"]})
                products[path] = entry
            else:
                existing.setdefault("aliases", []).append({"name": entry["name"], "category": entry["category"]})

    elif kind == "module":
        mod = node.get("module")
        if mod:
            modules.setdefault(mod, {
                "id": node.get("id"),
                "name": name_en or mod,
                "category": " › ".join(b for b in breadcrumb if b),
                "hide": bool(node.get("hide")),
            })

    elif kind == "rack":
        rack_key = node.get("rack")
        if rack_key:
            members = []
            for child in node.get("children", []):
                if child.get("type") == "product" and child.get("path"):
                    members.append({"path": child["path"], "u": child.get("u")})
            racks[rack_key] = {
                "id": node.get("id"),
                "name": name_en or rack_key,
                "category": " › ".join(b for b in breadcrumb if b),
                "members": members,
            }

    for child in node.get("children", []) or []:
        walk_catalog(child, here, products, modules, racks)


def load_catalog():
    if not CATALOG_JSON.exists():
        print(f"warning: {CATALOG_JSON} not found", file=sys.stderr)
        return {}, {}, {}
    data = json.loads(CATALOG_JSON.read_text(encoding="utf-8"))
    products, modules, racks = {}, {}, {}
    walk_catalog(data, [], products, modules, racks)
    return products, modules, racks


def parse_lepton_meta(xml_path):
    """Cheap parse: just title + mesh/material counts. Skip if malformed."""
    try:
        root = ET.parse(xml_path).getroot()
    except ET.ParseError as e:
        return {"title": "", "meshes": 0, "materials": 0, "error": str(e)}
    title = (root.get("title") or "").strip()
    meshes = sum(1 for _ in root.iter("mesh"))
    materials = len(root.findall("./materials/material"))
    return {"title": title, "meshes": meshes, "materials": materials}


def classify(rel_dir, products, modules):
    """Map a lepton.xml's parent-dir-relative-to-dumps to (id, kind, meta)."""
    # Catalog product:  catalog/{N}/{ID}/lepton
    m = PRODUCT_PATH_RE.match(rel_dir)
    if m:
        path = m.group(1)
        info = products.get(path)
        return {
            "id": path,
            "kind": "product",
            "name": (info or {}).get("name") or f"Product {path}",
            "category": (info or {}).get("category") or "Uncategorized",
            "revision": (info or {}).get("revision", ""),
            "project": (info or {}).get("project", ""),
            "hide": (info or {}).get("hide", False),
            "aliases": (info or {}).get("aliases", []),
        }

    # Per-module vrnull root scene:  {Module}/vrnull
    m = VRNULL_RE.match(rel_dir)
    if m and m.group(1) != "vrnull":
        mod = m.group(1)
        info = modules.get(mod)
        base_name = (info or {}).get("name") or mod
        return {
            "id": f"{mod}/vrnull",
            "kind": "module",
            "name": f"{base_name} (vrnull)",
            "category": (info or {}).get("category") or "Modules",
            "module": mod,
        }

    # Module catalog scene:  {Module}/catalog/.../lepton  or  {Module}/catalog/scene/lepton
    m = MODULE_LEPTON_RE.match(rel_dir)
    if m and m.group(1) != "catalog":
        mod = m.group(1)
        info = modules.get(mod)
        base_name = (info or {}).get("name") or mod
        # tail after the module name, minus the trailing /lepton
        tail = rel_dir[len(mod) + 1:].rsplit("/lepton", 1)[0]
        suffix = tail.replace("catalog/", "")
        display = base_name if suffix in ("scene", "") else f"{base_name} ({suffix})"
        return {
            "id": f"{mod}/{tail}",
            "kind": "module",
            "name": display,
            "category": (info or {}).get("category") or "Modules",
            "module": mod,
        }

    # Catalog/unicorn scene
    if rel_dir == "catalog/unicorn/lepton":
        return {"id": "catalog/unicorn", "kind": "unclassified",
                "name": "Catalog Unicorn", "category": "Other"}

    # Top-level vrnull
    if rel_dir == "vrnull":
        return {"id": "vrnull", "kind": "unclassified",
                "name": "Root vrnull", "category": "Other"}

    # Anything else
    return {"id": rel_dir, "kind": "unclassified",
            "name": rel_dir, "category": "Other"}


def build_index():
    products, modules, racks = load_catalog()

    # path -> [(rack_name, u), ...]
    racks_by_path = {}
    for rack_key, rack in racks.items():
        for mem in rack["members"]:
            racks_by_path.setdefault(mem["path"], []).append({
                "rack": rack_key,
                "rack_name": rack["name"],
                "u": mem.get("u"),
            })

    entries = []
    for xml_path in sorted(DUMPS.rglob("lepton.xml")):
        rel = xml_path.relative_to(DUMPS).as_posix()
        rel_dir = rel.rsplit("/", 1)[0]  # strip /lepton.xml
        meta = parse_lepton_meta(xml_path)
        cls = classify(rel_dir, products, modules)
        entry = {
            "id": cls["id"],
            "dir": rel_dir,
            "name": cls["name"],
            "title": meta["title"],
            "category": cls["category"],
            "kind": cls["kind"],
            "meshes": meta["meshes"],
            "materials": meta["materials"],
        }
        if cls.get("revision"):
            entry["revision"] = cls["revision"]
        if cls.get("project"):
            entry["project"] = cls["project"]
        if cls.get("module"):
            entry["module"] = cls["module"]
        if cls.get("hide"):
            entry["hide"] = True
        if cls.get("aliases"):
            entry["aliases"] = cls["aliases"]
        if "error" in meta:
            entry["error"] = meta["error"]
        # Attach rack memberships for catalog products
        if cls["kind"] == "product" and cls["id"] in racks_by_path:
            entry["racks"] = racks_by_path[cls["id"]]
        entries.append(entry)

    kind_order = {"product": 0, "module": 1, "unclassified": 2}
    entries.sort(key=lambda e: (kind_order.get(e["kind"], 9), e["category"], e["name"], e["id"]))

    OUT.parent.mkdir(parents=True, exist_ok=True)
    payload = {
        "generated": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "count": len(entries),
        "models": entries,
    }
    OUT.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")

    # Console summary
    by_kind = {}
    for e in entries:
        by_kind[e["kind"]] = by_kind.get(e["kind"], 0) + 1
    print(f"Wrote {OUT.relative_to(ROOT)}  total={len(entries)}  " +
          "  ".join(f"{k}={v}" for k, v in sorted(by_kind.items())))


if __name__ == "__main__":
    build_index()
