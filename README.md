# Motion Swatch

Capture motion from a real video, extract it into a reusable **motion swatch**, and
apply it to any object in a piece of vector artwork. A flag clip becomes a "Flag
Flutter" swatch you can drop onto a banner; a smoke clip becomes rising steam over
a coffee cup. Motion is stored as **8 editable numbers + a 12×12 grid of real point
trajectories**, not baked video — so it re-times, re-scales, and re-applies to any
shape.

![Motion Swatch](docs/screenshot.png)

---

## What it does

1. **Load artwork** — a built-in Poster or Scenery scene, or upload your own
   SVG / PNG / JPEG.
2. **Select an object** — click any SVG object (or draw a rectangle on a raster
   image). Each object becomes an independently animatable region.
3. **Get a motion** — pick one of 8 built-in presets, or click **"Capture motion
   from video"** and upload a short clip. The clip is analyzed with **RAFT optical
   flow** and distilled into a swatch.
4. **Apply & tune** — assign the swatch to the selected object, adjust Speed /
   Intensity, toggle **Cloth mode** (the geometry itself ripples, in place, instead
   of moving rigidly).
5. **Play** — every object animates at once with its own motion.
6. **Export** — animated SVG or a video of the result.

---

## Quick start

The browser app is **vanilla JS + SVG + Canvas** — no build step, no npm install.
The Python analysis service is **optional** (the app falls back to a lighter
in-browser analyzer if it isn't running), but recommended for best extraction.

### 1. Serve the web app

```bash
cd motion-swatch-poc
python3 -m http.server 8000
# open http://localhost:8000
```

### 2. (Optional) Start the RAFT analysis service

```bash
cd service
./run.sh        # first run creates a venv and downloads the ~4 MB raft_small checkpoint
```

This serves the analyzer at `http://127.0.0.1:8765`. The app auto-detects it; if it
is down, capture still works using the in-browser analyzer.

**Requirements** (installed automatically by `run.sh`): Python 3.9+, `torch`,
`torchvision`, `numpy`, `opencv-python-headless`, `fastapi`, `uvicorn`. Runs on
Apple-silicon MPS, CUDA, or CPU.

---

## How to use it (demo walkthrough)

1. Open `http://localhost:8000`.
2. Choose a scene at the top (**Poster** / **Scenery**), or click **Upload artwork**
   to load your own SVG.
3. Click an object in the artwork — it highlights and appears as a chip at the
   bottom. The **Region Inspector** opens on the right.
4. Either:
   - Click a preset in the **Motion Library** (Flag Flutter, Rising Smoke, Cloud
     Drift, …), **or**
   - Click **+ Capture motion from video**, choose a short clip (a flag, smoke,
     swaying trees, flowing water…). It extracts a new swatch into the library.
5. With the object selected, click the swatch to assign it. For cloth-like objects
   (flags, hair, water, foliage) turn on **Cloth mode** so the shape ripples in
   place rather than sliding.
6. Adjust **Speed** and **Intensity**.
7. Repeat for other objects, then press **▶ Play**.
8. **Export SVG** or **Export video** to save the result.

### Source videos

Sample source clips (flag, smoke, river, trees, birds, campfire) are **not** checked
into the repo (they're large binaries). Any short clip of a single clear motion works
— point the "Capture motion from video" picker at your own footage.

---

## Project layout

```
motion-swatch-poc/
├── index.html            # app shell + panel layout
├── css/style.css
├── js/
│   ├── motions.js        # 8 built-in motion presets
│   ├── capture.js        # video → analysis service (or in-browser fallback)
│   ├── flow.js           # in-browser Lucas–Kanade fallback analyzer
│   ├── distill.js        # flow field → 8 swatch parameters
│   ├── regions.js        # object selection + the .layer/.ms-wrap contract
│   ├── animate.js        # per-object displacement + trajectory-field replay engine
│   ├── scenery.js        # built-in Poster / Scenery SVG generators
│   ├── poster.js, multipick.js, extractviz.js, export.js, videoexport.js
│   └── main.js           # app controller / wiring
├── service/
│   ├── server.py         # FastAPI + RAFT optical-flow analyzer
│   ├── run.sh            # venv bootstrap + uvicorn launch (port 8765)
│   └── requirements.txt
├── assets/
│   ├── scenes/           # ready-made scene SVGs
│   └── targets/          # single-object target artworks
└── tests/                # puppeteer-core headless-Chrome checks
```

### The layer contract

An uploaded SVG becomes selectable when objects are marked
`<g class="layer" data-name="...">`. Elements with only an `id` are treated as
static backdrop. If neither is present (e.g. a flattened Illustrator export), the
app falls back to wrapping top-level drawable clusters automatically.

---

## Technology

- **Motion extraction:** RAFT (`torchvision` `raft_small`, C_T_V2 weights) deep
  optical flow, distilled to 8 parameters + a 12×12 trajectory grid.
- **In-browser fallback:** Lucas–Kanade flow when the service is offline.
- **Rendering:** vanilla JS, inline SVG, Canvas 2D. No framework, no bundler.
- **Tests:** `puppeteer-core` driving headless Chrome against the static server.

See `IMPLEMENTATION.md` for the full module-level spec, `informations.md` for design
rationale, and `DEMO_SCRIPT.md` for the demo narrative.

---

## Honest note on hardcoding

This is a **proof-of-concept built to demo well**. Some parts are genuine algorithms
and some are curated for reliability. `HARDCODING.md` documents exactly which is
which — read it before presenting this as fully automatic.
