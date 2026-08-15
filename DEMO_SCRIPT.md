# Motion Swatch — Demo Video Script

Three levels, ~6–8 minutes total. One narrative thread ties them together:
**"Motion here is eight editable numbers, not baked video."**

---

## Prep checklist (before recording)

- [ ] **Film two phone clips** (5 seconds each, phone propped on something stable, one motion dominating the frame):
  1. **Steam** rising from a boiling kettle/pot against a dark cupboard.
  2. **Any real flag** on a pole outside (or a curtain at an open window as fallback).
  AirDrop both to the Mac.
- [ ] Start the web app: `cd motion-swatch-poc && python3 -m http.server 8000`
- [ ] Start the analysis service: `./service/run.sh` (wait for "Uvicorn running")
- [ ] Sanity check: `curl http://127.0.0.1:8765/health` → `"ok": true`
- [ ] Open two browser tabs:
  - Tab A: `http://localhost:8000` (the tool)
  - Tab B: `http://localhost:8000/travel-site/` (the Wilder Valley site — hero is STATIC right now; that's the "before")
- [ ] Open Finder at `travel-site/assets/` (for the file-swap moment)
- [ ] Clear any leftover swatches: DevTools console → `localStorage.clear()` → reload
- [ ] QuickTime → New Screen Recording. Record phone clips separately and cut them in.

---

## COLD OPEN (15 seconds)

*Screen: Tab B — the travel website, static hero.*

> "This is a website for a small trekking company. Nice illustration — but it's
> frozen. Getting it animated normally means After Effects, a motion designer,
> and a JavaScript animation library the client's website builder won't even allow.
>
> I'm going to bring it to life in three steps — and the last one, the wind
> outside my window does for me."

---

## LEVEL 1 — Click an object, click a motion (~90 seconds)

*Screen: Tab A — the tool with the valley poster.*

> "This is the same illustration inside a little tool called **Motion Swatch**.
> Everything in the scene is clickable."

**DO:** Click a **cloud** → click **Cloud Drift** in the library. It starts moving immediately.

> "Click a cloud… click a motion… that's it. No timeline, no keyframes."

**DO:** Rapid-fire, one click each — narrate as you go:
- **cloud 2** → Cloud Drift
- **sun** → Sun Pulse
- **tree 1**, **tree 2** → Gentle Sway
- **river** (the lake) → Water Ripple
- **boat** → Water Ripple
- **mist** → Rising Smoke (slow fog crawl)
- **birds** → Cloud Drift

**DO:** Hit **▶ Play**. Let it breathe for 5 full seconds, silent.

> "Thirty seconds ago this was effectively a JPEG. I never opened an animation tool."

**DO:** Click one tree, drag its **Intensity** down and **Speed** down slightly.

> "And every object is individually tunable — distant trees move softer and slower
> than the near pine up front. That's depth, for free."

---

## LEVEL 2 — Steal motion from the real world (~2 minutes)

*This is the heart of the demo. Slow down here.*

> "Presets are fine. But here's the actual idea: you don't have to describe
> the motion you want. You can go **film it**."

**CUT TO:** phone footage of your kettle boiling (2–3 seconds).

**DO:** Back in Tab A — click **+ Upload motion video**, pick the steam clip.
Wait for analysis (a few seconds — the status line says which engine analyzed it).

> "A deep optical-flow model — RAFT, an award-winning computer-vision paper from
> Princeton, running locally on my Mac — just watched every pixel of that steam
> move, and compressed the *character* of that motion into eight numbers.
> Frequency. Amplitude. Direction. Turbulence. Drift."

**DO:** Hover the new swatch card — point at the thumbnail:

> "The card is looping my actual kitchen. And look at the numbers — it detected
> the motion is *rising*. That's the drift."

**DO:** Click the **mist** (fog lying on the water) → click the steam swatch.

> "Now the morning fog on the lake rises and crawls with the exact character
> of my kettle. Not 'an animation of fog' — *my* steam."

**DO:** Repeat quickly with the **second clip** (a flag/curtain in wind): upload → apply to the **trees** (both).

> "Same trick: this clip is real wind from outside my window. Upload… apply to
> the pines… and the wind that was blowing this morning is now moving the
> trees in the illustration. **You can't type that into a prompt — this motion
> has provenance. It happened.**"

**OPTIONAL BEAT (if pacing allows):** Drag the wind swatch's frequency slider live.

> "And because a captured motion is just numbers, I can still edit it. Calmer…
> wilder… it's a dial, not a re-render."

---

## LEVEL 3 — Ship it to a real website (~2 minutes)

> "Okay — but this is all inside my tool. A client's website can't run any of
> this. Watch."

**DO:** Click **Export animated SVG** in the header. A file downloads.

> "One click. Everything you saw — every motion, every loop — gets baked into a
> single SVG file. CSS keyframes inside the image itself. **Zero JavaScript.**"

**DO:** In Finder: rename the downloaded file to `hero.svg` and drop it into
`travel-site/assets/`, replacing the old one. Show the replace dialog on camera.

> "The website references `hero.svg`. I'm not touching a line of the website's
> code — I'm replacing an image file. That's the entire deployment."

**DO:** Switch to Tab B. Hit refresh. **Pause. Let it land for 5 seconds.**

The hero is alive: kettle-steam fog crawling on the lake, real-wind pines
swaying, clouds drifting, the boat bobbing on the glint.

> "Same website. Same `<img>` tag. The illustration just… woke up.
> This works on Squarespace, WordPress, Shopify, a GitHub README — anywhere an
> image loads, because it **is** an image."

**DO:** Right-click the hero → Open Image in New Tab — it animates standalone.

> "Those pines are moving with wind I filmed this morning. The fog is my kettle.
> The whole thing is one 130-kilobyte file."

---

## CLOSER (20 seconds)

*Screen: split or quick cuts — phone clip of wind / animated site side by side.*

> "Designers spend hours faking natural motion with easing curves. But natural
> motion is free — it's everywhere, all day. Motion Swatch just lets you pick
> it up and paint with it.
>
> Film it. Click it. Ship it. **The website breathes like the place does.**"

*(Optional roadmap line for a pitch audience:)*

> "And because every motion is eight live numbers — imagine binding them to a
> weather API. The trees on the site sway harder when it's actually windy at
> the destination. That's where this goes next."

---

## Shot list summary

| # | Screen | Beat |
|---|--------|------|
| 1 | Travel site (static) | Cold open — the frozen "before" |
| 2 | Tool | Click cloud → drift (first magic) |
| 3 | Tool | Rapid-fire presets → Play → full scene alive |
| 4 | Tool | Slider tuning (depth) |
| 5 | Phone footage | Kettle steam |
| 6 | Tool | Upload → card loops real clip → point at numbers |
| 7 | Tool | Steam onto the lake fog |
| 8 | Phone footage → Tool | Wind clip → pine trees |
| 9 | Tool | Export click |
| 10 | Finder | hero.svg file swap |
| 11 | Travel site | Refresh → ALIVE (the money shot) |
| 12 | Travel site | Right-click → image in new tab |
| 13 | Split | Closer + tagline |

## Recovery notes (if something goes wrong on camera)

- **Upload analysis fails / service down:** the app silently falls back to the
  in-browser analyzer — the demo still works, the card just says "Captured
  in-browser". Don't call it out; keep going.
- **A motion looks too subtle:** bump that object's Intensity slider — it's live.
- **Steam clip extracts weak drift:** apply **Rising Smoke** preset instead and
  keep the story ("captured earlier"); re-film after with a darker background.
- **Reset everything:** reload Tab A, `localStorage.clear()` in console if the
  library is cluttered. The static hero for Tab B is backed up at
  `travel-site/assets/hero-static.svg` — copy it back over `hero.svg` to reset
  the "before" state.
