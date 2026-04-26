# kaon_export

Tools for downloading Kaon-format 3D product visualizations and converting them to glTF (`.glb`) for use in a self-hosted Three.js viewer.

The pipeline has three stages:

1. `dumper.py` downloads every asset listed in the remote `manifest.webgl.txt`, verifies each by hash, and writes the tree to `./dumps/`.
2. `lepton_to_gltf.py` parses a Kaon scene (`lepton.xml` + `geometry_raw.bin` + textures) and produces a single `.glb` plus a hotspots JSON.
3. `tools/build_model_index.py` walks `./dumps/` and emits `viewer/models.json` so the bundled viewer can list available scenes.

## Contents

- `dumper.py` - Downloads `lepton.js`, `manifest.webgl.txt`, and every asset listed in the manifest into `./dumps/`. Re-running skips files whose hash already matches; mismatches are appended to `mismatches.txt`.
- `lepton_to_gltf.py` - Converts a Kaon `lepton.xml` + `geometry_raw.bin` (+ textures) scene to a single glTF binary. The reverse-engineered binary format is documented at the top of the file.
- `tools/build_model_index.py` - Walks `./dumps/`, joins each `lepton.xml` with `dumps/catalog/catalog.json`, and writes `viewer/models.json` for the viewer's model picker.
- `viewer/` - Vanilla-JS Three.js viewer (`index.html`, `js/`, `css/`). Loads a `.glb` and its sidecar metadata, with orbit controls, animation timeline, hotspot picking, and a debug panel.
- `start.bat` - Convenience launcher that runs `python -m http.server 6767` from the repo root.

## Requirements

- Python 3.10 or newer (developed on 3.14).
- Python packages from `requirements.txt`:
  - `curl-cffi` for browser-impersonating downloads.
  - `numpy` for geometry buffers.
- A modern browser with WebGL2 for the viewer.

## Install

```
git clone <repo-url>
cd kaon_export
python -m venv .venv

# Windows
.venv\Scripts\activate

# macOS / Linux
source .venv/bin/activate

pip install -r requirements.txt
```

## Usage

Run all commands from the repo root.

### 1. Download assets

```
python dumper.py
```

Populates `./dumps/`. The script reads `manifest.webgl.txt` from the configured Kaon endpoint and downloads every entry in parallel with hash verification. Existing files whose hash matches are skipped, so re-running is cheap. If the remote bytes do not match the expected hash, the URL is appended to `mismatches.txt` instead of being written.

### 2. Convert a scene to GLB

```
python lepton_to_gltf.py --lepton <path-to-lepton.xml> --bin-dir <dir-containing-geometry_raw.bin> --out out/scene.glb
```

All arguments have defaults that point at one of the dumped scenes. Useful flags:

- `--lepton` - Path to the scene's `lepton.xml`.
- `--app` - Path to the scene's `app.xml` (controls and views).
- `--bin-dir` - Directory containing `geometry_raw.bin` and textures.
- `--bin` - Override the geometry bin path.
- `--out` - Output `.glb` path.
- `--hotspots-out` - Where to write the hotspots JSON (default: alongside `--out`).
- `--analyze` - Print structural info about the scene without converting.
- `-v` / `--verbose` - Verbose logging.

Run `python lepton_to_gltf.py --help` for the full list.

### 3. Build the viewer index

```
python tools/build_model_index.py
```

Writes `viewer/models.json` from whatever scenes currently exist under `./dumps/`. Run this after each new conversion so the viewer's dropdown stays current.

### 4. Run the viewer

```
start.bat
```

(Or `python -m http.server 6767` on macOS/Linux.) Then open <http://localhost:6767/viewer/> and pick a model from the dropdown. The viewer loads its target scene from the URL hash, so you can deep-link to a specific model and view.

## Project layout

```
kaon_export/
  dumper.py
  lepton_to_gltf.py
  requirements.txt
  start.bat
  LICENSE
  README.md
  tools/
    build_model_index.py
  viewer/
    index.html
    css/
    js/
  dumps/   (gitignored, populated by dumper.py)
  out/     (gitignored, populated by lepton_to_gltf.py)
```

## Disclaimer

This repository contains tools only. No third-party 3D assets, textures, or vendor JavaScript are included. The download and conversion scripts are provided for educational and interoperability purposes; you are responsible for ensuring that you have the right to download, convert, and redistribute any content you run them against.

## License

Released into the public domain under The Unlicense. See `LICENSE`.
