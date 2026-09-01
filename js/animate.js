/*
 * animate.js — per-selection displacement engine.
 *
 * For each selection with a motion assigned, compute a parametric
 * displacement (dx, dy, rotation) each frame and apply it:
 *   - SVG selection   → set the wrapper <g>'s transform ATTRIBUTE
 *                       (verified: setting CSS transform on a group that
 *                        already has a transform="" attr conflicts; the
 *                        empty wrapper's attribute does not).
 *   - Raster selection → set the floating clone's CSS transform.
 */

/*
 * ---- Step 8: class → applicator ----
 * Which applicator can drive a swatch is decided ONCE, server-side, by
 * contracts.swatch_applicator(kind, class) and stamped into the swatch as
 * `applicator` — so the taxonomy lives in exactly one file and the two axes
 * (what the motion IS vs. what shape of data the swatch CARRIES) stay resolved
 * together. This table is only the fallback for a motion that carries a router
 * `class` but no swatch, and it must mirror MOTION_CLASSES in contracts.py.
 */
const APPLICATOR_BY_CLASS = {
  articulated: 'skeletal',
  cloth: 'wave',
  fluid: 'flow_field',
  flock: 'flock_drift',
  rigid_path: 'path_travel',
  oscillation: 'oscillate',
};

/*
 * How far the ribbon's own half-width may ride into a bend, as a fraction of that bend's
 * radius. At 1.0 the normal offset is exactly degenerate (the cloth turns inside out), so
 * this is the deepest fold a ribbon of a given thickness can be asked to make. Applied to
 * the whole centreline once per frame — see _ribbonBend.
 */
const RIBBON_KN_MAX = 0.8;

/* Default seconds for one traverse of an authored travel route (see _applyRoute). Matches
 * the extracted flutter's own 4s loop, so a scarf completes a whole gust per crossing. */
const ROUTE_SECONDS = 4.0;

/*
 * LIMB RIG (see _applyLimbs). Each artwork group tagged data-limb="<role>" is rotated about
 * its joint by the angle the SAME bone makes in the captured pose, frame for frame.
 *
 * The roles map to the 13 joints MediaPipe gives us. '@sho' / '@hip' are the shoulder and
 * hip midpoints — virtual joints, so the head and torso are driven by exactly the same
 * bone-angle code as a real limb instead of needing their own special case.
 */
const LIMB_BONES = {
  'arm-l': ['l_sho', 'l_elb'], 'arm-r': ['r_sho', 'r_elb'],
  'forearm-l': ['l_elb', 'l_wri'], 'forearm-r': ['r_elb', 'r_wri'],
  'leg-l': ['l_hip', 'l_knee'], 'leg-r': ['r_hip', 'r_knee'],
  'shin-l': ['l_knee', 'l_ank'], 'shin-r': ['r_knee', 'r_ank'],
  'head': ['@sho', 'nose'], 'torso': ['@hip', '@sho'],
};

/*
 * Which limb each one hangs off. Without this the rig is FLAT: every limb rotates about a
 * point that never moves, so when the torso leans the shoulders travel and the arms do not
 * follow. Measured on the rigged boy over the shipped walk, that opened a 54.8px gap at the
 * left shoulder, 56.1px at the right and 57.7px at the neck (worst frame t=8.07, visible as
 * the arm separating at the armpit). Composing the parent's rotation outside the child's
 * closes it: a child rotates about its own joint first, then rides its parent.
 *
 * Legs list the torso too even though a hip pivot is nearly the torso's own pivot — "nearly"
 * was 11.7-13.2px of the same gap, because a hand-placed hip is not exactly the hip midpoint.
 */
const LIMB_PARENT = {
  'arm-l': 'torso', 'arm-r': 'torso', 'head': 'torso',
  'leg-l': 'torso', 'leg-r': 'torso',
  'forearm-l': 'arm-l', 'forearm-r': 'arm-r',
  'shin-l': 'leg-l', 'shin-r': 'leg-r',
};

/*
 * WHICH ROLES READ THE DEPTH CHANNEL when the capture's stride is along the camera axis.
 *
 * A walk filmed head-on puts its whole stride into depth, where a 2D angle cannot see it.
 * Measured on brisk-walk.mp4 (head-on, 62 frames): the thighs swing 3.5deg / 4.2deg in the
 * picture plane against 52.1deg / 50.7deg in depth. The pose service says which axis actually
 * carries the stride (gait.stride_axis) after testing that the legs alternate there; this is
 * the list of roles that then follow it.
 *
 * LEGS ONLY, and that is measured too, not a hedge. Depth is a genuinely coarser estimate
 * than position, so it is only worth taking where the picture plane has nothing:
 *
 *   role     picture plane            depth plane
 *   thigh     3.5deg,  89% in band    52.1deg, 73% in band   <- depth wins, take it
 *   arm-r     6.5deg,  47% in band   140.4deg, 52% in band   <- 140deg is a near-degenerate
 *                                                               bone wrapping, not a swing
 *
 * Arm swing projects laterally from ANY viewpoint — which is why the arms measure the same
 * ~15deg head-on and side-on, while only the legs collapse — so there was never anything for
 * depth to recover in an arm. The head and torso have no stride in them at all.
 */
const LIMB_DEPTH_ROLES = new Set(['leg-l', 'leg-r', 'shin-l', 'shin-r']);

/* MediaPipe's own visibility. Below this the landmark is an inference, not an observation. */
const LIMB_VIS_OK = 0.5;

/*
 * A bone pointing at the camera projects SHORT, and its 2D angle becomes noise — at the
 * limit an arm aimed straight down the lens has no direction on screen at all. So a frame
 * is only believed while the bone still projects at least this fraction of its own median
 * length. Measured on the shipped walk (assets/motion/walk-pose.json): at 0.6 the right arm
 * and both legs keep all 132 frames, while the left arm keeps NONE — that subject is
 * side-on with the left side occluded. A limb with no usable frame holds its drawn pose;
 * see the note in _applyLimbs about why it is not mirrored from the other side.
 */
const LIMB_FORESHORTEN = 0.6;

/* Cap on one limb's swing from its rest angle. A single bad frame must not fling an arm
 * across the canvas, and no human joint travels much past this from a neutral pose.
 * It caps the MOTION only — a retarget offset (see LIMB_RETARGET_DEFAULT) is a one-off
 * rest alignment, not a swing, and capping it would just half-apply the alignment. */
const LIMB_DEG_MAX = 75;

/*
 * REST RETARGETING — whether the artwork's drawn pose or the capture's stance is the neutral.
 *
 * 'off' adds the capture's per-frame delta on top of the pose as drawn. That keeps the
 * artwork intact and is the right default for a drawing whose stance already resembles the
 * clip's, but it also keeps any stance that does NOT: measured on assets/scenes/boy-limbs.svg
 * driven by assets/motion/walk-man-extracted.json, the boy is drawn in a star jump with his
 * legs 58.3deg / 115.1deg apart (a 56.8deg splay) while the walking man's thighs rest 2.7deg
 * apart (93.1deg / 90.4deg as the rig reads them). Closing that takes +39.5deg on one leg and
 * -20deg on the other, and the walk supplies only 26.1deg / 28.6deg peak to peak, i.e. about
 * +-13deg from rest — so the feet never pass each other at any usable intensity. The crossing
 * IS in the capture (the man's ankles swap sides 6 times in 155 frames); it just cannot
 * survive being added to a splay several times its own size.
 *
 * 'all' aligns every usable limb's rest to the bone's captured rest first, then adds the
 * delta — standard retargeting. The drawing keeps its proportions and its art; it adopts the
 * subject's stance. 'legs' does the same for the leg and shin roles only, leaving arms, head
 * and torso as drawn. tests/boy_foot_cross.js, signed foot gap in screen px over 155 frames:
 *
 *   intensity   'off'                  'all'
 *   1           125..223  no crossing   -27.4..83.2  crosses 4x
 *   2           63.3..258 no crossing   -87.2..129   crosses 6x
 *   3           2.7..287  no crossing   —
 *
 * Intensity 3 is the end of the honest range: 26deg of measured swing scaled by 3 is 78deg,
 * past LIMB_DEG_MAX, so the clamp starts flattening the stride. 'off' gets within 2.7px of a
 * crossing there and still does not make one.
 *
 * A limb with no usable frame is never retargeted — its captured rest would be a fabrication,
 * so it holds its drawn pose exactly as under 'off'.
 *
 * WHY THE DEFAULT IS 'legs' AND NOT 'all'. 'all' shipped as the default for one build and broke
 * the reference boy on sight: head rotated off the neck, both arms folded across the chest with
 * nothing left at the shoulder. That is not a bug in the offset — it is what a rigid rotation of
 * flat artwork DOES once the offset gets large. There is no skinning here, and a drawn limb's
 * silhouette was authored to meet the torso at exactly ONE angle. Offsets on this pair, after
 * the mirror and the ancestor subtraction, with how far each limb's ink centroid travels because
 * of it (2*r*sin(off/2) about the pivot, screen px, swing excluded):
 *
 *   leg-l  +39.5deg   71px      arm-l  +144.9deg  126px
 *   leg-r  -20.0deg   25px      arm-r  -120.9deg  128px
 *   torso   -4.7deg    6px      head    -20.0deg   18px
 *
 * The travel is not the test — leg-l moves 71px and stays attached, because a hip sits at the
 * very top of the leg group and the shorts cover the seam. The ANGLE is the test: past roughly a
 * right angle the limb points somewhere the artist never drew a joint for, and an arm drawn
 * straight up cannot be turned 145deg about a shoulder point and still have a shoulder.
 *
 * So 'legs' is the default. It is what closes the splay and crosses the feet — measured within
 * 0.1px of 'all', because only the legs decide the foot gap — while leaving every seam the artist
 * drew alone. 'all' stays available: on a figure drawn with its arms already down the offsets are
 * small and it is nearly free. The inspector reports the largest offset a given figure would
 * take, so that choice is made on the number rather than on a promise.
 */
const LIMB_RETARGET_DEFAULT = 'legs';        // 'off' | 'legs' | 'all'
const LIMB_RETARGET_ROLES = /^(leg|shin)-/;  // what 'legs' covers

/* How finely a limb's paths are sampled to find its drawn far end (the foot, the hand).
 * Measured against a 32x denser sweep (2048/subpath) on all six of the reference boy's limbs,
 * 64 is within 0.35deg on the worst of them — and it runs once per selection, not per frame. */
const LIMB_TIP_SAMPLES = 64;

/*
 * ── BODY CHANNEL — the whole-figure motion the limb rig alone cannot carry ────────────────
 *
 * WHY THIS EXISTS. A figure driven by _applyLimbs rotates its arms and legs about their
 * joints and nothing else, so a subject who sways across the floor comes out marching on the
 * spot. That is not a shortfall of the artwork or of the detector — it is the extraction
 * deleting the channel. pose_server._normalize_clip anchors every frame at the hip midpoint
 * (it has to; the arms otherwise rescale the torso), and the anchor subtracts the subject's
 * TRANSLATION. Measured on assets/videos/dance-arms-overhead.mp4, the dancer's hip centre
 * travels 49.9% of a torso length sideways and 15.6% vertically, and in the shipped swatch
 * both of those come back as a range of 0.0000.
 *
 * So the fix is not a bigger gain on the limbs. The service now ships the anchor it used to
 * throw away as `pose.root`, and this reads it.
 *
 * FOUR CHANNELS, THREE OF WHICH WERE ALWAYS AVAILABLE. Only translation is destroyed by
 * anchoring. Tilt (shoulder to shoulder) and squash (shoulder to hip) are DIFFERENCES within
 * a single frame, so the anchor cannot touch them and they have been sitting in every pose
 * swatch on disk unread. Measured on the same clip:
 *
 *   channel          source                       measured range      as shipped
 *   sway   (x)       pose.root[i][0]              49.9% of torso      was 0.0000
 *   bob    (y)       pose.root[i][1]              15.6% of torso      was 0.0000
 *   tilt             shoulder line angle          48.3deg             present, unread
 *   squash           torso length / its median    11.6%               present, unread
 *
 * UNITS. `root` is in the same normalized box as `frames`, and _normalize_clip fits the
 * subject's whole extent into that box — so one unit is the subject's own height. Multiplying
 * by the artwork figure's bbox height maps the sway onto a figure of any size, which is why
 * the gains below are all 1.0: at gain 1 the drawing sways as far, relative to its own body,
 * as the person did. `intensity` scales this exactly as it scales a limb swing.
 */
const BODY_SWAY_GAIN = 1.0;
const BODY_BOB_GAIN = 1.0;
/* Tilt is taken at less than life because a drawn figure is one rigid silhouette: the dancer's
 * 48.3deg of shoulder roll is spread across a real spine, while here it pivots the entire body
 * as a board. Half reads as a lean; full reads as falling over. Capped as well as scaled, for
 * the same reason LIMB_DEG_MAX exists — one bad frame must not lay the figure flat. */
const BODY_TILT_GAIN = 0.5;
const BODY_TILT_MAX = 18;
/* Squash is a NON-uniform scale, so it is the channel that actually deforms rather than
 * moves. Held well under the measured 11.6% because scaling flat artwork stretches the ink
 * itself, not just its outline — past about a tenth the strokes visibly thin out. */
const BODY_SQUASH_GAIN = 0.6;
const BODY_SQUASH_MAX = 0.10;
/*
 * JUMP. The vertical channel, on its own and amplified.
 *
 * Be clear about what is and is not extracted here. The dancer in the reference clip never
 * leaves the ground — measured, 0 of 117 frames have both ankles off their floor — so her
 * "jump" is a 15.6%-of-torso bounce, which on a 250px figure is about 8px and reads as
 * nothing. This gain is AUTHORED. What comes from the video is the timing, the shape and the
 * number of hops; the height does not. Anything that reports this as extracted height is
 * lying, and the inspector labels it `jump (height x6)` for that reason.
 *
 * 3 is where the arc reads as a hop without reading as flight, on a figure whose own height
 * sets the scale — 0.0321 box units x 3 x figure height is a rise of ~10% of the figure,
 * against a real standing jump of roughly 25-30%. 6 was tried first and reported back as
 * "jumping too much": on a small object like the cap, whose whole body is 79px, a rise of 19%
 * of itself detaches it from the head it sits on, and the eye reads a launch rather than a
 * bounce. The amount an object may leave its own footprint scales with how firmly the artwork
 * plants it, not with the dancer's numbers, so this is the knob that gets tuned by looking.
 */
const BODY_JUMP_GAIN = 3.0;
/* Squash coupled to height, opposed in sign: compressed at the bottom of the arc, stretched
 * at the top. This is what actually reads as a jump — anticipation and landing carry it far
 * more than altitude does, which is why the gain above can stay as low as it is.
 *
 * Note this clamp binds, it does not merely cap: at any gain worth using, (up/h)x1.6 exceeds
 * it, so the number below IS the squash amplitude rather than a limit on it. Lowering the gain
 * therefore does nothing to the deformation, and a cap that hops half as high while still
 * stretching a sixth of its height reads as rubber. Halved alongside the gain for that reason. */
const BODY_JUMP_SQUASH = 0.04;

/* Shortest-arc normalisation to -180..180, sign preserved. */
const deg180 = (d) => ((d + 180) % 360 + 360) % 360 - 180;

/*
 * WHERE BETWEEN TWO CAPTURED FRAMES a given instant falls.
 *
 * A pose swatch holds about twelve to fifteen frames per second and no more — pose_server.py
 * decimates every clip towards 15fps before MediaPipe reads it, by a whole-frame step
 * (`round(src_fps / 15)`), so a 23.976fps source like walk-man.mp4 lands on 11.988. A display
 * paints at 60. Indexing the track with Math.floor therefore showed each captured pose for
 * four or five display frames: measured on the walk swatch at 14.5 distinct leg poses per
 * second, each held 66.7ms, while consecutive captured frames differ by as much as 11.7deg on
 * a leg. That snap is what "the motion is not smooth" was — not dropped browser frames.
 *
 * Interpolating adds no motion that was not measured. At every instant the capture actually
 * sampled, the value is still exactly the captured one; only the 66ms of nothing between two
 * samples is filled, and it is filled from the two frames that BRACKET it rather than by
 * holding the older one until the next arrives. _sampleCentreline has always done this for
 * extracted cloth (see its bilinear-in-time note); the pose paths were the outliers.
 *
 * Blending wraps from the last frame to the first. A captured clip is not cyclic, so that seam
 * carries the clip's whole net drift in one frame interval; the limb path removes the drift
 * from the track first, which is what makes the wrap continuous rather than a flick — see
 * closeLoop. The two whole-figure paths below still take the cut.
 */
const framePos = (t, fps, n) => {
  const p = (((t * fps) % n) + n) % n;   // a rewound clock (t<0) must not index -1
  const i0 = Math.floor(p);
  return { i0, i1: (i0 + 1) % n, f: p - i0 };
};
/* Blend two scalars (positions, deflections — nothing that wraps). */
const lerp = (a, b, f) => a + (b - a) * f;
/* Blend two angles in DEGREES the short way round, so a track that crosses +-180 does not
 * sweep the long arc to get to a neighbour a fraction of a degree away. */
const lerpDeg = (a, b, f) => a + deg180(b - a) * f;

/*
 * SMOOTH interpolation of an angle track — a Catmull-Rom spline through the captured samples,
 * cyclic, short-way-round.
 *
 * lerpDeg gets the value at every instant right and the VELOCITY wrong. Straight lines between
 * samples means the speed jumps at every captured frame: the curve is continuous but its
 * derivative is not, and a corner in velocity is what the eye reads as a limb that jerks
 * rather than swings. Measured on the walk-man capture driving the girl, sampled at 60Hz:
 * the second difference of the applied leg rotation peaks at 0.59deg (right) and 0.91deg
 * (left) on a mean per-frame step of 0.17deg — a velocity kink of several times the frame's
 * own motion, arriving 12 times a second.
 *
 * Catmull-Rom passes exactly THROUGH every captured sample, so this adds no measurement and
 * changes none: at each instant the capture sampled, the value is identical to what lerpDeg
 * gave. Only the tangent between samples changes, from "whatever the next sample demands" to
 * the average slope of the two neighbours, which is what makes the joins C1.
 *
 * It can overshoot the bracketing pair where the track has a sharp extremum — that is the
 * price of the smooth tangent, it is bounded by the neighbour spacing, and LIMB_DEG_MAX still
 * caps the result. Measured on the same clip, worst overshoot past the captured min/max over
 * all six limbs at 20 substeps per interval: 0.16deg, on ranges of 9-30deg. Small because a
 * pose track sampled at 12fps has no isolated spikes for the spline to round off.
 *
 * Deltas are taken relative to p1 through deg180 for the same reason lerpDeg does it.
 */
const splineDeg = (track, i0, f, n) => {
  const p1 = track[i0] || 0;
  if (n < 4) return lerpDeg(p1, track[(i0 + 1) % n] || 0, f);
  const d0 = deg180((track[(i0 - 1 + n) % n] || 0) - p1);
  const d2 = deg180((track[(i0 + 1) % n] || 0) - p1);
  const d3 = deg180((track[(i0 + 2) % n] || 0) - p1);
  const m1 = (d2 - d0) / 2, m2 = (d3 - 0) / 2;         // tangents at p1 and p2
  return p1 + f * m1
            + f * f * (3 * d2 - 2 * m1 - m2)
            + f * f * f * (m1 + m2 - 2 * d2);
};

/*
 * CLOSE THE LOOP of an angle track, in place, by removing its net drift.
 *
 * A captured clip is not cyclic, and the animation plays it round and round. Whatever the
 * track has drifted by over the clip therefore has to be undone in the single frame interval
 * where the last sample hands over to the first — an 83ms snap. Measured on walk-man.mp4
 * driving the girl, as applied rotation at 60Hz: the head jumped 37.96deg across that one
 * interval against a fastest in-loop step of 0.66deg, so the seam moved the head 58x faster
 * than anything in the walk did. That once-per-loop flick is what "she is bobbing her head"
 * was. The legs snapped 11.93 and 8.25deg at the same instant.
 *
 * The drift is an artifact, not the walk. walk-man.mp4 is filmed from BEHIND, so MediaPipe is
 * inferring a nose it cannot see on the back of a head that is getting smaller; the inferred
 * nose slides steadily sideways over the clip. Spreading its removal evenly across the track
 * takes out exactly the component that fails to repeat and leaves every oscillation that does.
 *
 * The correction is self-scaling, which is the reason to prefer it over cross-fading a window:
 * a genuinely cyclic bone already ends where it began, so there is nothing to subtract. On the
 * same clip the torso drifts 1.14deg and keeps its full 8.4deg swing, while the head drifts
 * 37.99deg and its range falls 44.94 -> 23.78deg. The head loses half its motion because half
 * of it was one-way slide.
 *
 * The line is subtracted about the track's MIDPOINT, not its start, so the mean is unchanged —
 * restDeg is a circular mean of these same angles and retargeting aims the drawing at it, so
 * shifting the mean here would tilt the limb's neutral pose by half the drift.
 */
const closeLoop = (track) => {
  const n = track.length;
  if (n < 4) return track;
  const drift = deg180(track[n - 1] - track[0]) / n;
  for (let i = 0; i < n; i++) track[i] -= drift * (i - (n - 1) / 2);
  return track;
};

/*
 * WHY A GAIT NEEDS TRIMMING BEFORE closeLoop, NOT JUST A BIGGER RAMP.
 *
 * closeLoop's note above reasons that "a genuinely cyclic bone already ends where it began,
 * so there is nothing to subtract". That holds for a bone whose drift is real one-way slide.
 * It does NOT hold for a clip cut mid-swing: a walk is perfectly cyclic and still ends far
 * from where it started, because the recording stopped part-way through a stride. The drift
 * closeLoop then measures is not slide to remove, it is phase — and subtracting it as a ramp
 * tilts the whole track.
 *
 * Measured on brisk-walk (62 frames, ~4.4 stride cycles, legs driven from depth): the legs end
 * 16.2deg from where they started, and the ramp needed to force that closed inflated the swing
 * 21.0 -> 29.3deg (+39%) and REVERSED the cadence trend. The real stride accelerates, period
 * 1.12s -> 1.00s; the ramped one decelerated, 0.83s -> 1.39s, and one of the eight half-cycles
 * disappeared. That is a walk that no longer matches the video it came from.
 *
 * So drop the shortest tail that lets the loop close on its own, and leave the small remainder
 * to closeLoop. The test is on the LEGS, whose alternation is what a stride cycle IS, and each
 * leg is judged against its OWN range so the threshold means the same thing on a 20deg swing
 * and a 50deg one. Measured: brisk-walk keeps 58/62 frames (94%, legs 20.1/18.9deg, cadence
 * still rising 1.14 -> 1.01s); the side-on clip keeps 159/160 (99%, legs 42.6/51.4deg against
 * 42.9/50.4 raw) — a clip that already looped cleanly barely moves. A rig with no usable leg
 * pair, or one where no tail qualifies, keeps every frame and behaves exactly as before.
 */
const LIMB_LOOP_SEAM = 0.15;      // seam mismatch tolerated, as a fraction of that leg's range
const LIMB_LOOP_MIN_KEEP = 0.55;  // never discard more of the clip than this to close a loop

class Animator {
  constructor(selectionManager, motionLibrary) {
    this.sel = selectionManager;
    this.motions = motionLibrary;
    this.playing = false;
    this.t0 = performance.now() / 1000;
    this._raf = null;
    this.previewWrap = null;   // set while a motion-preset drag is previewing on this wrap
  }

  play() { this.playing = true; this.t0 = performance.now() / 1000; this._tick(); }
  pause() { this.playing = false; if (this._raf) cancelAnimationFrame(this._raf); this._reset(); }
  toggle() { this.playing ? this.pause() : this.play(); return this.playing; }

  _tick() {
    if (!this.playing) return;
    this._raf = requestAnimationFrame(() => this._tick());
    const t = performance.now() / 1000 - this.t0;
    this._applyAll(t);
    this.sel.syncHighlights();
  }

  _applyAll(t) {
    for (const s of this.sel.selections) {
      if (!s.motionId && !s.route) continue;
      if (this.previewWrap && s.wrap === this.previewWrap) continue;   // a drag preview owns this wrap's transform right now
      const motion = s.motionId ? this.motions.getById(s.motionId) : null;
      if (!motion && !s.route) continue;

      // One selection's special-case animator throwing (bad/unexpected
      // geometry, a missing child element, etc.) used to kill this whole
      // per-frame loop silently — every OTHER animating object on the canvas
      // would freeze too, forever, with no visible error. Isolate failures
      // per-object instead.
      let ran = false;
      if (motion) {
        try {
          this._applyOne(s, motion, t);
          ran = true;
        } catch (err) {
          console.error(`Motion "${motion.name}" on "${s.name}" failed to animate:`, err);
          s.motionId = null;   // stop retrying every frame; object goes static, not the whole scene
        }
      }
      // Travel is a SEPARATE channel from deformation, so the two compose instead of one
      // replacing the other: the applicator rewrote each path's own `d`, and the route now
      // carries the whole deforming group along. The base transform is captured here,
      // right after the applicator wrote it, rather than read back inside _applyRoute —
      // otherwise a route on an object with no motion would prepend to its own offset from
      // last frame and march off the canvas.
      if (s.route) {
        try {
          this._applyRoute(s, ran ? (s.wrap.getAttribute('transform') || '') : '', t * (s.speed || 1));
        } catch (err) {
          console.error(`Travel route on "${s.name}" failed to animate:`, err);
          s.route = null;
        }
      }
    }
  }

  /*
   * AUTHORED travel along a route drawn on the canvas.
   *
   * Deliberately NOT _applyPathTravel. That one plays back an EXTRACTED path and so
   * refuses to ease or reshape what the video measured, ping-ponging because every
   * position it shows has to be a real sample. A route is the opposite: every point in it
   * was placed by hand, so there is no measurement to protect and easing is honest — it is
   * authored either way. Anything that reads a route must treat it as authored, never as
   * extracted, which is why route.authored is set at creation and carried through.
   *
   * The route lives on the SELECTION, not on the motion swatch. A swatch is meant to be
   * reusable on any artwork; "fly from her hand out over the lake" only means anything in
   * this one scene.
   *
   * Intensity deliberately does not scale travel: the object goes where the route was
   * drawn. Intensity still scales the flutter riding on top of it.
   */
  _applyRoute(s, base, t) {
    const tbl = this._routeTable(s);
    if (!tbl) return;
    const dur = Math.max(0.1, s.route.duration || ROUTE_SECONDS);
    /*
     * The journey is timed from when this route STARTED, not from the global clock. You
     * draw a route while the scene is already playing — that is the only way to watch the
     * motion you are adding to — so the clock is already several seconds in by the time
     * the route commits. Reading it directly dropped the object at whatever phase the loop
     * happened to be at: committed 2.9s in it appeared 198px along a 243px route, and past
     * the halfway point it set off BACKWARDS, which reads as the motion starting from the
     * end. Rewinding (t going backwards, i.e. pause then play) re-arms the origin, so every
     * play begins at the start of the route.
     */
    if (s._routeT0 == null || s._routeT0Rev !== s.route.rev || t < s._routeT0) {
      s._routeT0 = t;
      s._routeT0Rev = s.route.rev;
    }
    /*
     * ONE-SHOT (default): travel the route once and hold at the end point — no ping-pong
     * back to the start — eased in and out, because a journey with a start and a finish
     * should not begin or end at full speed.
     *
     * LOOPING (route.loop, set by the Loop travel button): wrap round and go again, at a
     * CONSTANT speed. The ease exists to soften a single arrival; on a loop there is no
     * arrival to soften, and smoothstep would decelerate to a standstill at every lap seam
     * and then pull away again — a visible hitch once per cycle that the drawn route never
     * asked for. Linear also makes a CLOSED route (drawn back to its own first point) truly
     * seamless. An open route still cuts back to the start each lap; that is inherent to
     * looping a path that ends somewhere else, so the inspector measures the gap and says so
     * rather than pretending the jump is not there.
     */
    const raw = (t - s._routeT0) / dur;
    const loop = !!s.route.loop;
    const p = loop ? raw - Math.floor(raw) : Math.min(1, raw);
    const f = loop ? p : p * p * (3 - 2 * p);         // constant speed on a loop, else smoothstep
    const [x, y] = this._routeAt(tbl, f);
    const dx = x - tbl.x0, dy = y - tbl.y0;          // the first point is wherever the object already is
    s.wrap.setAttribute('transform',
      `translate(${dx.toFixed(2)} ${dy.toFixed(2)})${base ? ' ' + base : ''}`);
  }

  /* Resample the drawn route by ARC LENGTH. Clicks land wherever the hand put them, so
     parametrizing by point index would sprint across the sparse stretches and crawl
     through the dense ones; travel should be at a steady speed instead. Rebuilt only when
     the route's revision changes. */
  _routeTable(s) {
    const r = s.route;
    if (!r || !r.pts || r.pts.length < 2) return null;
    if (s._routeTbl && s._routeTbl.rev === r.rev) return s._routeTbl.total > 0.5 ? s._routeTbl : null;
    const cum = [0];
    for (let i = 1; i < r.pts.length; i++) {
      cum.push(cum[i - 1] + Math.hypot(r.pts[i][0] - r.pts[i - 1][0], r.pts[i][1] - r.pts[i - 1][1]));
    }
    s._routeTbl = { rev: r.rev, pts: r.pts, cum, total: cum[cum.length - 1],
                    x0: r.pts[0][0], y0: r.pts[0][1] };
    return s._routeTbl.total > 0.5 ? s._routeTbl : null;
  }

  _routeAt(tbl, f) {
    const target = Math.min(Math.max(f, 0), 1) * tbl.total;
    let lo = 1, hi = tbl.cum.length - 1;
    while (lo < hi) {                                // first vertex at or past this arc length
      const mid = (lo + hi) >> 1;
      if (tbl.cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    const seg = tbl.cum[lo] - tbl.cum[lo - 1] || 1;
    const q = (target - tbl.cum[lo - 1]) / seg;
    const a = tbl.pts[lo - 1], b = tbl.pts[lo];
    return [a[0] + (b[0] - a[0]) * q, a[1] + (b[1] - a[1]) * q];
  }

  _applyOne(s, motion, t) {
    const speed = s.speed || 1, intensity = s.intensity || 1;
    const rt = t * speed;
    const seed = s.kind === 'svg'
      ? (s.center[0] * 0.01 + s.center[1] * 0.03)
      : (s.bounds.x * 0.01 + s.bounds.y * 0.03);

    // ---- limb articulation: a pose swatch rotates each tagged limb about its joint ----
    // First of the pose branches, because data-limb is the most specific tag of the three
    // and a limb-rigged figure usually also carries a [data-role="body"] torso that would
    // otherwise send it to _applyCharacter, which cannot drive arbitrary paths.
    if (s.kind === 'svg' && this._poseFor(motion) && s.wrap.querySelector('[data-limb]')) {
      this._applyLimbs(s, motion, rt, intensity);
      return;
    }

    // ---- wing flap: the same pose swatch drives a tagged wing pair ----
    // Checked BEFORE the character gate: wing tags are more specific than
    // [data-role="body"], and a bird has no legs for the human rig to drive.
    if (s.kind === 'svg' && this._poseFor(motion) &&
        s.wrap.querySelector('[data-role="wing-l"], [data-role="wing-r"]')) {
      this._applyWings(s, motion, rt, intensity);
      return;
    }

    // ---- character / skeletal motion: a pose-sequence swatch drives a rig ----
    if (s.kind === 'svg' && this._poseFor(motion) &&
        s.wrap.querySelector('[data-motion-mode="character"], [data-role="body"]')) {
      this._applyCharacter(s, motion, rt, intensity);
      return;
    }

    // Keep dense canopy artwork intact; only sway its selectable overlay.
    if (s.kind === 'svg' && s.wrap.querySelector('[data-motion-role="tree-canopy"]')) {
      this._applyTreeLeaves(s, motion, rt, intensity);
      return;
    }

    // ---- REAL extracted travel path (Step 5) — beats the curated behaviours ----
    // motion.path exists ONLY when the service actually tracked one object across
    // the clip (?path=1 -> yolo_bytetrack -> objpath.build_path). Measured motion is
    // the point of this tool, so it takes precedence over the name-keyed curation
    // below, which stays as the fallback for presets and untracked clips.
    if (s.kind === 'svg' && this._pathFor(motion)) {
      this._applyPathTravel(s, motion, rt, intensity);
      return;
    }

    // ---- (Step 8) CLASS-KEYED APPLICATION ----
    // The applicator is chosen by what the motion IS, never by what the layer is
    // CALLED: rename "Birds" to "Layer 7" and a flock swatch still drifts it as a
    // flock; drop a cloth swatch on that same group and it ripples instead.
    // _applicatorFor returns '' only for a motion nothing classified (the built-in
    // presets, and the in-browser Lucas-Kanade fallback) — and only then do the
    // name-keyed curated behaviours below get a turn.
    const app = this._applicatorFor(motion);
    if (s.kind === 'svg' && app && this._applyByClass(s, motion, app, rt, intensity)) return;

    // ---- realistic falling leaves: each child leaf falls independently ----
    if (s.kind === 'svg' && motion.params && motion.params.leafFall) {
      this._applyLeafFall(s, motion, rt, intensity);
      return;
    }

    // ---- curated scenery behaviours, keyed on the object's NAME ----
    // FALLBACK ONLY (Step 8): these run for the built-in presets, which carry no
    // class and no captured field, so there is nothing real to prefer over them.
    // A classified swatch never reaches here — real extracted motion always wins,
    // even when the curated version would look nicer.
    if (s.kind === 'svg' && !app) {
      if (/\bbirds?\b/i.test(s.name)) { this._applyBirds(s, motion, rt, intensity); return; }
      if (/\bclouds?\b/i.test(s.name)) { this._applyClouds(s, motion, rt, intensity); return; }
      if (/\briver|ripples?\b/i.test(s.name)) { this._applyRiver(s, motion, rt, intensity); return; }
      if (/\bboat|rowboat|canoe|ferry|ship\b/i.test(s.name)) {
        this._applyBoat(s, motion, rt, intensity); return;
      }
    }

    // ---- per-glyph text animation: letters ride the motion individually ----
    if (s.kind === 'svg' && s.wrap.querySelector('text')) {
      if (s._text === undefined) s._text = buildTextData(s.wrap);
      if (s._text) {
        if (s._field === undefined || s._fieldMotion !== motion.id) {
          s._field = buildTrajField(motion) || null;
          s._fieldMotion = motion.id;
        }
        for (const it of s._text.items) {
          it.el.setAttribute('transform',
            glyphTransform(s._text, it, s._field, motion.params, rt, intensity));
        }
        s.wrap.setAttribute('transform', '');
        return;
      }
    }

    // ---- wave (cloth) mode: deform the geometry itself ----
    // Same applicator the `cloth` class dispatches to. Reached when the artwork is
    // deformable but the motion carries no class (a preset, or a pre-Step-7 swatch).
    if (s.kind === 'svg' && s.waveMode && this._applyCloth(s, motion, rt, intensity)) return;

    const { dx, dy, rot } = computeMotion(motion.params, seed, rt, intensity);

    if (s.kind === 'svg') {
      // rotate around the element's own center for a natural sway
      const [cx, cy] = s.center;
      s.wrap.setAttribute('transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(3)} ${cx.toFixed(1)} ${cy.toFixed(1)})`);
    } else if (s.floatEl) {
      // raster: dx/dy are in viewBox(=displayed px) units; convert to displayed px
      const rect = this.sel.overlay.getBoundingClientRect();
      const pxX = dx * rect.width / this.sel.overlay.width;
      const pxY = dy * rect.height / this.sel.overlay.height;
      s.floatEl.style.transform =
        `translate(${pxX.toFixed(2)}px, ${pxY.toFixed(2)}px) rotate(${rot.toFixed(3)}deg)`;
      s.floatEl.style.transformOrigin = 'center center';
    }
  }

  // deterministic pseudo-random in [0,1) from a leaf index + channel
  _leafRnd(i, k) { const x = Math.sin(i * 12.9898 + k * 78.233) * 43758.5453; return x - Math.floor(x); }

  /*
   * (Step 8) Which applicator drives this motion — '' when nothing classified it.
   *
   * The swatch's own `applicator` is preferred because the service already resolved
   * (kind, class) there: a rigid_path clip emits a `path` swatch AND a `texture` one,
   * and only the first can drive path_travel. Swatches are ordered primary-first, so
   * the first one that was actually classified wins.
   *
   * A swatch with an EMPTY class is skipped deliberately. contracts.swatch_applicator
   * still fills in a payload-appropriate default for it ('oscillate' for a texture),
   * but that is a shape fallback, not a classification — treating it as one would
   * silently retire the presets' curated behaviour on the strength of a guess.
   */
  _applicatorFor(motion) {
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.class && sw.applicator) return sw.applicator;
    }
    return APPLICATOR_BY_CLASS[motion.class] || '';
  }

  /*
   * The class the applicator above was chosen from — same swatch-first precedence, so
   * the two can never disagree about which motion this is. js/judge.js (Step 9) sends
   * it to the judge, which needs to be told what it is supposed to be looking at.
   */
  _classOf(motion) {
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.class && sw.applicator) return sw.class;
    }
    return motion.class || '';
  }

  /*
   * The captured pose sequence, from wherever it lives. `motion.pose` is the frozen
   * shape the library has always stored; a Step-7 skeleton swatch nests the same
   * {joints, fps, frames} under `.pose`, so a swatch-only motion drives the rig too
   * (buildTrajField() reads a texture swatch the same way).
   */
  _poseFor(motion) {
    if (motion.pose && motion.pose.frames && motion.pose.frames.length) return motion.pose;
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.kind === 'skeleton' && sw.pose && sw.pose.frames && sw.pose.frames.length) {
        return sw.pose;
      }
    }
    return null;
  }

  /*
   * The extracted cloth CENTRELINE, if this motion carries one (tools/extract_cloth_flutter.py).
   *
   * `frames[i][j]` is the cloth's transverse deflection at station u[j] on frame i,
   * in units of the cloth's own anchor->tip LENGTH — dimensionless, so the same
   * measured sweep transfers onto a ribbon of any size. Rides at the top level next
   * to `pose`/`path` rather than in `swatches` because a centreline is not one of
   * contracts.SWATCH_KINDS; see the note in the extractor.
   */
  _centrelineFor(motion) {
    const cl = motion && motion.centreline;
    return (cl && cl.frames && cl.frames.length && cl.u && cl.u.length > 1) ? cl : null;
  }

  /* Same for the travel path: `motion.path` or a Step-7 `path` swatch's `.path`. A path
     needs at least two points to be a path at all, which is also the check that keeps an
     untracked rigid_path clip out of path_travel. */
  _pathFor(motion) {
    const ok = p => p && p.points && p.points.length > 1 ? p : null;
    if (ok(motion.path)) return motion.path;
    for (const sw of (motion.swatches || [])) {
      if (sw && sw.kind === 'path' && ok(sw.path)) return sw.path;
    }
    return null;
  }

  /*
   * Run the applicator the class asked for. Returns false when it CANNOT run on this
   * artwork — a flock needs several children, cloth needs deformable geometry — and
   * the caller then falls through rather than pretending the motion was applied.
   */
  _applyByClass(s, motion, app, t, intensity) {
    switch (app) {
      case 'skeletal':
        // the rig + wing checks run earlier in _applyAll (they need the pose payload
        // too); reaching here means this artwork carries neither a character rig nor a
        // tagged wing pair, so there is nothing for the captured joints to drive
        return false;
      case 'wave':
        return this._applyCloth(s, motion, t, intensity);
      case 'flow_field':
        return this._applyFluid(s, motion, t, intensity);
      case 'flock_drift':
        return this._applyFlock(s, motion, t, intensity);
      case 'path_travel':
        // a motion WITH points was already handled above; a rigid_path swatch whose
        // tracker found nothing has no travel to apply, so let the default sway run
        return false;
      case 'oscillate':
      default:
        return false;    // the parametric tail of _applyAll IS the oscillate applicator
    }
  }

  /* Captured trajectory field for this motion, cached per selection. */
  _fieldFor(s, motion) {
    if (s._field === undefined || s._fieldMotion !== motion.id) {
      s._field = buildTrajField(motion) || null;
      s._fieldMotion = motion.id;
    }
    return s._field;
  }

  /*
   * cloth → `wave`. A soft sheet rippling while anchored at one edge.
   *
   * Driven by the REAL captured field through the rigid MLS mesh warp
   * (motionfields.js): the field is read at a coarse lattice and every path point is
   * mapped by a smooth blend of those control displacements, so the deformation is
   * continuous and neighbouring geometry cannot separate.
   *
   * That is what let the `/flag|banner|pennant|ensign|standard/` regex go. It existed
   * because the old per-point fieldD() displaced each sample INDEPENDENTLY, mangling
   * clean stripes (measured on flag.mp4: 27% median local shape distortion, 153% worst
   * case), so flag-like names had to opt out of real motion and use a synthetic sine.
   * The warp cuts that ~3x (9% median, 68% worst), which is what makes captured motion
   * usable on a flag — no name needed, and no synthetic stand-in. It is a reduction,
   * not an elimination: see the measurements above buildMeshWarp.
   *
   * anchor 'x0' pins the leading edge and ramps displacement across the width (the
   * pole end holds, the free edge whips), matching the synthetic wave's ramp so the
   * two agree on where a sheet is held. The synthetic sine remains for motions with
   * no field at all — the presets.
   */
  /* True when the selection is a multi-fill garment that must deform as one coherent
     sheet (skirt/dress), false for a flag-like cloth with a few big paths + an emblem.
     Opt in explicitly with data-cloth="coherent" on the group; otherwise inferred from
     path count (a garment is dozens of stacked fills; a flag is a handful). */
  _clothCoherent(s) {
    const w = s.wrap;
    if (!w || !w.querySelectorAll) return false;
    if ((w.getAttribute && w.getAttribute('data-cloth') === 'coherent') ||
        w.querySelector('[data-cloth="coherent"]')) return true;
    return w.querySelectorAll('path').length > 14;
  }

  /* Elegant, curated SKIRT sway. Applying a captured flag/flutter field to a skirt looks
     wrong — a flag whips from a side pole, a skirt pivots from the WAIST with the hem
     swinging. This ignores the captured field and drives a smooth waist-pinned pendulum:
     every point is displaced by a continuous function of its position, so coincident points
     move identically and the fabric can never tear into gaps. Speed/Intensity still apply
     (t is already scaled by Speed; intensity scales the swing). Opt in with data-cloth="skirt". */
  _applySkirt(s, motion, t, intensity) {
    // Cache the path elements + their pristine geometry + the group box ONCE. We warp the
    // paths' own coordinates (warpPathD) rather than resampling to polylines, so béziers
    // stay smooth and stacked shapes that share edges can never split into slivers.
    if (!s._skirt || s._skirtMotion !== motion.id) {
      const els = [...s.wrap.querySelectorAll('path')].filter(el => {
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); if (!d0) return false; el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        return true;
      });
      let bb; try { bb = s.wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._skirt = { els: els.map(el => ({ el, d0: el.getAttribute('data-ms-d0') })),
                   minY: bb.y, H: Math.max(1, bb.height), W: Math.max(1, bb.width) };
      s._skirtMotion = motion.id;
    }
    const c = s._skirt;
    const p = motion.params || {};
    const f = 0.42 + 0.20 * Math.min(1, Math.max(0, p.frequency || 0.5));   // calm, skirt-like
    const w = 2 * Math.PI * f;
    const A = c.W * 0.17 * intensity;                                        // hem swing amplitude
    const s1 = Math.sin(w * t), lift = A * 0.16 * (1 - Math.cos(w * t)) * 0.5;
    // continuous displacement of a point by its VERTICAL position: waist (top) pinned,
    // swing grows toward the hem. A pure function of (x,y) -> shared points move together.
    const disp = (x, y) => {
      const v = Math.max(0, Math.min(1, (y - c.minY) / c.H));
      const taper = Math.pow(v, 1.4);
      const dx = A * taper * (s1 + 0.22 * Math.sin(1.7 * w * t - v * 3.0));
      const dy = lift * (v * v);
      return [x + dx, y + dy];
    };
    for (const o of c.els) o.el.setAttribute('d', warpPathD(o.d0, disp));
    s.wrap.setAttribute('transform', '');
    return true;
  }

  /* Cache every <path> in the selection + its pristine geometry (data-ms-d0) and the group
     box, ONCE per (motion, mode). Shared by the coordinate-warp deformers below. Rebuilt
     when the key changes; geometry is restored on reset via the same data-ms-d0. */
  _deformCache(s, key) {
    if (!s._warp || s._warp.key !== key) {
      const els = [];
      for (const el of s.wrap.querySelectorAll('path')) {
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); if (!d0) continue; el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        els.push({ el, d0 });
      }
      let bb; try { bb = s.wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._warp = { key, els, box: {
        minX: bb.x, minY: bb.y, maxX: bb.x + bb.width, maxY: bb.y + bb.height,
        width: Math.max(1, bb.width), height: Math.max(1, bb.height) } };
    }
    return s._warp;
  }

  /* Warp every cached path's OWN coordinates (anchors + bézier control points) through a
     continuous displacement `disp(x,y)->[x2,y2]`. Because disp is a pure function of
     position, béziers stay smooth and any point shared by two paths maps identically —
     so stacked, curved artwork deforms without faceting or tearing into gaps. */
  _deformApply(s, disp) {
    for (const o of s._warp.els) o.el.setAttribute('d', warpPathD(o.d0, disp));
    s.wrap.setAttribute('transform', '');
  }

  /*
   * The cloth's own long axis, by PCA over its pristine geometry. Cached per motion.
   *
   * Why the axis and not the bounding box: the synthetic branch below displaces dy as a
   * function of GLOBAL X. That is only correct for cloth lying along x. A scarf drawn at
   * -23 degrees has its two long edges at different x for the same point across the
   * ribbon, so they receive different dy and the ribbon's THICKNESS collapses — measured
   * on Scene3's #Scarf, that is the necking and the splayed fringe. Fitting the axis and
   * displacing PERPENDICULAR to it makes the displacement a function of position ALONG
   * the cloth only, so every point across the thickness moves together.
   *
   * Returns { cos, sin, mx, my, sMin, len } or null. The axis is oriented so that S
   * increases with x, which puts u=0 on the smaller-x end — the same end the existing
   * mesh branch anchors with 'x0' (a flag's pole, and the scarf's knot at the girl's
   * hand). For cloth already lying along x, cos=1/sin=0 and this reduces to the
   * bounding-box behaviour it replaces.
   */
  _ribbonAxis(s, c, key) {
    if (s._ribbon && s._ribbon.key === key) return s._ribbon.axis;
    let n = 0, sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0;
    const pts = [];
    for (const o of c.els) {
      let L = 0;
      try { L = o.el.getTotalLength(); } catch (_) { continue; }
      if (!(L > 0)) continue;
      const k = Math.min(24, Math.max(2, Math.round(L / 4)));   // ~4px apart, capped
      for (let i = 0; i <= k; i++) {
        let p; try { p = o.el.getPointAtLength(L * i / k); } catch (_) { break; }
        pts.push(p.x, p.y); n++; sx += p.x; sy += p.y;
      }
    }
    if (n < 8) { s._ribbon = { key, axis: null }; return null; }
    const mx = sx / n, my = sy / n;
    for (let i = 0; i < pts.length; i += 2) {
      const dx = pts[i] - mx, dy = pts[i + 1] - my;
      sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
    }
    // principal eigenvector of the 2x2 covariance
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let cos = Math.cos(th), sin = Math.sin(th);
    if (cos < 0) { cos = -cos; sin = -sin; }         // orient so S grows with x
    let sMin = Infinity, sMax = -Infinity;
    for (let i = 0; i < pts.length; i += 2) {
      const S = (pts[i] - mx) * cos + (pts[i + 1] - my) * sin;
      if (S < sMin) sMin = S;
      if (S > sMax) sMax = S;
    }
    let half = 0;                                    // how far the cloth reaches across
    for (let i = 0; i < pts.length; i += 2) {
      half = Math.max(half, Math.abs(-(pts[i] - mx) * sin + (pts[i + 1] - my) * cos));
    }
    const len = sMax - sMin;
    const axis = len > 1 ? { cos, sin, mx, my, sMin, len, half } : null;
    s._ribbon = { key, axis };
    return axis;
  }

  /*
   * Sample an extracted centreline at (u, t): bilinear in station and in time.
   *
   * Time wraps around the end of the clip because the extractor reports the wrap seam
   * and this swatch's is 0.41 of a normal frame step — below the per-frame noise, so
   * looping it is smoother than any crossfade would be.
   */
  _sampleCentreline(cl, u, t) {
    const F = cl.frames, nf = F.length, ns = cl.u.length;
    const fp = (t * (cl.fps || 24)) % nf;
    const f0 = Math.floor(fp), ft = fp - f0;
    const a = F[((f0 % nf) + nf) % nf], b = F[((f0 + 1) % nf + nf) % nf];
    const sp = Math.min(ns - 1, Math.max(0, u)) * (ns - 1);
    const s0 = Math.min(ns - 2, Math.floor(sp)), st = sp - s0;
    const v0 = a[s0] + (a[s0 + 1] - a[s0]) * st;
    const v1 = b[s0] + (b[s0 + 1] - b[s0]) * st;
    return v0 + (v1 - v0) * ft;
  }

  /*
   * Build the deformed centreline for one instant, with a cumulative arc length and a
   * unit tangent at every sample.
   *
   * Why arc length: displacing every point perpendicular to a FIXED axis by an amount
   * that varies along the axis stretches the cloth. The stretch is the centreline's
   * slope — measured on this swatch it reaches 1.838 at frame 74, which shears a segment
   * lying along the axis by 109% and tears the artwork visibly. Cloth is inextensible,
   * so the material coordinate has to be arc length along the DEFORMED curve, not
   * distance along the rest axis. A consequence is that the free end pulls back toward
   * the anchor as the cloth waves, which is what a real flag does.
   *
   * A thick ribbon also cannot bend tighter than its own half-width: offsetting by the
   * normal scales length along the curve by (1 - k*n), so it inverts once |k*n| reaches 1.
   * On this scarf the raw centreline bends to an 11.6px radius while the cloth is 31.6px
   * thick, past that limit on 12 of the 96 frames. Clamping each point's offset instead
   * was measured and is WRONG — neighbouring points then get different offsets and shear
   * across the thickness, which made the worst case worse the harder it clamped (126%
   * unclamped -> 676% at 0.4). So the limit is applied ONCE PER FRAME to the whole
   * centreline's amplitude, which keeps the map smooth: the deepest folds simply do not
   * go as deep as the video's, because this ribbon is too thick to take them.
   *
   * Coordinates here are the ribbon's own frame: first component along the axis measured
   * from the anchor, second across the ribbon.
   */
  _ribbonBend(cl, t, len, intensity, half, M = 64) {
    const px = new Float64Array(M + 1), py = new Float64Array(M + 1);
    const tx = new Float64Array(M + 1), ty = new Float64Array(M + 1);
    const kv = new Float64Array(M + 1), cum = new Float64Array(M + 1);
    const d = new Float64Array(M + 1), h = len / M;
    for (let i = 0; i <= M; i++) {
      px[i] = i * h;
      d[i] = this._sampleCentreline(cl, i / M, t) * len;
    }

    // Two passes: measure the curvature the full-amplitude fold would need, then rebuild
    // at the amplitude this ribbon can actually take. Curvature is very nearly linear in
    // amplitude at these slopes, so one correction lands within a few percent.
    let scale = intensity;
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i <= M; i++) py[i] = d[i] * scale;
      let kMax = 0;
      for (let i = 0; i <= M; i++) {
        // Unit tangent and SIGNED curvature. Both difference stencils must be scaled by
        // the same step h — a 2h-wide central difference against an h^2 second difference
        // underestimates the curvature 4x.
        const a = Math.max(0, i - 1), b = Math.min(M, i + 1), span = (b - a) * h;
        const d1x = (px[b] - px[a]) / span, d1y = (py[b] - py[a]) / span;
        const q = Math.hypot(d1x, d1y) || 1;
        tx[i] = d1x / q; ty[i] = d1y / q;
        const j = Math.min(M - 1, Math.max(1, i));   // second difference needs both sides
        const d2y = (py[j + 1] - 2 * py[j] + py[j - 1]) / (h * h);
        kv[i] = (d1x * d2y) / Math.pow(q, 3);        // px is linear in i, so d2x === 0
        kMax = Math.max(kMax, Math.abs(kv[i]));
      }
      const load = kMax * half;
      if (pass || !(load > RIBBON_KN_MAX)) break;   // already within what the cloth allows
      scale *= RIBBON_KN_MAX / load;
    }

    for (let i = 1; i <= M; i++) {
      cum[i] = cum[i - 1] + Math.hypot(px[i] - px[i - 1], py[i] - py[i - 1]);
    }
    return { px, py, tx, ty, kv, cum, M, total: cum[M] };
  }

  /*
   * Place a material point of the ribbon on the deformed curve.
   *
   * `sRest` is the point's rest distance from the anchor, which IS its arc length along
   * the cloth; `n` is its offset across the ribbon. The offset rides on the curve's own
   * normal, so the thickness turns with the cloth through a fold instead of staying
   * axis-aligned and collapsing. With a flat centreline this reduces to the identity.
   */
  _ribbonMap(bend, sRest, n) {
    /*
     * Off the ends, continue straight along the end tangent rather than clamping onto the
     * curve. Bezier control points are not required to lie within the outline they draw,
     * so some of them sit past the fitted axis span; clamping collapsed those pairs onto
     * one point, which measured as a constant 61% distortion on every frame — constant
     * because the anchored end of a cantilever barely moves, so it was clearly a bug in
     * the mapping and not anything in the motion.
     */
    if (sRest < 0 || sRest > bend.total) {
      const i = sRest < 0 ? 0 : bend.M, d = sRest < 0 ? sRest : sRest - bend.total;
      const ux = bend.tx[i], uy = bend.ty[i];
      return [bend.px[i] + ux * d - uy * n, bend.py[i] + uy * d + ux * n];
    }
    const target = sRest;
    let lo = 1, hi = bend.M;
    while (lo < hi) {                                // first sample whose arc length >= target
      const mid = (lo + hi) >> 1;
      if (bend.cum[mid] < target) lo = mid + 1; else hi = mid;
    }
    const i = lo, seg = bend.cum[i] - bend.cum[i - 1] || 1;
    const f = (target - bend.cum[i - 1]) / seg;
    const x = bend.px[i - 1] + (bend.px[i] - bend.px[i - 1]) * f;
    const y = bend.py[i - 1] + (bend.py[i] - bend.py[i - 1]) * f;
    let ux = bend.tx[i - 1] + (bend.tx[i] - bend.tx[i - 1]) * f;
    let uy = bend.ty[i - 1] + (bend.ty[i] - bend.ty[i - 1]) * f;
    const m = Math.hypot(ux, uy) || 1; ux /= m; uy /= m;
    return [x - uy * n, y + ux * n];                 // normal of (ux, uy) is (-uy, ux)
  }

  _applyCloth(s, motion, t, intensity) {
    // a skirt/dress rigged for the curated waist-pinned sway takes that path instead
    if (s.wrap.querySelector && s.wrap.querySelector('[data-cloth="skirt"]')) {
      return this._applySkirt(s, motion, t, intensity);
    }
    const c = this._deformCache(s, motion.id + ':cloth');
    if (!c.els.length) return false;                 // nothing deformable
    const box = c.box, width = box.width;

    /*
     * An extracted centreline wins over both branches below: it IS the measured cloth,
     * where the mesh warp is a captured flow field and the fallback is a synthetic sine.
     * Deflection arrives in units of the cloth's own length, so it scales to this
     * artwork by multiplying by the fitted axis length.
     */
    const cl = this._centrelineFor(motion);
    if (cl) {
      const ax = this._ribbonAxis(s, c, motion.id + ':cloth');
      if (ax) {
        const { cos, sin, mx, my, sMin, len } = ax;
        const bend = this._ribbonBend(cl, t, len, intensity, ax.half);
        this._deformApply(s, (x, y) => {
          const dx = x - mx, dy = y - my;
          const S = dx * cos + dy * sin, N = -dx * sin + dy * cos;
          const [a, b] = this._ribbonMap(bend, S - sMin, N);
          return [mx + (sMin + a) * cos - b * sin, my + (sMin + a) * sin + b * cos];
        });
        return true;
      }
    }

    const field = this._fieldFor(s, motion);

    if (field) {
      // ONE shared MLS warp, anchored at the left edge (a flag pinned to its pole),
      // applied to every path's own coordinates — curves + shared edges preserved.
      if (!s._mesh || s._meshMotion !== motion.id || s._meshAnchor !== 'x0') {
        s._mesh = buildMeshWarp(field, box, { anchor: 'x0' });
        s._meshMotion = motion.id;
        s._meshAnchor = 'x0';
      }
      if (s._mesh) {
        const warp = s._mesh;
        this._deformApply(s, (x, y) => { const q = warp(x, y, t, intensity); return [q.x, q.y]; });
        return true;
      }
    }

    // no captured field (preset) → synthetic traveling sine (same math as waveD)
    const p = motion.params;
    const A = WAVE_AMP_PX * (0.35 + p.amplitude) * intensity;
    const k = 2 * Math.PI * WAVE_CYCLES * (0.5 + p.phaseSpread) / width;
    const phase = 2 * Math.PI * p.frequency * t;
    const turb = p.turbulence * 4 * intensity;
    this._deformApply(s, (x, y) => {
      // Clamp before the fractional power: Bezier control points are not required to lie
      // inside the outline they draw, so x can fall left of box.minX, and Math.pow() of a
      // negative base with a fractional exponent is NaN. That put a literal "NaN" into one
      // of Scene3's 44 scarf paths on every frame, so it silently failed to render.
      const ramp = Math.pow(Math.max(0, (x - box.minX) / width), 1.15);
      const arg = phase - k * (x - box.minX);
      const dy = A * ramp * Math.sin(arg) + A * 0.32 * ramp * Math.sin(arg * 2.0 + 1.3)
               + turb * ramp * _noise(x * 0.11 + phase * 1.3);
      const dx = A * 0.22 * ramp * Math.cos(arg);
      return [x + dx, y + dy];
    });
    return true;
  }

  /*
   * fluid → `flow_field`. A continuous medium: water, smoke, steam, fire.
   *
   * Same mesh warp as cloth but anchor 'none' — a river surface is pinned to nothing,
   * so the whole lattice is free and the sheet flows rather than whipping from an
   * edge. With no captured field it falls back to _applyRiver's synthetic laminar
   * wave, which is what the Water Ripple preset has always used.
   */
  _applyFluid(s, motion, t, intensity) {
    const field = this._fieldFor(s, motion);
    if (!field) {
      // no captured field → synthetic laminar wave (river). Non-path art has no outline
      // to flow; return false so the default sway runs, exactly as before.
      if (!s.wrap.querySelector('path')) return false;
      this._applyRiver(s, motion, t, intensity);
      return true;
    }
    const c = this._deformCache(s, motion.id + ':fluid');
    if (!c.els.length) return false;
    // same mesh warp as cloth but anchor 'none' — a fluid surface is pinned to nothing.
    if (!s._mesh || s._meshMotion !== motion.id || s._meshAnchor !== 'none') {
      s._mesh = buildMeshWarp(field, c.box, { anchor: 'none' });
      s._meshMotion = motion.id;
      s._meshAnchor = 'none';
    }
    if (!s._mesh) return false;
    const warp = s._mesh;
    this._deformApply(s, (x, y) => { const q = warp(x, y, t, intensity); return [q.x, q.y]; });
    return true;
  }

  /*
   * flock → `flock_drift`. Many similar things drifting together: birds, leaves,
   * fish, a crowd. Each CHILD element moves on its own so the group spreads and
   * desynchronizes instead of sliding as one rigid block.
   *
   * Everything directional comes from the captured params — `direction` sets the
   * common heading (degrees, screen y-down as in computeMotion), `driftX/driftY` add
   * the measured steady travel, `frequency` the wobble rate, `turbulence` how much
   * each member wanders off the common heading. Nothing here knows what a bird is;
   * _applyBirds keeps the wingbeat curation for the presets.
   *
   * Travel is bounded per member by ITS OWN on-canvas room and eased out-and-back
   * ((1-cos)/2 never changes sign), so a member drifts along the heading and returns
   * without any of them leaving the artwork or reversing into the flock.
   */
  _applyFlock(s, motion, t, intensity) {
    const wrap = s.wrap;
    const p = motion.params || {};
    if (!s._flock || s._flockMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      if (kids.length < 2) return false;            // one path is not a flock
      const svg = wrap.ownerSVGElement;
      const vb = (svg && svg.viewBox && svg.viewBox.baseVal) || null;
      const vbW = (vb && vb.width) || 1121.71, vbH = (vb && vb.height) || 1121.73;
      const MARGIN = 8, REACH = 55;                 // desired travel, room-clamped below
      // common heading from the captured direction, plus the measured steady drift
      const th = (p.direction || 0) * Math.PI / 180;
      let hx = Math.cos(th), hy = -Math.sin(th);   // math y-up -> screen y-down
      const dxv = p.driftX || 0, dyv = p.driftY || 0;
      if (dxv || dyv) {
        const dl = Math.hypot(dxv, dyv);
        /* `direction` is an unsigned dominant-AXIS angle, not a heading: distill.py does
           `% 180.0`, so a flock falling (270) and one rising (90) both arrive as 90. The
           drift is the only signed evidence there is — driftY is +down, the same screen
           space hy is in — so resolve the axis against it BEFORE averaging. Averaging first
           destroys the heading whenever the two disagree: measured on the pre-fix code, a
           falling flock (dir 90, driftY +0.9) cancelled to (0,0) and then normalized float
           noise from cos(90°) into a pure +x heading, drifting 52.08px SIDEWAYS, and a
           leftward flock (dir 0, driftX -0.9) cancelled exactly and froze at 0.00px. */
        if (hx * dxv + hy * dyv < 0) { hx = -hx; hy = -hy; }
        hx = (hx + dxv / dl) / 2; hy = (hy + dyv / dl) / 2;
        const hl = Math.hypot(hx, hy) || 1;
        hx /= hl; hy /= hl;
      }
      s._flock = kids.map((el, i) => {
        const b = el.getBBox();
        // room in the direction THIS member is heading (both axes must allow it)
        const roomX = hx >= 0 ? Math.max(0, vbW - (b.x + b.width) - MARGIN)
                              : Math.max(0, b.x - MARGIN);
        const roomY = hy >= 0 ? Math.max(0, vbH - (b.y + b.height) - MARGIN)
                              : Math.max(0, b.y - MARGIN);
        const reach = Math.min(REACH,
          Math.abs(hx) > 1e-3 ? roomX / Math.abs(hx) : Infinity,
          Math.abs(hy) > 1e-3 ? roomY / Math.abs(hy) : Infinity);
        return {
          el, hx, hy,
          reach: reach * (0.7 + this._leafRnd(i, 4) * 0.3),   // per-member variety
          driftF: 0.05 + this._leafRnd(i, 7) * 0.05,
          driftPh: this._leafRnd(i, 8) * Math.PI * 2,
          wobF: 0.15 + this._leafRnd(i, 6) * 0.18,
          wobPh: this._leafRnd(i, 0) * Math.PI * 2,
          wobDir: this._leafRnd(i, 9) * Math.PI * 2,
        };
      });
      s._flockMotion = motion.id;
    }
    const wob = (p.turbulence || 0) * TURB_PX * intensity;
    const freq = 0.5 + (p.frequency || 1) * 0.5;
    for (const fd of s._flock) {
      const ramp = (1 - Math.cos(2 * Math.PI * fd.driftF * freq * t + fd.driftPh)) / 2;
      // hard cap at the member's room: the Intensity slider goes to 2x, and the
      // room-fit alone would let it push members off the canvas
      const travel = Math.min(fd.reach, fd.reach * intensity * ramp);
      // wander perpendicular AND along, at the member's own phase, so the flock
      // loosens as it drifts instead of holding formation
      const w = wob * Math.sin(2 * Math.PI * fd.wobF * freq * t + fd.wobPh);
      const dx = fd.hx * travel + Math.cos(fd.wobDir) * w;
      const dy = fd.hy * travel + Math.sin(fd.wobDir) * w;
      fd.el.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
    }
    wrap.setAttribute('transform', '');
    return true;
  }

  /*
   * Tree canopy: preserve the detailed silhouettes and sway the overlay around
   * a low pivot. The static source beneath it restores any area the wind opens.
   */
  _applyTreeLeaves(s, motion, t, intensity) {
    const wrap = s.wrap;
    const canopy = wrap.querySelector('[data-motion-role="tree-canopy"]');
    if (!canopy) return;
    if (!s._treeLeaves || s._treeLeaves.el !== canopy) {
      const b = canopy.getBBox();
      s._treeLeaves = {
        el: canopy,
        px: b.x + b.width * 0.78,
        py: b.y + b.height * 0.97,
      };
    }
    const p = motion.params || {};
    const frequency = Number.isFinite(p.frequency) ? p.frequency : 0.4;
    const amplitude = Number.isFinite(p.amplitude) ? p.amplitude : 0.45;
    const phase = 2 * Math.PI * Math.max(0.12, Math.min(0.65, frequency)) * t;
    const primary = Math.sin(phase);
    const harmonic = Math.sin(phase * 2);
    const reach = 2.5 + Math.max(0, Math.min(1, amplitude)) * 4;
    const dx = reach * intensity * (primary + harmonic * 0.16);
    const dy = 0.55 * intensity * harmonic;
    const angle = 0.42 * intensity * (primary + harmonic * 0.1);
    const { px, py } = s._treeLeaves;
    canopy.setAttribute('transform',
      `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) ` +
      `rotate(${angle.toFixed(3)} ${px.toFixed(1)} ${py.toFixed(1)})`);
    wrap.setAttribute('transform', '');
  }

  /*
   * Realistic falling leaves: instead of moving the whole group rigidly, each
   * child leaf falls down a vertical corridor at its own speed, swaying and
   * tumbling, and wraps back to the top (fading in/out to hide the reset).
   * Reads as a continuous stream of leaves drifting to the ground.
   */
  _applyLeafFall(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._leaves || s._leavesMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      const svg = wrap.ownerSVGElement;
      const H = (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.height) || 1377;
      s._corridor = { topY: H * 0.14, groundY: H * 0.80 };   // spawn line → ground line
      s._leaves = kids.map((el, i) => {
        const b = el.getBBox();
        return {
          el, cx: b.x + b.width / 2, cy: b.y + b.height / 2,
          vy: 60 + this._leafRnd(i, 1) * 95,               // fall speed (units/s)
          swayA: 12 + this._leafRnd(i, 2) * 30,            // horizontal sway amplitude
          swayF: 0.35 + this._leafRnd(i, 3) * 0.7,         // sway frequency (Hz)
          phase: this._leafRnd(i, 4) * Math.PI * 2,
          rot0: this._leafRnd(i, 5) * 360,
          rotV: (this._leafRnd(i, 6) - 0.5) * 170,         // tumble (deg/s)
        };
      });
      s._leavesMotion = motion.id;
    }
    const { topY, groundY } = s._corridor;
    const Hc = Math.max(1, groundY - topY);
    const spd = intensity;
    for (const lf of s._leaves) {
      const start = lf.cy - topY;
      const ph = (((start + lf.vy * t * spd) % Hc) + Hc) % Hc;   // 0..Hc, wraps
      const dy = (topY + ph) - lf.cy;
      const dx = lf.swayA * spd * Math.sin(lf.swayF * 2 * Math.PI * t + lf.phase);
      const ang = lf.rot0 + lf.rotV * t;
      const fin = Math.min(1, ph / (Hc * 0.07));                 // fade in near top
      const fout = Math.min(1, (Hc - ph) / (Hc * 0.14));         // fade out near ground
      lf.el.setAttribute('transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${ang.toFixed(1)} ${lf.cx.toFixed(1)} ${lf.cy.toFixed(1)})`);
      lf.el.style.opacity = Math.max(0, Math.min(fin, fout)).toFixed(3);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * Birds: each child path is one bird, with a subtle WING FLAP — a small
   * vertical squash/stretch about the bird's own center (wings sweep up/down)
   * at a natural ~2-3 Hz, each bird on its own phase so the flock isn't in
   * lockstep.
   *
   * Travel: the flock is split into two groups by which half of the sky each
   * bird sits in. LEFT-half birds drift gently LEFT, RIGHT-half birds drift
   * gently RIGHT — so the flock fans outward instead of streaming off one edge.
   * The drift is a small, slow sine and each bird is clamped to its own
   * on-canvas room, so no bird ever leaves the artwork. Wing flap is untouched.
   */
  _applyBirds(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._birds || s._birdsMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      const svg = wrap.ownerSVGElement;
      const vb = (svg && svg.viewBox && svg.viewBox.baseVal) || { width: 1121.71, height: 1121.73 };
      const vbW = vb.width, mid = vbW / 2, MARGIN = 8;
      const DRIFT = 55;   // max desired horizontal drift (viewBox units), room-clamped below
      s._birds = kids.map((el, i) => {
        const b = el.getBBox();
        // group by sky half: left-half → drift left (-1), right-half → right (+1)
        const goRight = (b.x + b.width / 2) >= mid;
        const roomLeft  = Math.max(0, b.x - MARGIN);
        const roomRight = Math.max(0, vbW - (b.x + b.width) - MARGIN);
        // amplitude bounded by the room on the side this bird moves toward
        const amp = Math.min(DRIFT, goRight ? roomRight : roomLeft);
        return {
          el, cx: b.x + b.width / 2, cy: b.y + b.height / 2,
          dir: goRight ? 1 : -1,
          amp: amp * (0.7 + this._leafRnd(i, 4) * 0.3),    // slight per-bird variety
          driftF: 0.05 + this._leafRnd(i, 7) * 0.05,       // slow drift (0.05–0.10 Hz)
          driftPh: this._leafRnd(i, 8) * Math.PI * 2,
          flapF: 2.1 + this._leafRnd(i, 1) * 1.3,          // 2.1–3.4 Hz wingbeat
          phase: this._leafRnd(i, 2) * Math.PI * 2,        // desync the flock
          flapAmp: 0.16 + this._leafRnd(i, 3) * 0.10,      // per-bird flap depth
          bobA: 4 + this._leafRnd(i, 5) * 6,               // gentle vertical waver
          bobF: 0.15 + this._leafRnd(i, 6) * 0.18,
          bobPh: this._leafRnd(i, 0) * Math.PI * 2,
        };
      });
      s._birdsMotion = motion.id;
    }
    const spd = intensity;
    for (const bd of s._birds) {
      // gentle bounded drift outward (left group left, right group right).
      // (1 - cos)/2 ramps 0→1→0 so it eases out and back without a hard turn,
      // and the sign never crosses zero → the bird only ever moves outward.
      const ramp = (1 - Math.cos(2 * Math.PI * bd.driftF * t + bd.driftPh)) / 2;
      const dx = bd.dir * bd.amp * spd * ramp;
      const dy = bd.bobA * spd * Math.sin(2 * Math.PI * bd.bobF * t + bd.bobPh);
      // wing flap: vertical scale oscillates about the bird's center (unchanged)
      const flap = 1 - bd.flapAmp * spd * (0.5 + 0.5 * Math.sin(2 * Math.PI * bd.flapF * t + bd.phase));
      const sy = Math.max(0.6, flap);
      bd.el.setAttribute('transform',
        `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) ` +
        `translate(${bd.cx.toFixed(1)} ${bd.cy.toFixed(1)}) scale(1 ${sy.toFixed(3)}) ` +
        `translate(${(-bd.cx).toFixed(1)} ${(-bd.cy).toFixed(1)})`);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * Clouds: in the reference clip, clouds drift slowly and STEADILY in one
   * direction (wind) — they don't bob, pulse, or reverse. So each cloud gets a
   * gentle, uniform horizontal glide (all the same wind direction, slightly
   * different speeds), with a very slow, very shallow sine so the loop is
   * seamless without the drift ever reading as back-and-forth. No vertical bob,
   * no scale "breathing" (both looked unnatural). Amplitude is small and each
   * cloud is bounded to its own on-canvas room so none can wander off.
   */
  _applyClouds(s, motion, t, intensity) {
    const wrap = s.wrap;
    const CLOUD_SAMPLES = 64;
    if (!s._clouds || s._cloudsMotion !== motion.id) {
      const kids = [...wrap.querySelectorAll('path')];
      const svg = wrap.ownerSVGElement;
      const vbW = (svg && svg.viewBox && svg.viewBox.baseVal && svg.viewBox.baseVal.width) || 1121.71;
      const MARGIN = 8;
      s._clouds = kids.map((el, i) => {
        // remember pristine geometry so we can restore/rebuild each frame
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        const b = el.getBBox();
        // sample the cloud outline into points so we can gently billow the edge
        let pts = null;
        const len = el.getTotalLength ? el.getTotalLength() : 0;
        if (len) {
          pts = [];
          for (let k = 0; k <= CLOUD_SAMPLES; k++) {
            const pt = el.getPointAtLength(len * k / CLOUD_SAMPLES);
            pts.push([pt.x, pt.y]);
          }
        }
        const roomLeft  = Math.max(0, b.x - MARGIN);
        const roomRight = Math.max(0, vbW - (b.x + b.width) - MARGIN);
        const amp = Math.min(34, roomLeft, roomRight);
        return {
          el, pts, closed: /z\s*$/i.test(d0),
          cx: b.x + b.width / 2, cy: b.y + b.height / 2,
          w: Math.max(1, b.width), h: Math.max(1, b.height),
          amp: amp * (0.7 + this._leafRnd(i, 5) * 0.3),    // drift amplitude, per-cloud
          driftF: 0.010 + this._leafRnd(i, 1) * 0.010,     // extremely slow drift
          driftPh: this._leafRnd(i, 2) * Math.PI * 2,
          billowPh: this._leafRnd(i, 3) * Math.PI * 2,     // desync the billow
        };
      });
      s._cloudsMotion = motion.id;
    }
    // BILLOW: slow, shallow deformation of the outline so the cloud softly
    // morphs as it drifts (like the reference clip) instead of moving rigidly.
    const BILLOW = 2.4 * intensity;     // max edge displacement (viewBox units) — subtle
    const bf = 0.06;                    // billow frequency (very slow)
    for (const cd of s._clouds) {
      // steady wind drift (unchanged)
      const dx = cd.amp * intensity * Math.sin(2 * Math.PI * cd.driftF * t + cd.driftPh);
      if (cd.pts) {
        const ph = 2 * Math.PI * bf * t + cd.billowPh;
        let d = '';
        for (let k = 0; k < cd.pts.length; k++) {
          const [x0, y0] = cd.pts[k];
          // position-dependent phase so different parts of the outline swell at
          // different times → the silhouette breathes organically, not uniformly
          const u = (x0 - cd.cx) / cd.w, v = (y0 - cd.cy) / cd.h;
          const sx = BILLOW * Math.sin(ph + u * 4.0 + v * 2.3);
          // tops billow up a touch more than the flat base
          const sy = BILLOW * 0.7 * Math.cos(ph * 0.9 + v * 3.1 + u * 1.7);
          d += (k ? 'L' : 'M') + (x0 + sx).toFixed(2) + ',' + (y0 + sy).toFixed(2);
        }
        cd.el.setAttribute('d', cd.closed ? d + 'Z' : d);
      }
      cd.el.setAttribute('transform', `translate(${dx.toFixed(2)} 0)`);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * River ripples: the Water Ripple preset has no captured trajectory field, so
   * by default it would just rigidly shake the whole ripple group. Instead we
   * DEFORM the ripple geometry with a smooth LAMINAR traveling wave — glassy
   * downstream flow rather than choppy chop:
   *
   *   dy(x,y,t) = A · sin(k·x − 2πf·t + φ(y)) + small second harmonic
   *   dx(...)   = a gentle along-stream shear so ripple crests slide downstream
   *
   * Long wavelength + low amplitude + zero turbulence = laminar. A slow phase
   * offset per scanline (φ(y)) makes the sheet flow, not oscillate in lockstep.
   * The deformation is applied to the SAME sampled-path machinery cloth uses
   * (buildWaveData), but with a flow-tuned displacement instead of a flag whip.
   */
  _applyRiver(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._river) {
      // cache the path elements + pristine geometry + box (coordinate-warp, tear-free)
      const els = [];
      for (const el of wrap.querySelectorAll('path')) {
        let d0 = el.getAttribute('data-ms-d0');
        if (!d0) { d0 = el.getAttribute('d'); if (!d0) continue; el.setAttribute('data-ms-d0', d0); }
        else el.setAttribute('d', d0);
        els.push({ el, d0 });
      }
      let bb; try { bb = wrap.getBBox(); } catch (_) { bb = null; }
      s._river = { els, box: bb ? { minX: bb.x, minY: bb.y,
        width: Math.max(1, bb.width), height: Math.max(1, bb.height) } : null };
    }
    const rv = s._river;
    // Art built from non-<path> shapes (rect/polygon/ellipse) has no outline to deform —
    // fall back to a gentle rigid sway instead of silently doing nothing.
    if (!rv.els.length || !rv.box) {
      const { dx, dy, rot } = computeMotion(motion.params, s.center[0] * 0.01 + s.center[1] * 0.03, t, intensity);
      const [cx, cy] = s.center;
      wrap.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)}) rotate(${rot.toFixed(3)} ${cx.toFixed(1)} ${cy.toFixed(1)})`);
      return;
    }
    const box = rv.box, width = box.width, height = box.height;
    const p = motion.params || {};
    // laminar tuning: long wavelength, slow drift, shallow amplitude (kept verbatim).
    const A = 3.4 * (0.6 + (p.amplitude || 0.2)) * intensity;   // vertical swell (units)
    const k = 2 * Math.PI * 1.15 / width;                       // ~1 crest across the river
    const f = 0.28 * (0.6 + (p.frequency || 1.0) * 0.5);        // slow downstream speed
    const phase = 2 * Math.PI * f * t;
    const flow = 5.0 * intensity;                               // along-stream crest slide
    // continuous laminar displacement — a pure function of (x,y), so shared points align.
    const disp = (x, y) => {
      const yPhase = (y - box.minY) / height * Math.PI * 1.3;   // downstream, not lockstep
      const arg = k * (x - box.minX) - phase + yPhase;
      const dy = A * Math.sin(arg) + A * 0.35 * Math.sin(arg * 0.5 + phase * 0.6);
      const dx = flow * Math.cos(arg) * 0.5;
      return [x + dx, y + dy];
    };
    for (const o of rv.els) o.el.setAttribute('d', warpPathD(o.d0, disp));
    wrap.setAttribute('transform', '');
  }

  /*
   * Boat: a rigid hull shouldn't ripple like water — but it should FLOAT on the
   * ripples. Replicate the water-ripple rhythm as a gentle rigid BOB (rise/fall)
   * plus a slow ROCK (tilt about the waterline), like the moored boat in the
   * reference night clip. The bob/rock share the river's slow frequency and low
   * amplitude, so the boat reads as riding the same ripples the surface shows.
   * A small phase offset between bob and rock keeps it from looking mechanical.
   */
  _applyBoat(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._boat) {
      const b = wrap.getBBox();
      s._boat = {
        // pivot at the waterline: horizontal center, near the bottom of the hull
        px: b.x + b.width / 2,
        py: b.y + b.height * 0.82,
      };
    }
    const p = motion.params || {};
    // match the river's laminar cadence so boat + water feel coupled
    const f = 0.28 * (0.6 + (p.frequency || 1.0) * 0.5);   // same base as _applyRiver
    const amp = (0.6 + (p.amplitude || 0.2));
    const bob = 7.0 * amp * intensity * Math.sin(2 * Math.PI * f * t);          // vertical rise/fall
    const rock = 1.4 * amp * intensity * Math.sin(2 * Math.PI * f * 0.85 * t + 0.7); // tilt (deg)
    const bp = s._boat;
    wrap.setAttribute('transform',
      `translate(0 ${bob.toFixed(2)}) rotate(${rock.toFixed(3)} ${bp.px.toFixed(1)} ${bp.py.toFixed(1)})`);
  }

  /*
   * Travel path (Step 5): follow a path REALLY extracted from the clip.
   * motion.path.points are [frame, dx, dy] offsets from the tracked object's own
   * start, normalized to the video frame — so one path fits artwork of any size.
   *
   * Two things have to be reconciled with the artwork:
   *   ROOM — the filmed object may cross 60% of its frame while the artwork's copy
   *     has 8% of the canvas to its right. Offsets get ONE uniform scale (the
   *     tightest of the four directions) so the path keeps its SHAPE: a diagonal
   *     drift must not flatten into a vertical one because the horizontal room ran
   *     out. The per-frame result is then hard-clamped to the room as well, because
   *     the Intensity slider goes to 2x and would otherwise push it off canvas.
   *   LOOPING — the clip ends wherever the object happened to get to. Snapping back
   *     to the start reads as a teleport, and easing back would be motion that is
   *     not in the video, so the path PING-PONGS: every position shown is a real
   *     extracted sample; only the return leg's time order is reversed.
   *
   * The path supplies TRAVEL. motion.params (distilled from the flow field inside
   * the object's own mask) supplies a residual bob ACROSS the course, so a boat
   * still rides its water while it crosses the scene. SVG only — a raster
   * selection has no viewBox to measure its room in.
   */
  _applyPathTravel(s, motion, t, intensity) {
    const wrap = s.wrap;
    const P = this._pathFor(motion);
    if (!P) return false;
    if (!s._path || s._pathMotion !== motion.id) {
      const svg = wrap.ownerSVGElement;
      const vb = (svg && svg.viewBox && svg.viewBox.baseVal) || { width: 1121.71, height: 1121.73 };
      const MARGIN = 8;
      let b; try { b = wrap.getBBox(); } catch (_) { b = { x: 0, y: 0, width: 1, height: 1 }; }
      const room = {
        left:  Math.max(0, b.x - MARGIN),
        right: Math.max(0, vb.width - (b.x + b.width) - MARGIN),
        up:    Math.max(0, b.y - MARGIN),
        down:  Math.max(0, vb.height - (b.y + b.height) - MARGIN),
      };
      // what the path WANTS in each direction, in viewBox units at 1:1 (frame ≙ canvas)
      let wR = 0, wL = 0, wD = 0, wU = 0;
      for (const pt of P.points) {
        wR = Math.max(wR, pt[1] * vb.width);   wL = Math.max(wL, -pt[1] * vb.width);
        wD = Math.max(wD, pt[2] * vb.height);  wU = Math.max(wU, -pt[2] * vb.height);
      }
      let k = 1;   // never >1: the video's own excursion is the natural size
      const fit = (want, have) => { if (want > 1e-3) k = Math.min(k, have / want); };
      fit(wR, room.right); fit(wL, room.left); fit(wD, room.down); fit(wU, room.up);
      const tv = P.travel || {};
      const netLen = Math.hypot(tv.dx || 0, tv.dy || 0) || 1;
      s._path = {
        pts: P.points, span: P.points.length - 1, room,
        sx: k * vb.width, sy: k * vb.height,       // normalized offset -> viewBox units
        fps: Math.max(1, P.fps || 30),
        // unit normal to the NET course: the residual bob rides across the path
        // instead of fighting it or faking extra travel along it
        nx: -(tv.dy || 0) / netLen, ny: (tv.dx || 0) / netLen,
      };
      if (k < 0.999) {
        console.log(`[MotionLife] "${s.name}": ${P.label} travel path scaled to `
          + `${(k * 100).toFixed(0)}% — that is all the room the artwork has for it.`);
      }
      s._pathMotion = motion.id;
    }
    const pd = s._path, span = pd.span;
    // ping-pong through the samples, interpolating between the two neighbours so
    // playback stays smooth at screen refresh rates (samples are at video fps)
    const u = (t * pd.fps) % (2 * span);
    const pos = u <= span ? u : 2 * span - u;
    const i = Math.min(span - 1, Math.floor(pos)), f = pos - i;
    const a = pd.pts[i], c = pd.pts[i + 1];
    let dx = (a[1] + (c[1] - a[1]) * f) * pd.sx * intensity;
    let dy = (a[2] + (c[2] - a[2]) * f) * pd.sy * intensity;
    // residual motion the flow field measured inside the object's mask
    const p = motion.params || {};
    const bob = 4.0 * (0.4 + (p.amplitude || 0.2)) * intensity
              * Math.sin(2 * Math.PI * 0.28 * (0.6 + (p.frequency || 1) * 0.5) * t);
    dx += pd.nx * bob; dy += pd.ny * bob;
    // hard bound: on canvas at every intensity, path scale and bob combined
    dx = Math.max(-pd.room.left, Math.min(pd.room.right, dx));
    dy = Math.max(-pd.room.up, Math.min(pd.room.down, dy));
    wrap.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
  }

  /*
   * Wing flap driven by the CAPTURED pose — not a sine.
   *
   * A 13-joint human skeleton has no wing joints, so there is nothing to bind
   * l_sho/l_elb/l_wri to on a bird. What the clip DOES carry is one honest scalar:
   * how high the subject's wrists ride relative to their shoulders, measured in
   * torso lengths so it is size- and distance-independent. On the boy-flapping clip
   * that track is a clean 0.70 Hz wave that dwells at both extremes and moves fast
   * between them — asymmetry a sine cannot produce, and the whole point of using the
   * measured one.
   *
   * That track rotates each tagged wing about its ROOT, left and right mirrored. Tag
   * the artwork data-role="wing-l" / "wing-r", and optionally "wing-body" to pin the
   * pivot reference and take the body bob; without it the region's own centre is used.
   */
  /*
   * LIMB ARTICULATION from a captured pose — real per-limb motion on path-based artwork.
   *
   * The existing character rig (_applyCharacter) can only drive the procedural duck/bear
   * scenes: it rewrites <polygon points> and circle cx/cy, so arbitrary Illustrator paths
   * have nothing for it to move, and its puppet fallback bobs the whole figure as one
   * piece. This drives the artwork the artist actually drew: tag each limb group
   * data-limb="arm-r" (etc.) and it rotates about its joint by the angle THAT BONE makes
   * in the capture, frame for frame.
   *
   * Rotation is a DELTA from the bone's rest angle (the circular mean over the clip), not
   * the absolute angle, so the pose the artist drew is the neutral: a boy drawn with his
   * arms up stays arms-up and the capture swings them around that. Absolute angles would
   * snap the artwork into the subject's stance on the first frame and throw the drawing
   * away.
   *
   * UNLIKE _applyWings, the measured amplitude is NOT normalised away. Wings map the
   * clip's range onto a fixed sweep on purpose; here the whole point is the subject's own
   * articulation, so a small movement stays small. Only LIMB_DEG_MAX clamps it.
   *
   * Two gates, both measurements rather than guesses (LIMB_VIS_OK, LIMB_FORESHORTEN). A
   * gated frame HOLDS the previous good angle rather than snapping to rest, so occlusion
   * reads as a pause and not as a twitch. A limb with no usable frame at all never moves.
   *
   * It is deliberately NOT mirrored from the opposite limb when a side is occluded. The
   * shipped walk has no usable left arm, and filling it in from the right one with a
   * half-period offset would look better while being invented — this tool exists to show
   * motion that was actually measured, so an unmeasured limb stays still.
   */
  _applyLimbs(s, motion, t, intensity) {
    const wrap = s.wrap;
    const mode = s.limbRetarget || wrap.dataset.retarget || LIMB_RETARGET_DEFAULT;
    if (!s._limb || s._limbMotion !== motion.id || s._limbRetarget !== mode) {
      const pose = this._poseFor(motion);
      const frames = pose.frames.filter(Boolean);
      const jn = {}; pose.joints.forEach((n, i) => jn[n] = i);
      // '@sho' / '@hip' are midpoints, so head and torso use the same bone-angle path
      const jointAt = (f, name) => {
        if (name === '@sho' || name === '@hip') {
          const l = f[jn[name === '@sho' ? 'l_sho' : 'l_hip']];
          const r = f[jn[name === '@sho' ? 'r_sho' : 'r_hip']];
          if (!l || !r) return null;
          const m = [(l[0] + r[0]) / 2, (l[1] + r[1]) / 2, Math.min(l[2], r[2])];
          if (l.length > 3 && r.length > 3) m.push((l[3] + r[3]) / 2);
          return m;
        }
        const i = jn[name];
        return i == null ? null : f[i];
      };

      /*
       * Which horizontal axis carries this role's motion: the picture's x, or depth.
       *
       * Depth is a 4th value on each joint and is absent from older swatches, so this falls
       * back to x whenever it is missing — a pose file captured before the service emitted
       * depth animates exactly as it did before. The service only says 'depth' after
       * measuring that the legs alternate there (see gait.stride_axis), so this is following
       * a measurement, not guessing from the viewpoint label.
       */
      const strideAxis = (pose.gait || {}).stride_axis;
      const hasDepth = frames.length > 0 && frames[0].some(p => p && p.length > 3);
      const useDepth = strideAxis === 'depth' && hasDepth;
      const axisFor = role => (useDepth && LIMB_DEPTH_ROLES.has(role)) ? 3 : 0;

      const bbOf = el => { try { return el.getBBox(); } catch (_) { return null; } };
      const pivotAttr = (el) => {
        const v = el && el.dataset && el.dataset.pivot;
        if (!v) return null;
        const m = v.trim().split(/[\s,]+/).map(Number);
        return (m.length === 2 && m.every(Number.isFinite)) ? [m[0], m[1]] : null;
      };

      /*
       * WHICH WAY IS THE CAPTURE FACING, AND WHICH WAY IS THE ARTWORK DRAWN?
       *
       * MediaPipe labels landmarks by the SUBJECT's own left and right, so the horizontal
       * arrangement flips with the camera: filmed from behind, the anatomical left hip sits
       * at LOWER x, while a figure drawn facing the viewer has its anatomical left limb at
       * HIGHER x. Matching role-to-role without reconciling that mirrors every horizontal
       * component — the frames where the subject's feet converge push the artwork's apart.
       * Measured on walk-man.mp4 (a man walking AWAY) driving the boy (drawn FACING us):
       * capture hip dx -0.115 against the boy's leg pivots 737 vs 500, i.e. opposite signs.
       *
       * Mirroring the capture in x maps a bone direction (dx,dy) -> (-dx,dy), so an angle
       * becomes 180-angle and a delta simply negates. Antiphase survives (both sides negate),
       * so this changes WHICH leg leads, not whether they alternate.
       */
      const medianDx = (a, b) => {
        const v = [];
        for (const f of frames) {
          const p = jointAt(f, a), q = jointAt(f, b);
          if (p && q && Math.min(p[2], q[2]) >= LIMB_VIS_OK) v.push(p[0] - q[0]);
        }
        if (!v.length) return 0;
        v.sort((x, y) => x - y);
        return v[Math.floor(v.length / 2)];
      };
      const capSide = medianDx('l_hip', 'r_hip');

      /*
       * The direction the limb is DRAWN in: its joint to its far end. Needed for retargeting,
       * which has to know what it is rotating FROM.
       *
       * The far end is the sampled path point farthest from the pivot, not the bbox
       * bottom-centre. A leg drawn on a diagonal has its foot at a bbox CORNER, and reading
       * the bottom-centre instead put this boy's feet 5.3x closer together than they are —
       * which is how a "crosses at intensity 2" measurement survived that was not crossing.
       */
      const drawnDeg = (el, px, py) => {
        let best = null, bd = -1;
        const take = (x, y) => {
          const d = Math.hypot(x - px, y - py);
          if (d > bd) { bd = d; best = { x, y }; }
        };
        for (const p of el.querySelectorAll('path,polygon,rect,circle,ellipse')) {
          let n = 0;
          try { n = p.getTotalLength ? p.getTotalLength() : 0; } catch (_) { n = 0; }
          if (!(n > 0)) continue;
          for (let k = 0; k <= LIMB_TIP_SAMPLES; k++) {
            let q; try { q = p.getPointAtLength(n * k / LIMB_TIP_SAMPLES); } catch (_) { continue; }
            take(q.x, q.y);
          }
        }
        if (!best) {                                  // nothing measurable: bbox corners
          const b = bbOf(el);
          if (!b) return null;
          take(b.x, b.y); take(b.x + b.width, b.y);
          take(b.x, b.y + b.height); take(b.x + b.width, b.y + b.height);
        }
        return best ? Math.atan2(best.y - py, best.x - px) * 180 / Math.PI : null;
      };

      // Body reference for inferring an undeclared joint: the tagged torso if there is
      // one, else the whole region's centre.
      const torsoEl = wrap.querySelector('[data-limb="torso"]');
      const fb = bbOf(wrap) || { x: 0, y: 0, width: 1, height: 1 };
      const tb = (torsoEl && bbOf(torsoEl)) || fb;
      const bodyC = [tb.x + tb.width / 2, tb.y + tb.height / 2];

      const limbs = [];
      for (const el of wrap.querySelectorAll('[data-limb]')) {
        const role = el.dataset.limb;
        const bone = LIMB_BONES[role];
        const b = bbOf(el);
        if (!bone || !b) continue;                      // unknown role: leave it alone

        // ---- the bone's angle track, with both gates ----
        // The length gate is measured in the SAME plane as the angle. A gate in a different
        // plane can reject a frame the angle is fine in — a leg foreshortened in x may be
        // fully extended in depth, which is exactly the case depth exists to handle.
        // Measured, this costs nothing either way: 0 of 62 frames gated in both planes on
        // brisk-walk, 0 of 534 on walk-man-side (one bone, shin-l, gates 8 frames in depth).
        const ax = axisFor(role);
        const lens = [], angs = [];
        for (const f of frames) {
          const p = jointAt(f, bone[0]), q = jointAt(f, bone[1]);
          if (!p || !q) { lens.push(null); angs.push(null); continue; }
          const L = Math.hypot(q[ax] - p[ax], q[1] - p[1]);
          lens.push(Math.min(p[2], q[2]) >= LIMB_VIS_OK ? L : null);
          angs.push(Math.atan2(q[1] - p[1], q[ax] - p[ax]));
        }
        const seen = lens.filter(v => v != null).sort((x, y) => x - y);
        const medLen = seen.length ? seen[Math.floor(seen.length / 2)] : 0;
        const ok = lens.map((L, i) => L != null && L >= LIMB_FORESHORTEN * medLen && angs[i] != null);

        // Rest angle as a CIRCULAR mean — a plain average of atan2 output is wrong the
        // moment a bone's angle straddles +/-180deg, which any raised arm can.
        let sx = 0, sy = 0, nOk = 0;
        for (let i = 0; i < angs.length; i++) {
          if (!ok[i]) continue;
          sx += Math.cos(angs[i]); sy += Math.sin(angs[i]); nOk++;
        }
        const rest = nOk ? Math.atan2(sy, sx) : 0;

        // Deltas, shortest arc, clamped; a gated frame holds the previous good value.
        const track = []; let held = 0;
        for (let i = 0; i < angs.length; i++) {
          if (ok[i]) {
            let d = (angs[i] - rest) * 180 / Math.PI;
            held = ((d + 180) % 360 + 360) % 360 - 180;  // -180..180, sign preserved
          }
          track.push(held);
        }

        // The joint: declared pivot wins. data-pivot is in the limb's OWN user space —
        // the same space getBBox() reports, and the space the rotate() below acts in,
        // since the artwork's own transform is applied outside it. For an Illustrator
        // export whose groups carry no transform that is just the root viewBox.
        // Otherwise clamp the body centre into this

        // limb's own box — a limb reaches AWAY from the body, so that lands on the edge
        // where it attaches (the same trick _applyWings uses for a wing root).
        const pv = pivotAttr(el);
        if (el.dataset.limbNeutral == null) el.dataset.limbNeutral = el.getAttribute('transform') || '';
        const px = pv ? pv[0] : Math.max(b.x, Math.min(b.x + b.width, bodyC[0]));
        const py = pv ? pv[1] : Math.max(b.y, Math.min(b.y + b.height, bodyC[1]));
        limbs.push({
          el, role, neutral: el.dataset.limbNeutral, track,
          usable: nOk, frames: frames.length, px, py, declared: !!pv,
          restDeg: rest * 180 / Math.PI,               // the bone's captured rest, unmirrored
          drawn: drawnDeg(el, px, py),                 // where the artwork points it
        });
      }
      // Hang each limb off its parent (LIMB_PARENT). Ancestors that the artwork did not
      // tag are simply absent from the chain, so a partial rig degrades to a flat one
      // instead of failing.
      const byRole = new Map(limbs.map(g => [g.role, g]));
      for (const g of limbs) {
        g.chain = [];
        for (let r = LIMB_PARENT[g.role]; r; r = LIMB_PARENT[r]) {
          const p = byRole.get(r);
          if (p) g.chain.push(p);
        }
      }

      // Now that the pivots exist, the artwork's facing can be read off them and compared
      // with the capture's (see the medianDx note). Prefer the legs, fall back to the arms —
      // a rig may tag only one pair.
      const sideOf = (l, r) => {
        const a = byRole.get(l), b2 = byRole.get(r);
        return (a && b2) ? a.px - b2.px : 0;
      };
      const artSide = sideOf('leg-l', 'leg-r') || sideOf('arm-l', 'arm-r');
      const mirror = capSide * artSide < 0;
      if (mirror) {
        for (const g of limbs) {
          g.restDeg = deg180(180 - g.restDeg);
          for (let i = 0; i < g.track.length; i++) g.track[i] = -g.track[i];
        }
      }

      /*
       * Trim to the longest self-closing loop FIRST, so closeLoop only ever has a small
       * remainder to flatten — see the LIMB_LOOP_SEAM note. Judged on the legs, because a
       * stride cycle is defined by their alternation; a rig with no usable leg pair keeps
       * every frame, which is what every non-walking capture did before this existed.
       */
      const nFull = frames.length;
      let nKeep = nFull;
      const legPair = ['leg-l', 'leg-r'].map(r => byRole.get(r))
        .filter(g => g && g.usable && g.track.length === nFull);
      if (legPair.length === 2) {
        const spans = legPair.map(g => {
          let lo = Infinity, hi = -Infinity;
          for (const v of g.track) { if (v < lo) lo = v; if (v > hi) hi = v; }
          return hi - lo;
        });
        if (spans.every(r => r > 0)) {
          const floor = Math.max(4, Math.round(nFull * LIMB_LOOP_MIN_KEEP));
          for (let nn = nFull; nn >= floor; nn--) {
            if (legPair.every((g, k) =>
                Math.abs(g.track[nn - 1] - g.track[0]) <= LIMB_LOOP_SEAM * spans[k])) {
              nKeep = nn; break;
            }
          }
        }
      }
      // Every limb has to end on the same frame or they would drift out of step with each
      // other, so the trim chosen from the legs is applied to all of them.
      if (nKeep < nFull) for (const g of limbs) g.track.length = nKeep;

      // The clip is not cyclic and the animation loops it, so the drift has to come out or it
      // comes out all at once at the seam — see closeLoop. After mirroring and trimming, on
      // the final signed track, and before restDeg is used, since closeLoop preserves the mean
      // it is a circular mean of.
      for (const g of limbs) closeLoop(g.track);

      /* Retarget only where there is something real to retarget to. A limb with no usable
       * frame has a rest angle of 0 that means "we never saw this bone", and rotating the
       * drawing to it would be an invention; it holds its drawn pose instead. Resolve
       * parents before children (shorter chain first) so a child can subtract what its
       * ancestors already contribute. */
      const wanted = (role) => mode === 'all' || (mode === 'legs' && LIMB_RETARGET_ROLES.test(role));
      for (const g of limbs) g.retarget = !!(g.usable && g.drawn != null && wanted(g.role));
      const order = [...limbs].sort((a, b) => a.chain.length - b.chain.length);

      /*
       * THE STATIC PART OF RETARGETING IS ONLY MEANINGFUL WHEN BOTH ANGLES ARE IN THE SAME
       * PLANE, AND FOR A DEPTH-DRIVEN ROLE THEY ARE NOT.
       *
       * restDeg is measured on axisFor(role): the picture plane normally, but the DEPTH plane
       * for a leg or shin once the service reports a head-on stride. drawn is always the
       * picture plane — it is read off the artwork, which has no depth. Subtracting one from
       * the other is only valid when the two planes happen to agree.
       *
       * Measured on brisk-walk (62 frames, head-on): in the picture plane every bone rests
       * straight down — thighs 91.1/87.9deg, shins 95.0/85.0. In the depth plane the THIGHS
       * still read 83.3/84.5, which is why this was invisible while thighs were the only
       * depth-driven role: the offset came out 0.1deg and 1.7deg. The SHINS read 53.9/56.8 —
       * a 30-38deg lean that is MediaPipe's coarse z, not a posture. Retargeting to it put a
       * permanent 36-40deg bend in the girl's knees: they measured 15..52deg of flex and never
       * once straightened.
       *
       * So a depth-driven role keeps the SWING (deltas about its own rest, both in the same
       * plane, which is sound) and drops the static offset. It must NOT simply stop
       * retargeting: the non-retarget path does not subtract ancestors, and a shin's track is
       * an ABSOLUTE bone angle that already contains its thigh's rotation, so the thigh would
       * be applied to it twice. Keeping the offset at zero preserves the subtraction.
       *
       * Thighs are unaffected either way (0.1/1.7deg), so no previously measured figure moves.
       */
      for (const g of limbs) {
        g.restOffset = (g.drawn == null) ? 0
          : (axisFor(g.role) === 0 ? deg180(g.restDeg - g.drawn) : 0);
      }

      /* What 'all' WOULD cost this figure, whatever mode is actually in force: each limb's
       * one-off offset with the swing at zero, resolved the same way (see the own-rotation
       * note below). This is the number that decides whether whole-figure retargeting holds a
       * drawing together or tears it, so the inspector can show it before the user commits
       * rather than after. Roles with no usable bone are absent — they are never retargeted. */
      const offsets = new Map();
      for (const g of order) {
        if (!g.usable || g.drawn == null) continue;
        let acc = 0;
        for (const p of g.chain) acc += offsets.get(p) || 0;
        offsets.set(g, deg180(g.restOffset - acc));
      }

      // n is the PLAYED length, which is the trimmed one — the frames past the loop point are
      // deliberately not shown, so playback must not index into them.
      s._limb = { limbs, order, fps: pose.fps || 15, n: nKeep, captured: nFull, mirror, mode,
                  offsets: [...offsets].map(([g, deg]) => ({ role: g.role, deg })) };
      s._limbMotion = motion.id;
      s._limbRetarget = mode;
    }

    const L = s._limb;
    if (!L.n || !L.limbs.length) return;
    // Between captured frames, not at the nearest one — see framePos.
    const { i0, f: ft } = framePos(t, L.fps, L.n);
    // LIMB_DEG_MAX is clamped HERE, after intensity, not when the track was built. Clamping
    // the raw delta first let intensity scale straight past the cap: on the walk-man capture
    // the head's largest raw delta is +28.2deg, which passes a raw clamp untouched and then
    // becomes 112.8deg at intensity 4. Clamping last holds it at exactly 75deg, so the cap
    // is a guarantee at every intensity rather than only at 1. Clamping after the BLEND too,
    // so a value that only reaches the cap partway between two frames is still held there.
    const swing = (g) => Math.max(-LIMB_DEG_MAX,
      Math.min(LIMB_DEG_MAX, splineDeg(g.track, i0, ft, L.n) * intensity));

    /*
     * Each limb's own rotation for this frame, ancestors first.
     *
     * Without retargeting this is just the clamped swing, byte for byte what it always was.
     *
     * With it, the limb has to END UP along the captured bone, so what it owes is the target
     * minus where the drawing already points it MINUS whatever its ancestors are about to
     * contribute — a child rides its parent (see the chain note below), and a captured bone
     * angle is measured in the frame, so it already contains the parent's motion. Subtracting
     * the ancestors is what stops that being applied twice.
     */
    const own = new Map();
    for (const g of L.order) {
      if (!g.retarget) { own.set(g, swing(g)); continue; }
      let acc = 0;
      for (const p of g.chain) acc += own.get(p) || 0;
      own.set(g, deg180(g.restOffset + swing(g) - acc));
    }
    const rot = (g) => `rotate(${(own.get(g) || 0).toFixed(2)} ${g.px.toFixed(1)} ${g.py.toFixed(1)})`;
    for (const g of L.limbs) {
      // SVG applies a transform list RIGHT to LEFT, so the outermost ancestor is written
      // first and the limb's own rotation last — the limb turns about its own joint, then
      // that whole result is carried by its parent, then by its parent's parent.
      const ops = [];
      for (let i = g.chain.length - 1; i >= 0; i--) ops.push(rot(g.chain[i]));
      ops.push(rot(g));
      g.el.setAttribute('transform', `${g.neutral ? g.neutral + ' ' : ''}${ops.join(' ')}`);
    }
    // The limbs carry the JOINT motion; the figure's own translation, lean and squash go on
    // the wrap, which is the one place they can be composed without being counted twice —
    // every limb is a descendant, so it rides the body exactly as a real limb does.
    // _bodyTransform returns '' unless the swatch or the artwork opted in (see the gate
    // there), and this then clears the attribute exactly as it always did.
    wrap.setAttribute('transform', this._bodyTransform(s, motion, t, intensity));
  }

  /*
   * The body channel for this frame: sway, bob, lean and squash as ONE transform string.
   *
   * Returns '' whenever there is nothing to say — no pose, mode 'off', or a swatch predating
   * `pose.root` — and _applyLimbs then clears the wrap as before.
   *
   * Mode comes from data-body on the artwork, falling back to what the clip measured:
   * 'jump' when the capture's vertical dominates its horizontal, else 'dance'. That is a
   * measurement rather than a name match, so an object called anything at all gets the mode
   * its driving clip earns. See the BODY_* constants for what each channel is worth.
   */
  _bodyTransform(s, motion, t, intensity) {
    const wrap = s.wrap;
    const pose = this._poseFor(motion);
    if (!pose) return '';
    const declared = (wrap.dataset && wrap.dataset.body) || '';
    if (declared === 'off') return '';
    /*
     * OPTING IN, so that nothing already verified changes under it.
     *
     * Tilt and squash need no new extraction — they survive the hip anchoring and have been
     * present in every pose swatch ever written. That is exactly why this gate exists: were
     * the channel simply always on, every figure shipped before today would silently start
     * leaning and squashing, and the reference boy and girl were measured without it.
     *
     * So the body channel runs when the swatch carries `root` — the marker of an extraction
     * that kept the translation — or when the artwork asks for it by name. An older swatch
     * with no data-body animates byte for byte as it did before.
     */
    if (!Array.isArray(pose.root) && !(declared === 'dance' || declared === 'jump')) return '';

    if (!s._body || s._bodyMotion !== motion.id || s._bodyMode !== declared) {
      const frames = pose.frames.filter(Boolean);
      const root = Array.isArray(pose.root) ? pose.root : null;
      const jn = {}; (pose.joints || []).forEach((n, i) => jn[n] = i);
      const mid = (f, a, b) => {
        const p = f[jn[a]], q = f[jn[b]];
        return (p && q) ? [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2, Math.min(p[2], q[2])] : null;
      };

      // Tilt and squash survive the hip anchoring, so they come from `frames` and are
      // available on every swatch ever shipped. Tilt is folded to +-90: a shoulder line is a
      // line, so 179deg and -1deg are the same lean and only a fold keeps the track
      // continuous instead of flipping 358deg whenever the subject squares up to the camera.
      const tilt = [], torso = [];
      for (const f of frames) {
        const sh = mid(f, 'l_sho', 'r_sho'), hp = mid(f, 'l_hip', 'r_hip');
        const ls = f[jn['l_sho']], rs = f[jn['r_sho']];
        if (ls && rs && Math.min(ls[2], rs[2]) >= LIMB_VIS_OK) {
          const a = Math.atan2(rs[1] - ls[1], rs[0] - ls[0]) * 180 / Math.PI;
          tilt.push(((a + 90) % 180 + 180) % 180 - 90);
        } else tilt.push(null);
        torso.push((sh && hp && Math.min(sh[2], hp[2]) >= LIMB_VIS_OK)
          ? Math.hypot(sh[0] - hp[0], sh[1] - hp[1]) : null);
      }
      const med = (v) => {
        const g = v.filter(x => x != null).sort((a, b) => a - b);
        return g.length ? g[Math.floor(g.length / 2)] : 0;
      };
      const t0 = med(torso);
      // Tilt about its own median, not about zero: a subject filmed slightly off-square has a
      // standing lean, and treating that as motion would hold the drawing permanently askew.
      const tiltMid = med(tilt);
      const hold = (v, fb) => {                 // carry the last believed value across gates
        let last = fb; return v.map(x => (x == null ? last : (last = x)));
      };
      const tiltTrack = hold(tilt.map(x => x == null ? null : x - tiltMid), 0);
      const squashTrack = hold(torso.map(x => (x == null || !t0) ? null : x / t0 - 1), 0);
      const sway = root ? root.map(r => (r ? r[0] : 0)) : null;
      const bob = root ? root.map(r => (r ? r[1] : 0)) : null;

      // Which mode the CLIP earns, when the artwork has not declared one. A hop is vertical:
      // its bob outruns its sway. The dance measures 0.1408 x against 0.0321 y, so it fails
      // this and is a dance, which is what it is.
      const rangeOf = (v) => (v && v.length) ? Math.max(...v) - Math.min(...v) : 0;
      const auto = (rangeOf(bob) > rangeOf(sway)) ? 'jump' : 'dance';
      const mode = (declared === 'dance' || declared === 'jump') ? declared : auto;

      // The figure's own size sets the scale, and its base is what it pivots and stands on:
      // a body leans and lands about its feet, not about its middle. Read once — getBBox is
      // measured before any body transform is written, so it is the untransformed art.
      let bb = null; try { bb = wrap.getBBox(); } catch (_) { bb = null; }
      const h = (bb && bb.height) || 0;
      s._body = {
        mode, fps: pose.fps || 15, n: (sway || tiltTrack).length,
        sway, bob, tilt: tiltTrack, squash: squashTrack, h,
        bx: bb ? bb.x + bb.width / 2 : 0, by: bb ? bb.y + bb.height : 0,
        // Whether the translation channels are real or absent, so the inspector can say
        // "sway unavailable (swatch predates pose.root)" instead of showing a silent zero.
        hasRoot: !!root,
      };
      s._bodyMotion = motion.id;
      s._bodyMode = declared;
    }

    const B = s._body;
    if (!B.n || !B.h) return '';
    const { i0, f: ft } = framePos(t, B.fps, B.n);
    const at = (track) => {
      if (!track) return 0;
      const a = track[i0] || 0, b = track[(i0 + 1) % B.n] || 0;
      return a + (b - a) * ft;
    };
    const clamp = (v, m) => Math.max(-m, Math.min(m, v));

    let dx = 0, dy = 0, rot = 0, sx = 1, sy = 1;
    if (B.mode === 'jump') {
      // Vertical only. Screen y grows downward, so a NEGATIVE dy is a rise, and the squash is
      // opposed to it: tallest at the top of the arc, flattest at the bottom.
      const up = -at(B.bob) * B.h * BODY_JUMP_GAIN * intensity;
      dy = up;
      const k = clamp((up / B.h) * (BODY_JUMP_SQUASH / 0.05), BODY_JUMP_SQUASH);
      sy = 1 + k; sx = 1 - k;
    } else {
      dx = at(B.sway) * B.h * BODY_SWAY_GAIN * intensity;
      dy = at(B.bob) * B.h * BODY_BOB_GAIN * intensity;
      rot = clamp(at(B.tilt) * BODY_TILT_GAIN * intensity, BODY_TILT_MAX);
      const k = clamp(at(B.squash) * BODY_SQUASH_GAIN * intensity, BODY_SQUASH_MAX);
      sy = 1 + k; sx = 1 - k;                  // volume-ish: widen as it shortens
    }

    // Right to left: move to the base, lean and squash there, come back, then translate.
    const p = (v) => v.toFixed(2);
    return `translate(${p(dx)} ${p(dy)}) translate(${p(B.bx)} ${p(B.by)}) `
         + `rotate(${p(rot)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) `
         + `translate(${p(-B.bx)} ${p(-B.by)})`;
  }

  _applyWings(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._wing || s._wingMotion !== motion.id) {
      const pose = this._poseFor(motion);
      const frames = pose.frames.filter(Boolean);
      const jn = {}; pose.joints.forEach((n, i) => jn[n] = i);
      const raw = frames.map(f => {
        const shoY = (f[jn.l_sho][1] + f[jn.r_sho][1]) / 2;
        const hipY = (f[jn.l_hip][1] + f[jn.r_hip][1]) / 2;
        const wriY = (f[jn.l_wri][1] + f[jn.r_wri][1]) / 2;
        return (shoY - wriY) / Math.max(1e-3, Math.abs(shoY - hipY));   // + = wrists up
      });
      // Map the clip's own measured range onto the full wing sweep.
      //
      // BE CLEAR ABOUT WHAT THIS DISCARDS: the TIMING and SHAPE below are the
      // subject's, but the AMPLITUDE is not — min becomes -1 and max becomes +1
      // whatever the real range was, so a subject who barely lifts their wrists
      // drives the same 26deg sweep as one flapping hard. That is a deliberate
      // presentation choice (a bird whose wings twitch 2deg reads as broken, not
      // as subtle), not a measurement. If per-clip flap DEPTH should carry through,
      // scale MAX_DEG by (hi - lo) here instead of normalizing it away.
      const lo = Math.min(...raw), hi = Math.max(...raw);
      const span = Math.max(1e-3, hi - lo);
      const up = raw.map(v => (v - lo) / span * 2 - 1);                 // -1..+1
      const bbOf = el => { try { return el.getBBox(); } catch (_) { return null; } };
      // Every tagged body in this region, with its centre. A region can hold a WHOLE
      // FLOCK (one selection over a group of birds), so a single reference body is not
      // enough: pairing every wing to the first one puts the far birds' pivots out on
      // their own wingtips, and they rotate about the wrong end.
      // An explicit hinge, when the artwork knows better than the geometry can show.
      // `data-pivot="x y"` in the SVG's own user units. This exists because getBBox()
      // IGNORES clip-path: a wing built by clipping a copy of the whole subject (the
      // only way to rig art whose wings are not separate shapes) reports the subject's
      // full box, so the clamp below would put every pivot at the subject's centre
      // rather than at its shoulder. Absent the attribute, nothing changes.
      const pivotAttr = (el) => {
        const v = el && el.dataset && el.dataset.pivot;
        if (!v) return null;
        const m = v.trim().split(/[\s,]+/).map(Number);
        return (m.length === 2 && m.every(Number.isFinite)) ? { cx: m[0], cy: m[1] } : null;
      };
      const bodies = [];
      for (const el of wrap.querySelectorAll('[data-role="wing-body"]')) {
        const b = bbOf(el);
        const pv = pivotAttr(el);
        if (el.dataset.wingNeutral == null) el.dataset.wingNeutral = el.getAttribute('transform') || '';
        bodies.push({ el, neutral: el.dataset.wingNeutral, bb: b, pivot: pv,
          cx: pv ? pv.cx : (b ? b.x + b.width / 2 : 0),
          cy: pv ? pv.cy : (b ? b.y + b.height / 2 : 0) });
      }
      const fb = bbOf(wrap) || { x: 0, y: 0, width: 1, height: 1 };
      // No tagged body at all: fall back to the region's own centre, as before.
      const fallback = { cx: fb.x + fb.width / 2, cy: fb.y + fb.height / 2, bb: fb };
      const nearestBody = (b) => {
        if (!bodies.length) return fallback;
        const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
        let best = null, bd = Infinity;
        for (const bo of bodies) {
          const d = (bo.cx - cx) ** 2 + (bo.cy - cy) ** 2;
          if (d < bd) { bd = d; best = bo; }
        }
        return best;
      };
      const wings = [];
      for (const [role, sign] of [['wing-l', 1], ['wing-r', -1]]) {
        for (const el of wrap.querySelectorAll(`[data-role="${role}"]`)) {
          const b = bbOf(el);
          if (!b) continue;
          // Remember the artwork's own transform ON the element, so re-binding a
          // motion can never stack our rotate() on top of a previous one.
          if (el.dataset.wingNeutral == null) el.dataset.wingNeutral = el.getAttribute('transform') || '';
          // The wing ROOT, in order of trust: this wing's own declared pivot, then its
          // body's declared pivot (used verbatim — a declared hinge is not clamped, or
          // clipped art would snap back to the box centre), then the geometric guess:
          // clamp its own body's centre into the wing's box. A wing reaches AWAY from
          // the body, so that guess lands on its shoulder edge.
          const own = pivotAttr(el), bo = nearestBody(b);
          const pv = own || bo.pivot;
          wings.push({ el, sign, neutral: el.dataset.wingNeutral,
            px: pv ? pv.cx : Math.max(b.x, Math.min(b.x + b.width, bo.cx)),
            py: pv ? pv.cy : Math.max(b.y, Math.min(b.y + b.height, bo.cy)) });
        }
      }
      // Bob is per-body and scaled by that body's OWN height — one region holding a
      // flock of differently-sized birds must not bob them all by the big one's amount.
      s._wing = { up, fps: pose.fps || 15, wings,
        bodies: bodies.map(bo => ({ el: bo.el, neutral: bo.neutral,
          bob: (bo.bb ? bo.bb.height : fb.height) * 0.06 })),
        bob: fb.height * 0.02 };
      s._wingMotion = motion.id;
    }
    const w = s._wing, n = w.up.length;
    if (!n || !w.wings.length) return;
    // Between captured frames, not at the nearest one — see framePos. `up` is a normalized
    // -1..+1 scalar, so a plain lerp is right; nothing here wraps.
    const wp = framePos(t, w.fps, n);
    const u = lerp(w.up[wp.i0], w.up[wp.i1], wp.f);
    // 26 deg of sweep at full intensity. A positive rotate() is clockwise on screen,
    // which LIFTS a wing reaching up-left and DROPS one reaching up-right — hence the
    // mirrored sign per side, so both wings rise together.
    const ang = u * 26 * intensity;
    for (const g of w.wings) {
      g.el.setAttribute('transform', `${g.neutral ? g.neutral + ' ' : ''}` +
        `rotate(${(ang * g.sign).toFixed(2)} ${g.px.toFixed(1)} ${g.py.toFixed(1)})`);
    }
    // A real bird rises on the DOWNstroke, so the body sinks as the wings come up.
    for (const bd of w.bodies) {
      const dy = u * (bd.bob != null ? bd.bob : w.bob) * intensity;
      bd.el.setAttribute('transform',
        `${bd.neutral ? bd.neutral + ' ' : ''}translate(0 ${dy.toFixed(2)})`);
    }
    wrap.setAttribute('transform', '');
  }

  /*
   * Character / skeletal motion. The swatch carries a captured pose sequence
   * (motion.pose = {joints, fps, frames}) from MediaPipe. Drive a rigged
   * character in the artwork: reposition its two legs (hip→knee→ankle) from the
   * captured joints, and bob/tilt the body + head. The rig is drawn in a local
   * frame centred on the body, so this math is position-independent.
   */
  _applyCharacter(s, motion, t, intensity) {
    const wrap = s.wrap;
    if (!s._char || s._charMotion !== motion.id) {
      const q = r => wrap.querySelector(`[data-role="${r}"]`);
      const rigEl = wrap.querySelector('[data-leg], [data-char-mode]');
      const pose = this._poseFor(motion);
      const frames = pose.frames.filter(Boolean);
      const jn = {}; pose.joints.forEach((n, i) => jn[n] = i);
      // mean hip / nose Y to centre the vertical bob
      let sh = 0, sn = 0;
      for (const f of frames) { sh += (f[jn.l_hip][1] + f[jn.r_hip][1]) / 2; sn += f[jn.nose][1]; }
      let bb; try { bb = wrap.getBBox(); } catch (_) { bb = { x: 0, y: 0, width: 1, height: 1 }; }
      s._char = {
        frames, jn, fps: pose.fps || 15,
        meanHipY: sh / frames.length, meanNoseY: sn / frames.length,
        leg: parseFloat(rigEl && rigEl.getAttribute('data-leg')) || 150,
        // whole-body puppet mode when the artwork can't be split into limbs
        puppet: (rigEl && rigEl.getAttribute('data-char-mode') === 'puppet'),
        pivotX: bb.x + bb.width / 2, pivotY: bb.y + bb.height,   // feet (bottom-centre)
        legFar: q('leg-far'), footFar: q('foot-far'),
        legNear: q('leg-near'), footNear: q('foot-near'),
        body: q('body'), head: q('head'),
      };
      // remember neutral geometry so pause/reset restores the standing pose
      const cc = s._char;
      cc.neutral = [cc.legFar, cc.legNear, cc.footFar, cc.footNear, cc.body, cc.head]
        .filter(Boolean).map(el => ({ el,
          points: el.getAttribute('points'), transform: el.getAttribute('transform'),
          cx: el.getAttribute('cx'), cy: el.getAttribute('cy') }));
      s._charMotion = motion.id;
    }
    const c = s._char, jn = c.jn, F = c.frames, n = F.length;
    if (!n) { return; }
    // Between captured frames, not at the nearest one — see framePos. Blend joint by joint:
    // these are POSITIONS in a normalized frame, so a plain lerp is right. A midpoint of two
    // captured joints is not an invented joint — it is where the joint was on its way between
    // two things the capture actually saw.
    const cp = framePos(t, c.fps, n);
    const A = F[cp.i0], B = F[cp.i1];
    const f = A.map((p, j) => [lerp(p[0], B[j][0], cp.f), lerp(p[1], B[j][1], cp.f)]);
    const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    const hipC = mid(f[jn.l_hip], f[jn.r_hip]);
    const shoC = mid(f[jn.l_sho], f[jn.r_sho]);
    const nose = f[jn.nose];

    // ---- WHOLE-BODY PUPPET (flat art that can't be split into limbs) ----
    // Drive the whole figure with the captured gait: bounce (hips rise/fall),
    // weight-shift sway (toward the planted foot), a small lean, and a squash
    // on each footfall. Reads as a lively march/step-in-place.
    if (c.puppet || !c.body) {
      const bounce = -(hipC[1] - c.meanHipY) * 260 * intensity;              // up when hips rise
      const sway = (f[jn.r_ank][1] - f[jn.l_ank][1]) * 130 * intensity;      // toward planted foot
      const lean = sway * 0.06;                                             // lean into the step (deg)
      const down = Math.max(0, (hipC[1] - c.meanHipY)) * 6;                  // 0..~1 at footfall
      const sy = 1 - Math.min(0.06, down * 0.06) * intensity;
      const sx = 1 + Math.min(0.06, down * 0.06) * intensity;
      const px = c.pivotX, py = c.pivotY;
      wrap.setAttribute('transform',
        `translate(${sway.toFixed(2)} ${bounce.toFixed(2)}) ` +
        `rotate(${lean.toFixed(2)} ${px.toFixed(1)} ${py.toFixed(1)}) ` +
        `translate(${px.toFixed(1)} ${py.toFixed(1)}) scale(${sx.toFixed(4)} ${sy.toFixed(4)}) ` +
        `translate(${(-px).toFixed(1)} ${(-py).toFixed(1)})`);
      return;
    }

    const bob = (hipC[1] - c.meanHipY) * 150 * intensity;
    const tiltDeg = Math.atan2(shoC[1] - hipC[1], (shoC[0] - hipC[0]) || 1e-3) * 180 / Math.PI * 0.12 - 10.8;
    c.body.setAttribute('transform', `translate(0 ${bob.toFixed(2)}) rotate(${tiltDeg.toFixed(2)})`);
    if (c.head) {
      const hy = -64 + bob + (nose[1] - c.meanNoseY) * 60;
      c.head.setAttribute('transform', `translate(96 ${hy.toFixed(2)})`);
    }
    const LEG = c.leg * (0.5 + 0.6 * intensity), hipY = bob + 52;
    const leg = (hip, knee, ank, anchorX, line, foot) => {
      const h = f[jn[hip]], k = f[jn[knee]], a = f[jn[ank]];
      const hx = anchorX, hy = hipY;
      const kx = hx + (k[0] - h[0]) * LEG, ky = hy + (k[1] - h[1]) * LEG;
      const ax = hx + (a[0] - h[0]) * LEG, ay = hy + (a[1] - h[1]) * LEG;
      if (line) line.setAttribute('points', `${hx},${hy} ${kx.toFixed(1)},${ky.toFixed(1)} ${ax.toFixed(1)},${ay.toFixed(1)}`);
      if (foot) { foot.setAttribute('cx', (ax + 8).toFixed(1)); foot.setAttribute('cy', (ay + 2).toFixed(1)); }
    };
    leg('r_hip', 'r_knee', 'r_ank', -14, c.legFar, c.footFar);
    leg('l_hip', 'l_knee', 'l_ank', 14, c.legNear, c.footNear);
  }

  _reset() {
    for (const s of this.sel.selections) this._resetOne(s);
    this.sel.syncHighlights();
  }

  // Undo every special-case animator's mutations on ONE selection, restoring
  // it to its original static form — shared by pause() (resets everything)
  // and "Remove motion" (resets just the one object), so removing a motion
  // always fully reverts it regardless of which animation path it used.
  _resetOne(s) {
    s._routeT0 = null;              // next play starts the journey from the route's start
    if (s._treeLeaves) {
      s._treeLeaves.el.removeAttribute('transform');
      s._treeLeaves = null;
    }
    if (s._leaves) {
      for (const lf of s._leaves) { lf.el.removeAttribute('transform'); lf.el.style.opacity = ''; }
    }
    if (s._char) {
      for (const o of s._char.neutral || []) {
        if (o.points != null) o.el.setAttribute('points', o.points); else o.el.removeAttribute('points');
        if (o.transform != null) o.el.setAttribute('transform', o.transform); else o.el.removeAttribute('transform');
        if (o.cx != null) o.el.setAttribute('cx', o.cx);
        if (o.cy != null) o.el.setAttribute('cy', o.cy);
      }
      s._char = null; s._charMotion = null;
    }
    // Limb rig: put back the transform the ARTWORK carried, not nothing — an Illustrator
    // group may legitimately have its own transform, and removing it would move the limb.
    if (s._limb) {
      for (const g of s._limb.limbs) {
        if (g.neutral) g.el.setAttribute('transform', g.neutral);
        else g.el.removeAttribute('transform');
      }
      s._limb = null; s._limbMotion = null; s._limbRetarget = null;
    }
    // Same for wings, which previously kept their last rotation after a stop.
    if (s._wing) {
      for (const g of [...s._wing.wings, ...s._wing.bodies]) {
        if (g.neutral) g.el.setAttribute('transform', g.neutral);
        else g.el.removeAttribute('transform');
      }
      s._wing = null; s._wingMotion = null;
    }
    if (s._birds) { for (const bd of s._birds) { bd.el.removeAttribute('transform'); bd.el.style.opacity = ''; } s._birds = null; s._birdsMotion = null; }
    if (s._clouds) { for (const cd of s._clouds) cd.el.removeAttribute('transform'); s._clouds = null; s._cloudsMotion = null; }
    // Step 8 flock: room was measured from each member's bbox, so it must be
    // re-measured on the next play rather than reused after the artwork moved
    if (s._flock) { for (const fd of s._flock) fd.el.removeAttribute('transform'); s._flock = null; s._flockMotion = null; }
    if (s.kind === 'svg' && s.wrap) {
      s.wrap.setAttribute('transform', '');
      // restore pristine geometry for wave-deformed paths, and clear any
      // per-path transform used to ride detail elements (e.g. flag chakra)
      for (const el of s.wrap.querySelectorAll('path[data-ms-d0]')) {
        el.setAttribute('d', el.getAttribute('data-ms-d0'));
        el.removeAttribute('transform');
      }
      s._wave = null;
      s._warp = null;                            // coordinate-warp path cache (cloth/fluid)
      s._skirt = null; s._skirtMotion = null;   // curated skirt sway (coordinate warp)
      s._river = null;
      s._boat = null;
      s._path = null; s._pathMotion = null;     // Step 5 travel path (room is re-measured)
      s._field = undefined;
      s._fieldMotion = null;
      // Step 8 mesh warp: its lattice is anchored to the object's bbox, which the
      // restored geometry above has just changed back
      s._mesh = null; s._meshMotion = null; s._meshAnchor = null;
      // reset per-glyph transforms (glyph split itself is kept — harmless)
      if (s._text) {
        for (const it of s._text.items) it.el.removeAttribute('transform');
        s._text = undefined;
      }
    } else if (s.floatEl) s.floatEl.style.transform = '';
  }
}

window.Animator = Animator;

