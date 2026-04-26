"""Convert a Kaon "lepton" asset (lepton.xml + geometry_raw.bin + textures) into a single GLB.

Format spec (reversed from dumps/lepton_webgl_obf.js):

All integer/float reads in the header are BIG-ENDIAN.
The file is a sequence of per-mesh headers (in the XML <mesh> declaration order),
followed by a 4-byte-aligned vertex stream.

Per-mesh header:
    uint16 magic = 0xADBF  (44543)
    uint32 flags           (bits: 4=NON_REDUNDANT, 8=DUP_ELIM, 16=PRECISE_FP, 32=BBZ_NEG, 64=FP16, 128=NORM16)
    uint32 faces
    uint32 vertices        (unused in the non-redundant raw path)
    uint16 BITS_XYZ / BITS_UV / BITS_NORM  (relevant only to the quantized path)
    float32 minX, maxX
    float32 minY, maxY
    float32 zA, zB         (engine stores: maxZ = -zA, minZ = -zB)
    float32 minU, maxU
    float32 minV, maxV
    uint16 matLen
    matLen * { uint16 mat_idx ; uint32 tri_count }   # mat_idx is the XML <materials> order
    uint32 reserved[4]
    matLen * 8 * 3 float32  # per-material OBB 8 corners * XYZ

After all headers: align buffer offset to 4 (+=2 if odd), then:

Vertex stream (decoded into 8-float records = position xyz, uv, normal xyz):
    Read Int32 (LITTLE-ENDIAN -- native typed-array view).
    If 0 < r < 65536*64: back-reference; copy 8 floats from `k - r*8`. Advance j by 1 int32 (4 bytes).
    Else:                  read 8 Float32 (LE) at offset j; copy to vert[k..k+8]. Advance j by 8.
"""
import argparse, base64, json, math, os, struct, sys
import xml.etree.ElementTree as ET
from pathlib import Path
import numpy as np

MAGIC = 0xADFF  # 44543 big-endian; bytes [0xAD, 0xFF]
FLAG_NON_REDUNDANT = 4
FLAG_DUP_ELIM = 8
FLAG_PRECISE_FP = 16
FLAG_BBZ_NEG = 32
FLAG_FP16 = 64
FLAG_NORM16 = 128
REF_LIMIT = 65536 * 64  # 4194304

# ----------------------------- XML parsing -----------------------------

def _f(s, d=0.0):
    return float(s) if s is not None else d

def _alpha(s):
    # "_N" means inherited alpha
    if s is None or s == "_N":
        return None
    try:
        return float(s)
    except ValueError:
        return None

def parse_lepton_xml(path):
    root = ET.parse(path).getroot()
    title = root.get("title", "")
    lights = []
    for l in root.findall("./lights/light"):
        lights.append({
            "intensity": _f(l.get("intensity"), 1.0),
            "ambient": l.get("ambient") == "true",
            "x": _f(l.get("x")), "y": _f(l.get("y")), "z": _f(l.get("z")),
        })
    materials = []
    mat_by_id = {}
    for m in root.findall("./materials/material"):
        mat = {
            "id": m.get("id"),
            "color": int(m.get("color", "0xffffff"), 16),
            "image": m.get("image") or "",
            "backface": m.get("backface") == "true",
            "light": m.get("light", "phong"),
            "alpha": _f(m.get("alpha"), 1.0),
            "ambient": _f(m.get("ambient"), 1.0),
            "diffuse": _f(m.get("diffuse"), 1.0),
            "specular": _f(m.get("specular"), 0.0),
            "glossiness": _f(m.get("glossiness"), 0.5),
            "chrome": _f(m.get("chrome"), 0.0),
        }
        materials.append(mat)
        mat_by_id[mat["id"]] = mat

    objs_el = root.find("./objects")
    mm = _f(objs_el.get("mm"), 1.0)

    objects = []  # flat list preserving XML order; parent indices
    mesh_order = []  # indices into objects that carry a <mesh>

    def walk(el, parent_idx):
        idx = len(objects)
        mesh_el = el.find("mesh")
        obj = {
            "id": el.get("id", f"node_{idx}"),
            "parent": parent_idx,
            "x": _f(el.get("x")), "y": _f(el.get("y")), "z": _f(el.get("z")),
            "theta": _f(el.get("theta")),  # yaw around Y
            "phi": _f(el.get("phi")),      # pitch around X
            "psi": _f(el.get("psi")),      # roll around Z
            "alpha": _alpha(el.get("alpha")),
            "mesh": None,
        }
        if mesh_el is not None:
            obj["mesh"] = {
                "bin": mesh_el.get("bin"),
                "faces": int(mesh_el.get("faces")),
                "vertices": int(mesh_el.get("vertices")),
            }
        objects.append(obj)
        if obj["mesh"] is not None:
            mesh_order.append(idx)
        for child in el.findall("object"):
            walk(child, idx)
        return idx

    for top in objs_el.findall("object"):
        walk(top, -1)

    views = []
    for v in root.findall("./views/view"):
        views.append({k: v.get(k) for k in v.attrib})

    sequences = {}
    for s in root.findall("./sequences/sequence"):
        sid = s.get("id")
        waypoints = []
        for wp in s.findall("waypoint"):
            waypoints.append({k: wp.get(k) for k in wp.attrib})
        sequences[sid] = {
            "object": s.get("object"),
            "length": int(s.get("length", "0")),
            "waypoints": waypoints,
        }

    scripts = {}
    for s in root.findall("./scripts/script"):
        sid = s.get("id")
        events = []
        for ev in list(s):
            events.append({"tag": ev.tag, **{k: ev.get(k) for k in ev.attrib}})
        scripts[sid] = {"length": int(s.get("length", "0")), "events": events}
    init_script = root.find("./scripts").get("init") if root.find("./scripts") is not None else None

    return {
        "title": title, "mm": mm, "lights": lights,
        "materials": materials, "mat_by_id": mat_by_id,
        "objects": objects, "mesh_order": mesh_order,
        "views": views, "sequences": sequences, "scripts": scripts,
        "init_script": init_script,
    }


def parse_app_xml(path):
    if not os.path.exists(path):
        return {"hotspots": [], "controls": [], "ui_fields": {}}
    root = ET.parse(path).getroot()
    ui_fields = {}
    for f in root.findall("./ui-fields/field"):
        ui_fields[f.get("name")] = f.get("value")
    controls = []
    for c in root.findall("./controls/control"):
        g = c.find("graphic")
        txt = g.find("text") if g is not None else None
        img = g.find("image") if g is not None else None
        fields = {f.get("name"): f.get("value") for f in c.findall("field")}
        gfields = {f.get("name"): f.get("value") for f in (g.findall("field") if g is not None else [])}
        controls.append({
            "id": c.get("id"),
            "cls": c.get("class"),
            "script": c.get("script"),
            "text_plain": txt.get("text") if txt is not None else "",
            "text_html": (txt.text or "") if txt is not None else "",
            "image": img.get("resource-path") if img is not None else "",
            "fields": fields,
            "gfields": gfields,
        })
    hotspots = []
    for h in root.findall("./hotspots/hotspot"):
        g = h.find("graphic")
        txt = g.find("text") if g is not None else None
        img = g.find("image") if g is not None else None
        hotspots.append({
            "id": h.get("id"),
            "cls": h.get("class"),
            "x": _f(h.get("x")), "y": _f(h.get("y")), "z": _f(h.get("z")),
            "radius": _f(h.get("radius"), 0.5),
            "always_on": h.get("always-on") == "true",
            "object": h.get("object"),
            "text_plain": txt.get("text") if txt is not None else "",
            "text_html": (txt.text or "") if txt is not None else "",
            "image": img.get("resource-path") if img is not None else "",
        })
    return {"hotspots": hotspots, "controls": controls, "ui_fields": ui_fields}


# --------------------------- Binary decoding ---------------------------

class BE:
    """Big-endian reader over a bytes buffer."""
    __slots__ = ("d", "o")
    def __init__(self, d, o=0):
        self.d = d; self.o = o
    def u16(self):
        v = struct.unpack_from(">H", self.d, self.o)[0]; self.o += 2; return v
    def u32(self):
        v = struct.unpack_from(">I", self.d, self.o)[0]; self.o += 4; return v
    def f32(self):
        v = struct.unpack_from(">f", self.d, self.o)[0]; self.o += 4; return v


def decode_headers(data, mesh_count):
    br = BE(data)
    headers = []
    for _ in range(mesh_count):
        h_start = br.o
        magic = br.u16()
        if magic != MAGIC:
            raise ValueError(f"bad magic {magic:#x} at offset {h_start}, expected {MAGIC:#x}")
        flags = br.u32()
        faces = br.u32()
        vertices = br.u32()
        bits_xyz = br.u16(); bits_uv = br.u16(); bits_norm = br.u16()
        minX = br.f32(); maxX = br.f32()
        minY = br.f32(); maxY = br.f32()
        zA = br.f32(); zB = br.f32()
        # engine: maxZ = -zA, minZ = -zB
        maxZ = -zA; minZ = -zB
        minU = br.f32(); maxU = br.f32()
        minV = br.f32(); maxV = br.f32()
        matLen = br.u16()
        mats = []
        for _ in range(matLen):
            mi = br.u16(); cnt = br.u32()
            mats.append((mi, cnt))
        br.u32(); br.u32(); br.u32(); br.u32()  # reserved
        # Per-material oriented bbox: 8 corners x 3 floats
        obboxes = []
        for _ in range(matLen):
            corners = []
            for _ in range(8):
                bbx = br.f32(); bby = br.f32(); bbz = br.f32()
                # for PRECISE_FP+BBZ_NEG (both set in our flags), bbz stays as-is
                corners.append((bbx, bby, bbz))
            obboxes.append(corners)
        headers.append({
            "flags": flags, "faces": faces, "vertices": vertices,
            "bits_xyz": bits_xyz, "bits_uv": bits_uv, "bits_norm": bits_norm,
            "bbox": ((minX, minY, minZ), (maxX, maxY, maxZ)),
            "uv_bbox": ((minU, minV), (maxU, maxV)),
            "mat_groups": mats,
            "obboxes": obboxes,
            "header_size": br.o - h_start,
        })
    # Align stream offset to 4
    stream_off = br.o
    if stream_off % 4 != 0:
        stream_off += 2
    return headers, stream_off


def decode_raw_stream(data, stream_off, total_vbo_verts):
    """Decode the raw/non-redundant vertex stream into an (N, 8) float32 array.

    Each record emits 8 floats: x, y, z, u, v, nx, ny, nz (as stored in the VBO).
    """
    payload = data[stream_off:]
    temp_f = np.frombuffer(payload, dtype="<f4")
    temp_i = np.frombuffer(payload, dtype="<i4")
    vbo = np.zeros(total_vbo_verts * 8, dtype=np.float32)
    j = 0
    for k in range(0, len(vbo), 8):
        r = int(temp_i[j])
        if 0 < r < REF_LIMIT:
            src = k - r * 8
            vbo[k:k+8] = vbo[src:src+8]
            j += 1
        else:
            vbo[k:k+8] = temp_f[j:j+8]
            j += 8
    bytes_used = j * 4
    return vbo.reshape(-1, 8), bytes_used


# -------------------------- glTF/GLB writer ---------------------------

class GLB:
    """Minimal glTF 2.0 + single-bin GLB writer."""
    def __init__(self):
        self.asset = {"version": "2.0", "generator": "lepton_to_gltf"}
        self.scenes = [{"nodes": []}]
        self.nodes = []
        self.meshes = []
        self.materials = []
        self.textures = []
        self.images = []
        self.samplers = [{"magFilter": 9729, "minFilter": 9987, "wrapS": 10497, "wrapT": 10497}]
        self.accessors = []
        self.bufferViews = []
        self.cameras = []
        self.extensionsUsed = set()
        self.bin = bytearray()

    def _align(self, n):
        pad = (-len(self.bin)) % n
        if pad:
            self.bin.extend(b"\x00" * pad)

    def add_buffer_view(self, data_bytes, target=None):
        self._align(4)
        offset = len(self.bin)
        self.bin.extend(data_bytes)
        bv = {"buffer": 0, "byteOffset": offset, "byteLength": len(data_bytes)}
        if target is not None:
            bv["target"] = target
        idx = len(self.bufferViews)
        self.bufferViews.append(bv)
        return idx

    def add_accessor_f32(self, arr, component_type=5126, atype="VEC3", target=34962, mn=None, mx=None):
        # arr: numpy float32 contiguous
        bv = self.add_buffer_view(arr.tobytes(), target=target)
        acc = {
            "bufferView": bv, "componentType": component_type,
            "count": arr.shape[0] if arr.ndim > 1 else int(arr.size // {"SCALAR":1,"VEC2":2,"VEC3":3,"VEC4":4}[atype]),
            "type": atype,
        }
        if mn is not None: acc["min"] = [float(x) for x in mn]
        if mx is not None: acc["max"] = [float(x) for x in mx]
        self.accessors.append(acc)
        return len(self.accessors) - 1

    def add_image_from_file(self, path, mime):
        data = Path(path).read_bytes()
        bv = self.add_buffer_view(data)
        img = {"mimeType": mime, "bufferView": bv}
        self.images.append(img)
        return len(self.images) - 1

    def add_texture(self, image_idx):
        t = {"source": image_idx, "sampler": 0}
        self.textures.append(t)
        return len(self.textures) - 1

    def to_glb(self, out_path):
        self._align(4)
        total_bin_len = len(self.bin)
        gltf = {
            "asset": self.asset,
            "scene": 0,
            "scenes": self.scenes,
            "nodes": self.nodes,
            "meshes": self.meshes,
            "materials": self.materials,
            "accessors": self.accessors,
            "bufferViews": self.bufferViews,
            "buffers": [{"byteLength": total_bin_len}],
            "samplers": self.samplers,
        }
        if self.textures: gltf["textures"] = self.textures
        if self.images: gltf["images"] = self.images
        if self.cameras: gltf["cameras"] = self.cameras
        if self.extensionsUsed: gltf["extensionsUsed"] = sorted(self.extensionsUsed)
        json_bytes = json.dumps(gltf, separators=(",", ":")).encode("utf-8")
        # pad JSON to 4 with spaces
        pad = (-len(json_bytes)) % 4
        json_bytes += b" " * pad
        # pad BIN to 4 with zeros
        bin_bytes = bytes(self.bin)
        bin_pad = (-len(bin_bytes)) % 4
        bin_bytes += b"\x00" * bin_pad
        total_len = 12 + 8 + len(json_bytes) + 8 + len(bin_bytes)
        with open(out_path, "wb") as f:
            f.write(struct.pack("<III", 0x46546C67, 2, total_len))  # "glTF", version 2
            f.write(struct.pack("<II", len(json_bytes), 0x4E4F534A))  # JSON
            f.write(json_bytes)
            f.write(struct.pack("<II", len(bin_bytes), 0x004E4942))   # BIN
            f.write(bin_bytes)


# -------------------------- Transform helpers -------------------------

def euler_to_quat_yxz(theta_deg, phi_deg, psi_deg):
    """Lepton rotation order: rotateY(theta) then rotateX(phi) then rotateZ(psi).
    Applied as a chain on vectors means: v' = Rz * Rx * Ry * v.
    Return quaternion [x, y, z, w] equivalent to Rz * Rx * Ry.
    """
    def q_axis(angle_rad, ax):
        h = angle_rad * 0.5
        s = math.sin(h); c = math.cos(h)
        x, y, z = ax
        return np.array([x*s, y*s, z*s, c], dtype=np.float64)
    def q_mul(a, b):
        ax, ay, az, aw = a
        bx, by, bz, bw = b
        return np.array([
            aw*bx + ax*bw + ay*bz - az*by,
            aw*by - ax*bz + ay*bw + az*bx,
            aw*bz + ax*by - ay*bx + az*bw,
            aw*bw - ax*bx - ay*by - az*bz,
        ], dtype=np.float64)
    qy = q_axis(math.radians(theta_deg), (0, 1, 0))
    qx = q_axis(math.radians(phi_deg), (1, 0, 0))
    qz = q_axis(math.radians(psi_deg), (0, 0, 1))
    # R = Rz * Rx * Ry  =>  q = qz * qx * qy
    return q_mul(q_mul(qz, qx), qy)


# --------------------------- Converter core ---------------------------

def find_texture_file(bin_dir, image_name):
    """image_name may be 'FOO.JPG'; actual file is 'FOO.jpeg' (lowercase). Try a few variants."""
    if not image_name:
        return None, None
    stem = Path(image_name).stem
    candidates = [
        image_name,
        f"{stem}.jpeg", f"{stem}.jpg", f"{stem}.JPG", f"{stem}.JPEG",
        f"{stem}.png", f"{stem}.PNG",
    ]
    for c in candidates:
        p = Path(bin_dir) / c
        if p.exists():
            suf = p.suffix.lower()
            mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png"}.get(suf.lstrip("."), "image/jpeg")
            return str(p), mime
    return None, None


def phong_to_pbr_material(mat, tex_idx):
    # Lepton materials are Phong, not metal-rough. Mapping `chrome` to
    # metallicFactor breaks without an IBL env map (metals render black).
    # Use dielectric (metallic=0) and let the viewer's directional lights
    # drive diffuse + specular from roughness.
    r = ((mat["color"] >> 16) & 0xFF) / 255.0
    g = ((mat["color"] >> 8) & 0xFF) / 255.0
    b = (mat["color"] & 0xFF) / 255.0
    pbr = {"baseColorFactor": [r, g, b, mat["alpha"]]}
    if tex_idx is not None:
        pbr["baseColorTexture"] = {"index": tex_idx}
    pbr["metallicFactor"] = 0.0
    pbr["roughnessFactor"] = float(max(0.15, min(1.0, 1.0 - mat["glossiness"])))
    material = {"name": mat["id"], "pbrMetallicRoughness": pbr, "doubleSided": bool(mat["backface"])}
    if mat["alpha"] < 1.0:
        material["alphaMode"] = "BLEND"
    return material


def build_glb(scene, bin_path, bin_dir, out_path, verbose=False):
    data = Path(bin_path).read_bytes()
    mesh_count = len(scene["mesh_order"])
    headers, stream_off = decode_headers(data, mesh_count)

    # Sanity: faces in header == faces in XML
    for i, mi in enumerate(scene["mesh_order"]):
        obj = scene["objects"][mi]
        if headers[i]["faces"] != obj["mesh"]["faces"]:
            raise ValueError(f"face mismatch at mesh {i}: header={headers[i]['faces']} xml={obj['mesh']['faces']}")

    total_vbo = sum(h["faces"] * 3 for h in headers)
    vbo, consumed = decode_raw_stream(data, stream_off, total_vbo)
    if stream_off + consumed != len(data):
        print(f"warning: stream used {consumed} bytes, remaining = {len(data) - stream_off - consumed}", file=sys.stderr)
    if verbose:
        print(f"Headers end @ {headers[-1]['header_size']}, stream @ {stream_off}, total VBO = {total_vbo} vertices")

    glb = GLB()

    # Materials: one per XML material that is actually referenced. But the XML
    # material order = mat_idx in bin's mat_groups. We emit *all* materials in order.
    image_cache = {}  # image_name -> (image_idx, tex_idx)
    tex_by_image = {}
    gltf_mat_idx = {}
    for i, mat in enumerate(scene["materials"]):
        img_name = mat["image"]
        tex_idx = None
        if img_name:
            if img_name in image_cache:
                tex_idx = image_cache[img_name]
            else:
                p, mime = find_texture_file(bin_dir, img_name)
                if p is not None:
                    img_i = glb.add_image_from_file(p, mime)
                    tex_idx = glb.add_texture(img_i)
                else:
                    if verbose:
                        print(f"warning: texture not found for material {mat['id']}: {img_name}", file=sys.stderr)
                image_cache[img_name] = tex_idx
        gltf_mat_idx[i] = len(glb.materials)
        glb.materials.append(phong_to_pbr_material(mat, tex_idx))

    # Build glTF meshes. One glTF mesh per XML object that has a <mesh>.
    # The per-material "groups" become primitives (a sub-range of the mesh's VBO).
    obj_to_gltf_mesh = {}
    vbo_cursor = 0
    for i, mi in enumerate(scene["mesh_order"]):
        h = headers[i]
        tri_start = 0  # relative triangle index within this mesh
        primitives = []
        for (mat_idx, tri_count) in h["mat_groups"]:
            vstart = vbo_cursor + tri_start * 3
            vend = vstart + tri_count * 3
            sub = vbo[vstart:vend]
            # Kaon authors triangles CW (engine sets gl.frontFace(CW)). glTF /
            # three.js / WebGL default cull assumes CCW front, so reverse winding
            # per triangle: emit verts in [0,2,1] order. Stored normals already
            # point outward, so they remain valid.
            sub = sub.reshape(-1, 3, 8)[:, [0, 2, 1], :].reshape(-1, 8)
            positions = np.ascontiguousarray(sub[:, 0:3])
            uvs = np.ascontiguousarray(sub[:, 3:5])
            normals = np.ascontiguousarray(sub[:, 5:8])

            # Add accessors
            pmin = positions.min(axis=0); pmax = positions.max(axis=0)
            pos_acc = glb.add_accessor_f32(positions, atype="VEC3", mn=pmin, mx=pmax)
            uv_acc = glb.add_accessor_f32(uvs, atype="VEC2")
            nrm_acc = glb.add_accessor_f32(normals, atype="VEC3")
            primitives.append({
                "attributes": {"POSITION": pos_acc, "NORMAL": nrm_acc, "TEXCOORD_0": uv_acc},
                "material": gltf_mat_idx[mat_idx],
                "mode": 4,  # TRIANGLES
            })
            tri_start += tri_count
        if tri_start != h["faces"]:
            raise ValueError(f"mesh {i}: sum(matCount)={tri_start} != faces={h['faces']}")
        gltf_mesh_idx = len(glb.meshes)
        glb.meshes.append({
            "name": scene["objects"][mi]["id"],
            "primitives": primitives,
        })
        obj_to_gltf_mesh[mi] = gltf_mesh_idx
        vbo_cursor += h["faces"] * 3

    # Build node tree mirroring <object> hierarchy. Root gets the mm scale.
    obj_to_node = {}
    gltf_nodes = []
    for i, obj in enumerate(scene["objects"]):
        node = {"name": obj["id"]}
        t = [obj["x"], obj["y"], obj["z"]]
        r = euler_to_quat_yxz(obj["theta"], obj["phi"], obj["psi"])
        if any(v != 0.0 for v in t):
            node["translation"] = [float(v) for v in t]
        if any(abs(v) > 1e-9 for v in r[:3]) or abs(r[3] - 1.0) > 1e-9:
            # Normalize
            n = float(np.linalg.norm(r))
            if n > 0: r = r / n
            node["rotation"] = [float(v) for v in r]
        if i in obj_to_gltf_mesh:
            node["mesh"] = obj_to_gltf_mesh[i]
        gltf_nodes.append(node)
        obj_to_node[i] = len(gltf_nodes) - 1

    # Wire children
    children_of = {i: [] for i in range(len(scene["objects"]))}
    roots = []
    for i, obj in enumerate(scene["objects"]):
        if obj["parent"] == -1:
            roots.append(i)
        else:
            children_of[obj["parent"]].append(i)
    for i, kids in children_of.items():
        if kids:
            gltf_nodes[obj_to_node[i]]["children"] = [obj_to_node[k] for k in kids]

    # Leave the model at engine coordinates. The lepton `mm` field is kept
    # in scene extras for viewers that want to scale the world; views and
    # hotspots in lepton.xml/app.xml use the same engine units.
    glb.nodes = gltf_nodes
    glb.scenes = [{"nodes": [obj_to_node[r] for r in roots]}]

    # Cameras: emit perspective cameras, one per <view>. Store orbit params in extras
    # so the viewer can reconstruct the Kaon camera convention.
    for v in scene["views"]:
        fov_deg = _f(v.get("fov"), 45.0)
        aspect = _f(v.get("aspect"), 1.0)
        cam = {
            "type": "perspective",
            "perspective": {
                "yfov": math.radians(fov_deg),
                "znear": 0.1,
                "zfar": 1e6,
            },
            "name": v.get("id", "view"),
            "extras": {k: v.get(k) for k in v.keys()},
        }
        if aspect > 0:
            cam["perspective"]["aspectRatio"] = aspect
        glb.cameras.append(cam)

    # Stash scene metadata for the viewer
    glb.scenes[0]["extras"] = {
        "mm": scene["mm"],
        "title": scene["title"],
        "lights": scene["lights"],
        "views": scene["views"],
        "sequences": scene["sequences"],
        "scripts": scene["scripts"],
        "init_script": scene["init_script"],
    }

    glb.to_glb(out_path)
    return {
        "meshes": len(glb.meshes),
        "nodes": len(glb.nodes),
        "materials": len(glb.materials),
        "textures": len(glb.textures),
        "cameras": len(glb.cameras),
        "total_vbo": total_vbo,
        "bin_bytes": len(glb.bin),
    }


# --------------------------- Analyze/CLI ------------------------------

def analyze(bin_path, scene):
    data = Path(bin_path).read_bytes()
    mesh_count = len(scene["mesh_order"])
    headers, stream_off = decode_headers(data, mesh_count)
    total_vbo = sum(h["faces"] * 3 for h in headers)
    vbo, consumed = decode_raw_stream(data, stream_off, total_vbo)
    print(f"File: {bin_path}  size={len(data)}")
    print(f"Meshes declared: {mesh_count}")
    print(f"Headers end @ {stream_off} (aligned)")
    print(f"Stream payload: {len(data) - stream_off} bytes, decoder consumed {consumed} bytes")
    if consumed != len(data) - stream_off:
        print(f"  MISMATCH: {len(data) - stream_off - consumed} trailing bytes")
    print(f"Total VBO verts: {total_vbo}")
    print()
    for i, mi in enumerate(scene["mesh_order"]):
        obj = scene["objects"][mi]
        h = headers[i]
        print(f"Mesh {i:2d} [{obj['id']}] faces={h['faces']}  matLen={len(h['mat_groups'])}  "
              f"flags=0x{h['flags']:02x} bbox={h['bbox']}  UV={h['uv_bbox']}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--lepton", default="dumps/catalog/2/264/lepton/lepton.xml")
    ap.add_argument("--app", default="dumps/catalog/2/264/lepton/app.xml")
    ap.add_argument("--bin-dir", default="dumps/catalog/2/264/lepton")
    ap.add_argument("--bin", default=None, help="override the geometry bin (default: <bin-dir>/geometry_raw.bin)")
    ap.add_argument("--out", default="out/scene.glb")
    ap.add_argument("--hotspots-out", default=None, help="emit hotspots JSON for the viewer (default: alongside out)")
    ap.add_argument("--analyze", action="store_true")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    scene = parse_lepton_xml(args.lepton)
    app = parse_app_xml(args.app)
    bin_path = args.bin or os.path.join(args.bin_dir, "geometry_raw.bin")

    if args.analyze:
        analyze(bin_path, scene)
        return

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    stats = build_glb(scene, bin_path, args.bin_dir, args.out, verbose=args.verbose)
    print(f"Wrote {args.out}  meshes={stats['meshes']} nodes={stats['nodes']} "
          f"mats={stats['materials']} tex={stats['textures']} cameras={stats['cameras']} "
          f"vbo_verts={stats['total_vbo']} bin={stats['bin_bytes']}")

    # Write hotspots/controls for the viewer
    hs_out = args.hotspots_out or os.path.join(os.path.dirname(os.path.abspath(args.out)), "hotspots.json")
    payload = {
        "title": scene["title"],
        "init_script": scene["init_script"],
        "views": scene["views"],
        "scripts": scene["scripts"],
        "sequences": scene["sequences"],
        "hotspots": app["hotspots"],
        "controls": app["controls"],
        "ui_fields": app["ui_fields"],
        "menu_order": (app["ui_fields"].get("MENU_ORDER") or "").split(","),
    }
    with open(hs_out, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    print(f"Wrote {hs_out}")


if __name__ == "__main__":
    main()
