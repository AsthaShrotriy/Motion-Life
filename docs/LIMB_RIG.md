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
any raised arm does). What that delta is added to is a choice — the drawn pose, or the
capture's own stance. See **Rest retargeting** below; it decides whether a drawing keeps its
stance and borrows the movement, or adopts both.

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

`tests/boy_limbs.js` on a rigged reference boy driven by the shipped 132-frame walk, at the
default `'all'` rest mode — so each **own rotation** below is the one-off rest offset from the
table further down *plus* that frame's swing:

| limb | own rotation | shape distortion | joint ride | tip travel |
|---|---|---|---|---|
| `leg-l` |   +5.11° … +117.03° | 0% | 22.2 px | 382.3 px |
| `leg-r` |  −56.42° …  +64.22° | 0% | 19.6 px | 216.7 px |
| `arm-r` | −142.97° …  −70.52° | 0% | 94.2 px | 220.4 px |
| `head`  |  −85.73° …  −36.69° | 0% | 96.8 px |  91.4 px |
| `torso` |  −32.04° …   +0.62° | 0% |    0 px |    14 px |
| `arm-l` | 0° … 0° (no signal) | 0% | 92.0 px |  56.4 px |

- `_applyLimbs` ran on all 60 sampled frames; `_applyCloth`, `_applyCharacter` and
  `_applyWings` were not called once.
- **Shape distortion is 0% on every limb** — rotation is rigid, which is the whole difference
  from the cloth applicator's 112.8%.
- Every **swing** is inside ±75° and there is no `NaN` in any transform. The own rotations above
  exceed that only by their rest offset, which is deliberately uncapped (see below); a range can
  also be up to 150° wide, since the cap is per frame and applies each way.
- `arm-l` emits exactly **one** distinct own-angle (0°) across the clip — it holds its drawn
  pose, retargeting or not. Its 56.4 px of tip travel is the torso carrying it, not invented
  arm motion.
- Stopping restores each group's original `transform`, not a bare removal — an Illustrator
  group may legitimately carry one, and removing it would move the limb. (The same gap in
  `_applyWings`, which used to keep its last rotation after a stop, is fixed alongside.)

`tests/boy_limb_gap.js` measures the hierarchy separately and renders the worst frame.

## Rest retargeting: whose pose is the neutral

`LIMB_RETARGET_DEFAULT` (`'off' | 'legs' | 'all'`, default **`'all'`**, exposed as the
inspector's *Rest pose* dropdown) chooses what the per-frame delta is added to.

- **`'off'`** adds the delta on top of the pose **as drawn**. The artwork is untouched and
  borrows only the movement — right when the drawn stance already resembles the clip's.
- **`'all'`** rotates every usable limb so it starts along the **captured** bone, then adds the
  delta. Proportions and art are untouched; the stance becomes the subject's.
- **`'legs'`** does that for the leg and shin roles only, leaving arms, head and torso as drawn.

A limb with **no usable frame is never retargeted** whatever the mode — its captured rest angle
of 0 means *"this bone was never seen"*, and rotating a drawing to it would be an invention. It
holds its drawn pose, exactly as under `'off'`.

Retargeting has to subtract the ancestors. A captured bone angle is measured in the video
frame, so it **already contains the parent's rotation**; the chain would then apply the parent
a second time. `_applyLimbs` resolves limbs shortest-chain-first and subtracts what the
ancestors are about to contribute (`- acc`). Nor is the offset subject to `LIMB_DEG_MAX`: that
cap exists so one bad frame cannot fling a limb, and a rest alignment is a one-off, not a
swing — the boy's `arm-l` needs **+144.9°**, and capping it would half-apply the alignment.

What the alignment costs, measured on the boy against both shipped captures (each limb's
captured rest, its drawn direction, and the resulting one-off offset after the mirror and the
ancestor subtraction):

| limb | captured rest | drawn | offset — `walk-man.mp4` | offset — `walk-pose.json` |
|---|---|---|---|---|
| `torso` | −92.4° / −100.8° | −87.7° | −4.7° | −13.1° |
| `leg-l` | +93.1° / +99.2° | +58.3° | **+39.5°** | +54.1° |
| `leg-r` | +90.4° / +111.3° | +115.1° | −20.0° | +9.3° |
| `arm-l` | +75.9° / — | −64.3° | +144.9° | 0° (no usable frame) |
| `head`  | −101.2° / −155.1° | −76.5° | −20.0° | −65.6° |
| `arm-r` | +94.8° / +94.2° | −139.7° | −120.9° | −113.0° |

The two leg offsets are asymmetric because each aligns to *its own* captured rest: +39.5° and
−20° together close the drawn 56.8° splay down to the capture's own 2.7° residual.

## Facing: the capture's left is not the artwork's left

MediaPipe labels landmarks by the **subject's own** left and right, so their horizontal
arrangement flips with the camera. Filmed from behind, the anatomical left hip sits at *lower*
x; a figure drawn facing the viewer has its anatomical left limb at *higher* x. Matching
role-to-role without reconciling that mirrors every horizontal component — the frames where the
subject's feet converge push the artwork's **apart**.

Measured: `walk-man.mp4` (a man walking away) has a median `l_hip.x − r_hip.x` of **−0.115**,
while the boy's leg pivots are 737 vs 500, i.e. **+237**. Opposite signs, so `_applyLimbs`
mirrors the capture — reading the artwork's side from the declared pivots (legs, falling back
to arms) and the capture's from the hips. Mirroring in x maps a bone direction `(dx,dy)` to
`(−dx,dy)`, so an angle becomes `180 − angle` and a delta simply negates. **Antiphase survives**
because both sides negate: this changes *which* leg leads, not *whether* they alternate.

There was no facing handling at all before, and the stored swatch has no `viewpoint` key to
read, which is why this is inferred from the geometry on both sides rather than declared.

## Why the legs did not cross, and what fixed it

Reported from a run of `walk-man.mp4` on the boy: *"the legs are not crossing each other."*
They were not, for two independent reasons, and **both** had to be fixed. Simulating each on
its own over all 155 frames against the boy's real geometry: retargeting without the mirror
brings the feet within a few px and stops there, because the horizontal half of every delta is
still inverted; mirroring without retargeting leaves the drawn 56.8° splay wide open. Only the
pair crosses.

The first reason is a property of the clip, which `tests/clip_stride.py` measures:

| clip | in-plane thigh swing | antiphase corr | knee-x / ankle-x flips in the source | verdict |
|---|---|---|---|---|
| `walk-man.mp4` | 26.1° / 28.6° | −0.566 (−0.778 at best lag) | **2 / 6** in 155 frames | swing too small |
| `walk-pose.json` (shipped) | 104.5° / 110.0° | −0.608 | 12 / 21 in 132 | alternating, wide, crossing |
| `dance.mp4` | 153.5° / 168.7° | **+0.873** | 28 / 30 in 160 | legs move *together*, not a walk |
| `walk-grid.mp4` | — | — | — | **0/160** usable left thigh |

The **ankle-x** column and the visibility gate on both flip counts were added after the fact,
which is why `dance.mp4` reads 28 knee flips here where an earlier ungated count said 34. The
tool re-extracts and re-measures in under a minute (`service/run-pose.sh`, then pipe the video
into `/extract?kind=pose&fmt=b`), so every row above is reproducible rather than remembered.

The alternation in `walk-man.mp4` is real — the two thighs are genuinely in antiphase, and
**the crossing is in the capture too, at the ankle**: `l_ankle.x − r_ankle.x` changes sign
**6** times over the 155 frames (span −0.256 … +0.172). Earlier sessions only ever measured the
*knee*, which flips twice (span −0.174 … +0.013) because the man walks away from the camera and
his legs pass mostly in **depth**. So the picture-plane stride is thin but not absent; what is
missing is *amplitude* — 26.1° / 28.6° peak to peak. (The hips never swap sides at all: 0 flips,
span −0.123 … −0.101, which is what the facing test below reads.)

The second reason is the drawing. Measured directions of the boy's own leg groups, pivot to
foot: `leg-l` **+58.3°**, `leg-r` **+115.1°** — a **56.8° splay**, feet 972.6 px apart in user
space. The man's thighs rest **2.7°** apart (93.1° / 90.4° as the rig reads them). Closing that
takes **+39.5°** on one leg and **−20°** on the other, against a supply of 26.1° / 28.6° peak to
peak — about ±13° from rest. Under `'off'` the walk is added *on top of* the splay by design, so
no honest intensity closes it.

Crossing measured directly by `tests/boy_foot_cross.js` — the signed gap between the two
**drawn feet** (each found once in its group's own user space, then carried by the live CTM),
over all 155 frames, in screen px:

| intensity | `'off'` gap | crosses? | `'all'` gap | crosses? |
|---|---|---|---|---|
| 1.0 | 125 … 223.3 px | no | **−27.4 … 83.2 px** | **yes, 4×** |
| 1.5 | 94.3 … 241.4 px | no | −58 … 106.4 px | yes, 4× |
| 2.0 | 63.3 … 258.2 px | no | −87.2 … 129.2 px | yes, 6× |
| 3.0 | 2.7 … 287.3 px | no | — | — |

`'legs'` lands within 0.1 px of `'all'` here, since only the legs decide the gap.

**An earlier version of this table was wrong, and this is why the test exists.** It claimed
intensity 2.0 crossed at −10.5 … 185.5 px. That reading took each leg group's **bbox
bottom-centre** as "the foot" — but a leg drawn on a diagonal has its foot at a bbox *corner*,
so the reading put the boy's feet **5.3× closer together** than they are and manufactured a
crossing that was not on screen. Intensity 3 is the end of the honest range anyway: 26° scaled
by 3 is 78°, past `LIMB_DEG_MAX`, and even there `'off'` only gets within 2.7 px.

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

A better clip — side-on or three-quarter, well lit, subject filling the frame — would still give
a wider stride than any of this, and nothing in `assets/videos/` qualifies today. But it is no
longer the *only* fix: with the rest retargeted and the facing reconciled, this clip's own
measured stride crosses the boy's feet at intensity 1.

What `'all'` costs is the drawing's stance, and that is visible: the boy's star jump is gone,
his arms come down (`arm-l` alone is a **+144.9°** offset), his head straightens and his torso
uprights. That is the honest trade — the mode exists so it is the user's call, per figure, and
`'off'` still keeps the drawing exactly as it was.

## Limitations

- **A whole-leg group is driven by the thigh.** `LIMB_BONES['leg-l'] = ['l_hip','l_knee']`,
  though the boy's tagged group spans hip to shoe. Measured alternatives on this clip: thigh
  26.1° / 28.6° swing at −0.566 antiphase, hip→ankle 31.3° / 29.9° at −0.565, shin 46.7° /
  39.1° at only −0.313. Hip→ankle is a ~5° gain and was left alone deliberately.

- **Pivots are authored by hand.** Nothing infers a shoulder from the drawing yet.
- **Rotation only** — no stretch, no squash, no elbow/knee IK. `forearm-*` and `shin-*` roles
  exist and work, but our reference artwork does not separate them from the upper limb.
- **The driver should be re-captured.** `walk-pose.json` predates the `_normalize_clip` fix;
  a fresh extraction would give cleaner angles and would also restore the hip signal that
  the bob decision above had to give up.
- **A side-on clip cannot articulate both sides.** Half the rig holds still, honestly, and
  the fix is a better clip rather than better code.
- **SVG export does not bake limb rotation.** Video export does.
