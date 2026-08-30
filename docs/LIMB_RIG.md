# Limb Articulation in MotionLife

**Summary.** A figure whose limbs are tagged in the SVG can now be driven directly by a
captured pose: each limb rotates about its own joint by the angle that the *same bone* makes
in the video, frame for frame. This is the first applicator that produces real per-limb
articulation on ordinary artwork — arbitrary Illustrator paths, no procedural rig required.

## Why the existing paths could not do it

Two applicators already consumed pose swatches, and neither fits hand-drawn artwork:

- **`_applyCharacter`** rewrites `<polygon points>` and circle `cx`/`cy`. That works for the
  procedural duck/bear scenes, which are built from polygons on purpose, but an Illustrator
  export has nothing for it to move. Its fallback (`puppet` mode) bobs and weight-shifts the
  whole figure as one rigid piece — measured at ~4.7 screen px on our reference boy. That is
  a figure *being carried*, not a figure *moving*.
- **`_applyCloth`** deforms path geometry. Applied to a limb it tears: worst-case segment
  length change of 112.8% on one leg, 95.2% on the other. An arm is not cloth.

Because dispatch is class-keyed, there was no way to reach anything else — the one genuinely
extracted swatch we have is `class: "cloth"`, so a limb always got the cloth applicator.

## The tagging contract

Two attributes on each limb group, plus a name for the figure so it stays one selectable unit:

```xml
<g id="Boy" class="layer" data-name="Boy">
  <g id="Right_Hand"   data-limb="arm-r" data-pivot="437 690">…</g>
  <g id="Left_Hand"    data-limb="arm-l" data-pivot="740 690">…</g>
  <g id="Right_Leg"    data-limb="leg-r" data-pivot="500 1180">…</g>
  <g id="Left_Leg"     data-limb="leg-l" data-pivot="737 1200">…</g>
  <g id="Face"         data-limb="head"  data-pivot="514 655">…</g>
  <g id="Rest_of_Body" data-limb="torso" data-pivot="610 1200">…</g>
</g>
```

- **`data-limb`** names the role. Ten are recognised: `arm-l/r`, `forearm-l/r`, `leg-l/r`,
  `shin-l/r`, `head`, `torso`. An unrecognised role is left alone rather than guessed at.
  Roles are **anatomical, not screen-side** — the boy's `arm-r` appears on the viewer's left.
- **`data-pivot="x y"`** is the joint, in the limb's **own user space** (the space
  `getBBox()` reports). For an export whose groups carry no transform of their own, that is
  just the root `viewBox`. Omit it and the joint is inferred by clamping the torso's centre
  into the limb's bounding box, which lands on the edge where the limb attaches — usable,
  but a declared pivot is always better.
- **`data-limb` counts as a rig**, so `_hasRig` keeps the whole tagged figure as one
  selection. Without that, `resolveWrapForTarget` drills into the leaves and each limb
  becomes its own selection with no torso to hinge against.

`tests/make_boy_limbs.js` builds a rigged copy of a reference SVG into `/tmp` and prints the
mapping; it never writes the source file.

## What drives the rotation

For a role, `LIMB_BONES` gives the two captured joints whose direction defines it (e.g.
`arm-r` → `r_sho`→`r_elb`). `@sho` and `@hip` are the shoulder and hip **midpoints** —
virtual joints, so `head` and `torso` run through exactly the same bone-angle code as a real
limb instead of needing a special case.

Rotation is a **delta from the bone's rest angle**, where rest is the *circular* mean over
the clip (a plain average of `atan2` output is wrong the moment a bone straddles ±180°, which
any raised arm does). The delta form means **the drawn pose is the neutral**: a boy drawn with
his arms overhead stays arms-overhead and the capture swings them around that. Absolute
angles would snap the artwork into the subject's stance on frame 1 and throw the drawing away.

Unlike `_applyWings`, which maps a clip's range onto a fixed 26° sweep on purpose, the
**measured amplitude is kept**. The subject's own articulation is the entire point, so a small
movement stays small. Only `LIMB_DEG_MAX` (75°) clamps it, so one bad frame cannot fling an
arm across the canvas.

## The rig is hierarchical

A child rotates about its own joint first, then rides its parent (`LIMB_PARENT`: arms, head
and legs hang off `torso`; forearms off arms; shins off legs). This matters and was measured:
with a **flat** rig, the torso's ±19° lean moved the shoulders while the arms pivoted about
points that never moved, opening a **54.8 px** gap at the left shoulder, **56.1 px** at the
right and **57.7 px** at the neck (worst frame t=8.07, plainly visible as the arm separating
at the armpit). Composing the parent's rotation outside the child's closes it to **0 px**.

Ancestors the artwork did not tag are simply absent from the chain, so a partial rig degrades
to a flat one rather than failing.

## Two gates, and what happens when a limb has no signal

A frame is believed only when both hold:

- **`LIMB_VIS_OK` (0.5)** — MediaPipe's own visibility. Below it the landmark is an inference,
  not an observation.
- **`LIMB_FORESHORTEN` (0.6)** — a bone pointing at the camera projects *short*, and its 2D
  angle becomes noise; at the limit an arm aimed down the lens has no direction on screen at
  all. So the bone must still project at least 0.6 × its own median length. Measured on the
  shipped `assets/motion/walk-pose.json`: at 0.6 the right arm and both legs keep all 132
  frames, while the **left arm keeps none** — that subject is side-on with the left side
  occluded.

A gated frame **holds the previous good angle**, so occlusion reads as a pause rather than a
twitch. A limb with **no usable frame at all holds its drawn pose** and never moves.

It is deliberately **not mirrored** from the opposite limb. Filling the boy's left arm in from
his right with a half-period offset would look better while being *invented*. This tool exists
to show motion that was actually measured, so an unmeasured limb stays still.

**No hip-driven bob**, either. The shipped capture predates the `_normalize_clip` fix in
`service/pose_server.py` and still normalises each frame by that frame's own extent, so its
hip midpoint wanders 0.58 of the frame as pure normalisation drift (x stdev 0.115). Sliding
the figure on that artifact would be dishonest, and under the fixed pipeline the signal is
identically zero anyway because the hips are the anchor.

## Measured behaviour

`tests/boy_limbs.js` on a rigged reference boy driven by the shipped 132-frame walk:

| limb | own rotation | shape distortion | joint ride | tip travel |
|---|---|---|---|---|
| `leg-l` | −56.23° … +46.10° | 0% | 13.2 px | 238.8 px |
| `leg-r` | −42.55° … +64.30° | 0% | 11.7 px | 233.4 px |
| `arm-r` | −32.15° … +47.53° | 0% | 56.1 px | 129.9 px |
| `head`  | −22.01° … +13.97° | 0% | 57.7 px |  56.8 px |
| `torso` | −13.74° … +18.93° | 0% |    0 px |   8.3 px |
| `arm-l` | 0° … 0° (no signal) | 0% | 54.8 px |  33.6 px |

- `_applyLimbs` ran on all 60 sampled frames; `_applyCloth`, `_applyCharacter` and
  `_applyWings` were not called once.
- **Shape distortion is 0% on every limb** — rotation is rigid, which is the whole difference
  from the cloth applicator's 112.8%.
- Every angle is inside ±75°; no `NaN` in any transform.
- `arm-l` emits exactly **one** distinct own-angle (0°) across the clip — it holds its drawn
  pose. Its 33.6 px of tip travel is the torso carrying it, not invented arm motion.
- Stopping restores each group's original `transform`, not a bare removal — an Illustrator
  group may legitimately carry one, and removing it would move the limb. (The same gap in
  `_applyWings`, which used to keep its last rotation after a stop, is fixed alongside.)

`tests/boy_limb_gap.js` measures the hierarchy separately and renders the worst frame.

## Why the legs may not cross, and what to do about it

Reported from a run of `walk-man.mp4` on the boy: *"the legs are not crossing each other."*
They were not, and the reason is a property of the clip. `tests/clip_stride.py` measures it:

| clip | in-plane thigh swing | antiphase corr | knee-x flips in the source | verdict |
|---|---|---|---|---|
| `walk-man.mp4` | 26.1° / 28.6° | −0.566 (−0.778 at best lag) | **2** in 155 frames | swing too small |
| `walk-pose.json` (shipped) | 104.5° / 110.0° | −0.608 | 12 | alternating, wide, crossing |
| `dance.mp4` | 153.5° / 168.7° | **+0.873** | 34 | legs move *together*, not a walk |
| `walk-grid.mp4` | — | — | — | **0/160** usable left thigh |

The alternation in `walk-man.mp4` is real — the two thighs are genuinely in antiphase. It is
the *amplitude* that is missing, because the man is walking away from the camera: his legs pass
each other in **depth**, and `l_knee.x − r_knee.x` changes sign only twice in the whole clip
(span −0.174 … +0.013 — almost always the same side). A 2D pose has nothing to give the rig
there. The applicator is faithfully reproducing a stride that is not happening in the picture
plane.

Crossing on this artwork was measured directly (leg-tip horizontal gap, rest = 77.8 px):

| intensity | gap min … max | crosses? |
|---|---|---|
| 1.0 | 33.3 … 134.2 px | no |
| 1.5 | 11.1 … 160.7 px | no |
| **2.0** | **−10.5 … 185.5 px** | **yes** |
| 2.5 | −31.4 … 208.3 px | yes |

So intensity **2** is where the legs first pass each other, and that is an honest scale on
measured antiphase motion rather than invented crossing. The drawn pose matters too: this boy
is drawn mid-jump with the legs already 77.8 px apart, so a rest pose with the legs together
would cross at a lower intensity.

**MediaPipe's depth does not rescue this — measured, not assumed.** `pose_server.py` stores
`(x, y, visibility)` and drops `lm.z`, and the obvious idea is to use `z` (or
`pose_world_landmarks`) so a stride into depth becomes a real angle. `tests/pose_depth_probe.py`
runs all three readings over the same 155 frames:

| reading | leg-l swing | leg-r swing | per-frame jitter | antiphase corr |
|---|---|---|---|---|
| 2D image angle (what the rig uses) | 14.9° | 16.3° | 0.5° | **−0.568** |
| `lm.z` image depth | 51.2° | 46.6° | 3.5° | **+0.207** |
| `pose_world_landmarks`, sagittal | 25.7° | 22.7° | 1.4° | −0.149 |

Depth gives the biggest numbers and the **wrong sign**: at +0.207 the legs would swing
*together*. It is also 7× noisier frame to frame. The thigh vector really is 44% depth by
variance, so the stride is there in the world — MediaPipe's estimate of it just is not good
enough on a small, dark, receding subject. The 2D reading is the only one that preserves the
alternation, so the rig keeps using it. (The 14.9° here vs 26.1° in the table above is not a
discrepancy: `_normalize_clip` multiplies x by the source aspect, 1280/720, which is the
correct correction for `x` and `y` being normalised by different pixel counts.)

The real fix is a better clip: side-on or three-quarter, well lit, subject filling the frame.
Nothing in `assets/videos/` qualifies today.

## Limitations

- **Pivots are authored by hand.** Nothing infers a shoulder from the drawing yet.
- **Rotation only** — no stretch, no squash, no elbow/knee IK. `forearm-*` and `shin-*` roles
  exist and work, but our reference artwork does not separate them from the upper limb.
- **The driver should be re-captured.** `walk-pose.json` predates the `_normalize_clip` fix;
  a fresh extraction would give cleaner angles and would also restore the hip signal that
  the bob decision above had to give up.
- **A side-on clip cannot articulate both sides.** Half the rig holds still, honestly, and
  the fix is a better clip rather than better code.
- **SVG export does not bake limb rotation.** Video export does.
