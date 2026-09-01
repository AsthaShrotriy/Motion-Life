/* upload.js — the video-upload pipeline: VLM classify -> route -> extract -> apply.
   Handles character (MediaPipe), multi-motion (bbox-localized per detected motion), and
   single-motion RAFT capture. Every path here decides what to do from what the ROUTER
   saw in the clip; nothing branches on the filename. (Step 10 removed the last one: a
   /leaf|autumn/ filename test that replaced the extraction with a hand-written fall.)
   Exposed as window.handleMotionUpload; main.js wires it to the #motion-input change
   event. main.js is IIFE-wrapped, so its symbols are NOT globals — it hands them across
   via window.__mlUpload, which we destructure at call time (not load time). */
// Distinct, high-contrast colors so several motions from ONE clip read apart —
// both in the multi-motion extraction reveal and as their saved library chips.
// Cycled by extraction order.
const MULTI_MOTION_COLORS = ['#7c6cff', '#34d399', '#ff8a4c', '#ff5c8a', '#3bc9ff', '#ffd166'];

/* BUILDER-FACING COPY AND CONTROLS, off by default.
   Covers the ⚠ "no walk cycle in this clip" and ℹ "stride is along the camera axis" notes
   the pose service measures per clip, and the Rest pose (retarget) row in the inspector.
   All of it is for whoever is BUILDING with this tool, not for an audience watching it.
   Nothing is discarded or disabled: the full measured note is always logged to the console,
   `gait` still travels on the swatch and still steers the rig, retargeting still runs at its
   default, and `?diag=1` (or window.__msDiag = true) puts every piece back on screen.
   Exposed on window because main.js is a separate IIFE and gates its own rows with it. */
const DIAG = (() => {
  try { return new URLSearchParams(location.search).get('diag') === '1'; }
  catch (_) { return false; }
})();
const showDiag = () => DIAG || window.__msDiag === true;
window.__msShowDiag = showDiag;

window.handleMotionUpload = async (e) => {
  // main.js is a separate IIFE-wrapped script; grab the shared helpers it exposes.
  const { $, status, capture, library, sel, renderMotionList, addVideoThumb,
          showInspector, applyMotionToActive, autoApplyMotions } = window.__mlUpload;
  const file = e.target.files[0]; if (!file) return;

  // show the clip in the Videos section
  const videoUrl = URL.createObjectURL(file);
  const videoRec = addVideoThumb(videoUrl, file.name.replace(/\.[^.]+$/, ''));

  // Open the live extraction overlay right now — it stays up until extraction is done,
  // playing the clip and drawing each motion field the moment it lands. `say()` mirrors
  // a message to both the overlay's status pill and the panel's status line.
  const reveal = window.startExtractionReveal ? window.startExtractionReveal(videoUrl) : null;
  const say = (t) => { $('upload-status').textContent = t; if (reveal) reveal.setStatus(t); };

  // Every tag the animator will actually take a pose branch on — kept in step with the three
  // gates at the top of Animator._applyOne (data-limb, then the wing pair, then the character
  // rig). It used to list only the last of the three, so a LIMB-rigged figure like the girl
  // scene was reported as "not rigged → whole-body puppet" while the animator was in fact
  // rotating her seven tagged limbs. The animation was right and the sentence describing it
  // was wrong, which is the worse of the two failures to leave in place. The same predicate
  // also picks the upload's target, so a limb rig in the scene is now found rather than
  // skipped over.
  const RIG_TAGS = '[data-limb], [data-role="wing-l"], [data-role="wing-r"],' +
                   '[data-motion-mode="character"], [data-role="body"]';
  const wrapIsRig = (w) => w && ((w.matches && w.matches(RIG_TAGS)) || w.querySelector(RIG_TAGS));

  // ===== VLM AUTO-ROUTE ==========================================================
  // The router LOOKS AT THE CLIP and picks the extractor — you don't declare the type.
  //   articulated (a body) -> MediaPipe skeleton   ·   everything else -> RAFT texture
  // If the router is down/unauthed it falls back to the manual selection heuristic.
  let routed = null, allMotions = [], routerErr = null;
  // Two attempts, because the failure this guards against is TRANSIENT: the router is a
  // plain HTTPServer in front of Bedrock, and Bedrock answers 503 "unable to process your
  // request" under load. One 503 used to be indistinguishable from "no router", which sent
  // a dance clip down the texture path. A second try costs one round-trip and recovers it.
  for (let attempt = 0; attempt < 2 && !routed; attempt++) {
    try {
      $('upload-status').textContent = attempt
        ? 'Router busy (503) — retrying…' : 'Reading the clip with the VLM router…';
      const contract = await capture.decomposeMotion(file);
      if (contract && !contract.static && contract.motions && contract.motions.length) {
        allMotions = contract.motions.slice().sort((a, b) => b.confidence - a.confidence);
        routed = allMotions[0];
        routerErr = null;
      } else if (contract && contract.static) {
        break;                                  // a real reading: the clip is static
      } else {
        routerErr = capture.lastError || 'router returned no motions';
      }
    } catch (err) {
      // NOT swallowed. This catch used to be `catch (_) {}`, so an unreachable or 503-ing
      // router was silently identical to a router that had looked at the clip and said
      // "texture" — and the whole upload then took the texture path with no trace on screen
      // of the one thing that had actually failed.
      routerErr = (err && err.message) || String(err);
    }
  }
  if (routerErr) console.warn('[upload] VLM router unavailable:', routerErr);

  const act0 = sel.getActive();
  const manualRig = act0 && act0.kind === 'svg' && wrapIsRig(act0.wrap);
  // EVERY rig tag, not just data-motion-mode="character". This lookup is the only thing
  // standing between a rigged scene and a silent drop to RAFT when the router is down, and
  // for a data-limb scene (the girl, the station) it could never match, so the confirm below
  // never fired and the figure got a texture swatch: a whole-figure 1s bob where limbs
  // should have articulated on the clip's own period. Measured on scene2-station with the
  // router forced to 503 — no dialog, "2 motions detected", library empty of any skeleton.
  const sceneRig = document.querySelector('#artwork-container ' +
                     RIG_TAGS.split(',').map(s => s.trim()).join(', #artwork-container '));
  let wantCharacter;
  if (routed) {
    wantCharacter = (routed.class === 'articulated');
    $('upload-status').textContent =
      `VLM detected: ${routed.label} → ${routed.class} (${Math.round(routed.confidence * 100)}%) · ` +
      (wantCharacter ? 'MediaPipe' : 'RAFT');
  } else {
    // router unavailable → previous manual behavior (selection-based), with the
    // footgun confirm so a character scene never silently falls through to RAFT.
    wantCharacter = manualRig;
    if (!wantCharacter && sceneRig) {
      const why = `Router unavailable (${routerErr || 'no reading'}).`;
      // Name the FIGURE, not the tagged part. sceneRig is whichever rig tag matched first, and
      // for a limb rig that is a leaf like "Left Leg" — offering to drive a leg reads as a bug.
      const figName = (el) => {
        let cur = el;
        while (cur && cur.nodeType === 1 && cur.id !== 'artwork-container') {
          if (!cur.getAttribute('data-limb') && (cur.getAttribute('data-name') || cur.id))
            return cur.getAttribute('data-name') || cur.id;
          cur = cur.parentNode;
        }
        return 'the rigged figure';
      };
      const rigName = figName(sceneRig);
      const goChar = confirm(
        act0 ? `${why} "${act0.name}" is not a rigged figure.\n\nOK = BODY motion (MediaPipe) for ${rigName}.\nCancel = TEXTURE motion (RAFT) for "${act0.name}".`
             : `${why} This artwork has a rig (${rigName}).\n\nExtract BODY motion (MediaPipe) for it?\n\nOK = rigged figure   ·   Cancel = abort`);
      if (goChar) wantCharacter = true;
      else if (!act0) { if (reveal) reveal.close(); $('upload-status').textContent = 'Cancelled. Select an object first, then upload.'; e.target.value = ''; return; }
    }
  }

  // ===== CHARACTER (MediaPipe skeleton) =====
  if (wantCharacter) {
    // The swatch is created regardless of a target — applying it is a separate step.
    // Optional target: the selected rig, else any rig in the scene, else the selected
    // object as a whole-body puppet, else none (swatch just goes to the library).
    let target = manualRig ? act0 : (sel.selections && sel.selections.find(s => wrapIsRig(s.wrap)));
    if (target && target !== act0) { sel.selectByIndex(sel.selections.indexOf(target)); showInspector(target); }
    if (!target) target = act0;   // may be null — that's fine
    const rigged = target && wrapIsRig(target.wrap);
    say('Extracting body motion with MediaPipe…' +
      (target && !rigged ? ` (${target.name} isn't rigged → whole-body puppet)` : ''));
    try {
      // (Step 7) fmt=swatch: one request gives BOTH the unified Contract-B swatch (for the
      // library) and, nested under .pose, the same {joints,fps,frames,detected,total} the
      // rig has always consumed. Verified byte-identical on walk-man.mp4; where they differ
      // it is because fmt=swatch gap-fills frames the detector missed, which the rig wants.
      const sw = await capture.captureCharacter(file, 'pose', 'swatch');
      // character motion has no trajectory field to draw — close the overlay now that
      // extraction has returned (before the skeleton view takes over).
      if (reveal) reveal.finish();
      const pose = sw && (sw.pose || sw);          // tolerate a legacy response
      if (!pose || !pose.detected) {
        $('upload-status').textContent = 'No person detected — use a clear, full-body clip.';
        e.target.value = ''; return;
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'Character Motion';
      // Did the clip actually contain a walk cycle? pose_server measures this (see
      // _gait_coherence) because the rig cannot: a track of detection jitter is still a
      // track, so a clip filmed head-on animates as convincingly-shaped nonsense and looks
      // like a broken animator. `gait` is absent on older responses — no warning then, not
      // a false all-clear.
      const gait = pose.gait && typeof pose.gait === 'object' ? pose.gait : null;
      const noGait = gait && gait.walkable === false ? gait : null;
      const motion = {
        id: 'char-' + Date.now(), name,
        desc: `Character motion · MediaPipe (${pose.detected}/${pose.total} frames)`
              + (noGait && showDiag() ? `\n⚠ ${noGait.note}` : ''),
        color: '#34d399', character: true,
        // `gait` travels WITH the pose, not just into the warning text above: it carries
        // stride_axis, which tells the rig whether this clip's stride is across the picture
        // or along the camera axis. Dropping it here silently sent every head-on walk down
        // the picture-plane path, where its legs swing 4deg instead of 52deg.
        pose: { joints: pose.joints, fps: pose.fps, frames: pose.frames.filter(Boolean),
                gait },
        params: { frequency: 1, amplitude: 0.2, direction: 0, turbulence: 0, damping: 0, phaseSpread: 0 },
        videoUrl, fromUpload: true, engine: 'mediapipe',
        swatches: sw && sw.kind === 'skeleton' ? [sw] : [],
      };
      library.add(motion); videoRec.motionIds = [motion.id]; renderMotionList();
      library.select(motion.id);
      if (window.showSkeleton) { try { await window.showSkeleton(videoUrl, motion.pose, motion.color); } catch (_) {} }
      if (target) {
        applyMotionToActive();
        $('upload-status').textContent = `Added "${name}" → driving ${target.name}` + (rigged ? '.' : ' (puppet — object not rigged).');
        status(`Character motion "${name}" captured (MediaPipe) — driving ${target.name}.`, true);
      } else {
        $('upload-status').textContent = `Added "${name}" — click an object to apply it.`;
        status(`Character motion "${name}" captured (MediaPipe). Click an object to apply it.`, true);
      }
      if (noGait) {
        // Logged unconditionally — the measurement is the whole reason the service computes
        // it, and losing it would leave a clip that animates like a broken animator with no
        // explanation anywhere. On screen only under ?diag=1, and said LAST there so it is
        // what stays up: the capture succeeded, and what it captured is not a walk. Not
        // flashed as success, and it reports the measurement rather than judging the clip.
        console.warn(`[motion] "${name}": no walk cycle recoverable — ${noGait.note}`);
        if (showDiag()) {
          $('upload-status').textContent += `\n⚠ ${noGait.note}`;
          status(`⚠ "${name}": no walk cycle in this clip (foot gap ${noGait.foot_gap}, `
                 + `repeat ${noGait.periodicity}) — the rig has jitter to replay, not a stride.`);
        }
      } else if (gait && gait.stride_axis === 'depth') {
        // Not a warning — this clip DID yield a walk. But it came off the depth channel,
        // which MediaPipe estimates less precisely than position, so say so rather than let
        // a coarser stride read as the best the extractor can do.
        console.info(`[motion] "${name}": stride along the camera axis — ${gait.note}`);
        if (showDiag()) {
          $('upload-status').textContent += `\nℹ ${gait.note}`;
          status(`"${name}": stride is along the camera axis — legs driven from depth `
                 + `(feet part ${gait.depth_gap} in depth vs ${gait.foot_gap} sideways). `
                 + `A SIDE-ON clip gives a cleaner stride.`);
        }
      }
    } catch (err) {
      if (reveal) reveal.finish();
      $('upload-status').textContent = 'Pose service unreachable. Start it: service/pose_server.py (port 8770).';
    }
    e.target.value = ''; return;
  }
  // else: TEXTURE — fall through to the RAFT paths below.

  /* (Step 10) WHAT USED TO BE HERE, AND WHY IT IS GONE.
   * A `/leaf|leaves|falling|autumn/i.test(file.name)` branch used to intercept the upload,
   * play the extraction overlay over the real video, and then hand back trajectories from
   * `synthFallTrajectories()` — a hand-written spiral — plus eight hand-tuned dials, all
   * labelled "Captured from falling-leaves video". Nothing about the clip was measured; the
   * filename alone decided the animation, and the UI claimed otherwise.
   * A clip of falling leaves now goes down the same route as everything else: the VLM reads
   * it, the router picks an extractor, and whatever the flow field actually says becomes the
   * swatch. The hand-tuned leaf look survives ONLY as the `autumn-fall` PRESET in
   * js/motions.js, where it is presented as a preset and never as an extraction. */

  // MULTI-MOTION: the VLM found ≥2 distinct (non-body) motions in ONE clip → extract each
  // into its own swatch, bbox-localized to that motion's region and routed to its own engine.
  const textureMotions = allMotions.filter(m => m.class !== 'articulated').slice(0, 4);
  if (textureMotions.length >= 2) {
    const added = [], failed = [];
    for (let i = 0; i < textureMotions.length; i++) {
      const m = textureMotions[i];
      say(`Extracting ${i + 1}/${textureMotions.length}: ${m.label} (${m.class})…`);
      // per-region try/catch: the whole point of this branch is that one clip yields
      // SEVERAL swatches, so one region whose extractor is down (or whose mask came back
      // empty) must not throw away the regions that did extract. Failures are counted and
      // named in the status line rather than swallowed.
      try {
        const rt = await capture.route(m.class, { subject_type: m.subject_type, count: m.count });
        // preprocess:1 → object mask + camera motion, seeded by this motion's bbox
        // (the mask replaces the rectangular crop, so stats come from the object only)
        // cls: the VLM's class travels into the Contract-B swatch (Step 7) so Step 8's
        // applicator can route on it instead of on the layer's name.
        // depth:1 rides along with the mask — on a multi-motion clip it is the one signal
        // that says which region is in front of which (rank = fraction of the frame behind
        // the object), and it costs ~90ms because depth_summary samples 3 frames, not all.
        const opts = { bbox: m.bbox, preprocess: 1, depth: 1, cls: m.class };
        if (rt && rt.available) {
          if (rt.kind === 'flow' && rt.engine !== 'raft_small') opts.engine = rt.engine;
          else if (rt.kind === 'trajectory') opts.tracker = rt.engine;
          // deliberately NO path=1 here, unlike the single-motion branch below: the
          // path backend tracks the LONGEST track in the whole frame and takes no
          // bbox, so on a multi-motion clip it could return a different object's
          // travel than the region being extracted.
        }
        const sw = await capture.captureFromFile(file, opts);
        if (sw) {
          sw.name = m.label || m.class;
          sw.desc = `${m.class} · ${sw.desc}`;
          /* The class has to survive the FALLBACK too. `cls` above asks the service to
             stamp it into the Contract-B swatch, but captureFromFile drops to in-browser
             Lucas–Kanade whenever that call fails, and the LK result carries params and
             nothing else — no swatch, so no class for animator._classOf to find. The class
             is the ROUTER's reading of this region of the clip (Contract A), which is
             evidence either way, so carry it across explicitly. Without this a region whose
             extraction fell back was silently refused downstream ("motion has no class")
             and never landed on an object — measured in tests/step10-e2e.js when one of
             Autumn.mp4's two regions lost its service call to ERR_NO_BUFFER_SPACE.
             A swatch that already knows its own class keeps it: _classOf prefers
             swatches[].class over motion.class. */
          if (!sw.class) sw.class = m.class || '';
          // keep this motion's VLM region ([x,y,w,h] normalized) so the reveal can
          // draw its bounding box over the clip.
          sw.bbox = m.bbox;
          // distinct color per motion (index = position so far), assigned here so the
          // overlay can draw this field the moment it lands — one at a time, live.
          sw.color = MULTI_MOTION_COLORS[added.length % MULTI_MOTION_COLORS.length];
          if (reveal) reveal.addMotion({
            trajectories: sw.trajectories, color: sw.color,
            name: sw.name, engine: sw.engine, bbox: sw.bbox,
          });
          added.push(sw);
        } else failed.push(`${m.label || m.class} (no motion found)`);
      } catch (err) {
        console.warn(`[MotionLife] region "${m.label || m.class}" failed:`, err.message);
        failed.push(`${m.label || m.class} (${err.message})`);
      }
    }
    // extraction loop is done — colors/fields already streamed into the overlay live.
    // Closing it here (sweep + fade) marks "extraction complete"; the labelling step
    // below is a separate phase and runs while the overlay bows out.
    if (reveal) reveal.finish();
    if (added.length) {
      added.forEach(sw => library.add(sw));
      videoRec.motionIds = added.map(sw => sw.id);
      renderMotionList();
      const lost = failed.length ? ` · ${failed.length} failed: ${failed.join(', ')}` : '';
      $('upload-status').textContent =
        `Extracted ${added.length} motions${lost} — labelling the artwork…`;
      // (Step 10) END TO END: the swatches now know their CLASS, so ask the VLM what each
      // artwork layer depicts and put each swatch on the layer that matches its class. No
      // filename, no layer-name matching. If the router is down autoApplyMotions returns
      // nothing applied and we say so — the swatches are still in the library to drag by hand.
      const res = await autoApplyMotions(added);
      const nameOfId = new Map(added.map(s => [s.id, s.name]));
      const hit = (res && res.applied) || [], miss = (res && res.skipped) || [];
      if (hit.length) {
        const pairs = hit.map(p => `"${nameOfId.get(p.motionId) || p.motionId}" → ${p.layerLabel || p.layerId}`);
        $('upload-status').textContent =
          `Applied ${hit.length}/${added.length}: ${pairs.join(', ')}` +
          (miss.length ? ` · not placed: ${miss.map(s => `"${nameOfId.get(s.motionId) || s.motionId}" (${s.why})`).join(', ')}` : '') +
          lost;
        status(`One clip → ${hit.length} motion${hit.length > 1 ? 's' : ''} applied by what each layer IS, not what it is called.`, true);
      } else {
        $('upload-status').textContent =
          `Extracted ${added.length} motions: ${added.map(s => `"${s.name}"`).join(', ')}${lost} — ` +
          (res && res.reason ? res.reason + ' ' : '') + 'click one, then apply to an object.';
        status(`Extracted ${added.length} motions from one clip — apply each to its object.`, true);
      }
    } else {
      $('upload-status').textContent = 'Multi-motion extraction found nothing usable.' +
        (failed.length ? ` (${failed.join(', ')})` : '');
    }
    e.target.value = ''; return;
  }

  // AUTO-ROUTE: ask the service which extractor best fits the VLM-detected class
  // (cloth->SEA-RAFT, flock->CoTracker3, …). Falls back to raft_small if router is down.
  let routeOpts = {};
  if (routed) {
    // Step 2: mask the extraction to the detected object (seeded by its bbox) so the
    // background stops diluting the swatch. Falls back to full-frame if no mask is found.
    routeOpts.bbox = routed.bbox;
    routeOpts.preprocess = 1;
    routeOpts.depth = 1;               // Step 2: relative depth over the mask (3 frames)
    routeOpts.cls = routed.class;      // (Step 7) carried into the swatch for Step 8
    const rt = await capture.route(routed.class, { subject_type: routed.subject_type, count: routed.count });
    if (rt && rt.engine && rt.available) {
      if (rt.kind === 'flow' && rt.engine !== 'raft_small') routeOpts.engine = rt.engine;
      else if (rt.kind === 'trajectory') routeOpts.tracker = rt.engine;
      // (Step 5) ONE object travelling across the scene → also ask for its travel path,
      // which animate.js applies via _applyPathTravel. The flow/trajectory extraction
      // still runs: the path moves the object, the field supplies its internal motion.
      else if (rt.kind === 'object_path') routeOpts.path = 1;
      // name BOTH when a path is requested — raft_small still extracts the field
      const via = routeOpts.engine || routeOpts.tracker
        || (routeOpts.path ? `${rt.engine} + raft_small` : 'raft_small');
      say(`Routing ${routed.class} → ${via}…`);
      console.log(`[MotionLife] VLM: ${routed.label} → class=${routed.class} `
        + `subject=${routed.subject_type} count=${routed.count} → extractor=${via} (${rt.kind}); ${rt.reason}`);
    }
  }
  if (!routeOpts.engine && !routeOpts.tracker) {
    say('Extracting texture motion with RAFT (optical flow)…');
  }
  capture.onProgress = (p, msg) => {
    say(msg || `Analyzing… ${Math.round(p * 100)}%`);
  };
  try {
    const motion = await capture.captureFromFile(file, routeOpts);
    if (motion) {
      // MULTI-MOTION BRANCH: if the service segmented ≥2 distinct motions,
      // show the picker so the user names and chooses which to save. Each
      // chosen region becomes its own Motion in the library (the whole-frame
      // `motion` variable is discarded — its trajectories/params are the
      // blended average, not what the user wants).
      if (motion.regions && motion.regions.length >= 2 && window.showMultiPick) {
        // extraction produced regions; the picker takes over from here, so close the
        // live overlay first (no double modal).
        if (reveal) reveal.close();
        $('upload-status').textContent =
          `${motion.regions.length} motions detected — pick and name them.`;
        const picked = await showMultiPick(motion.videoUrl, motion.regions, {
          engine: motion.engine,
          framesAnalyzed: motion.framesAnalyzed,
          fps: motion.trajFps,
        });
        if (!picked.length) {
          // user cancelled or unchecked everything — release the shared
          // object URL and bail without adding anything
          URL.revokeObjectURL(motion.videoUrl);
          $('upload-status').textContent = 'No motions saved.';
        } else {
          for (const m of picked) library.add(m);
          videoRec.motionIds = picked.map(m => m.id);   // link the clip to all its motions
          renderMotionList();
          const names = picked.map(m => `"${m.name}"`).join(', ');
          $('upload-status').textContent =
            `Added ${picked.length} motion${picked.length > 1 ? 's' : ''}.`;
          status(`Added ${picked.length} motion${picked.length > 1 ? 's' : ''} — ${names}. Click one, then apply to an object.`, true);
        }
      } else {
        // SINGLE-MOTION PATH: hand the one extracted field to the live overlay so it
        // streaks over the clip, then close it. (This replaces the old post-extraction
        // showExtraction popup — same visual, now part of the upload-to-done overlay.)
        if (reveal) {
          if (motion.trajectories) reveal.addMotion({
            trajectories: motion.trajectories, color: motion.color,
            name: motion.name, engine: motion.engine, bbox: routed ? routed.bbox : null,
          });
          reveal.finish();
        }
        // same fallback gap as the multi-motion branch above: keep the router's class when
        // the extraction dropped to Lucas–Kanade, so Step 8 still dispatches on the class
        // rather than on the layer the user happens to click.
        if (routed && routed.class && !motion.class) motion.class = routed.class;
        library.add(motion); videoRec.motionIds = [motion.id]; renderMotionList();
        $('upload-status').textContent = `Added "${motion.name}"`;
        status(`Motion "${motion.name}" captured from video — click it, then apply to an object.`, true);
      }
    } else {
      $('upload-status').textContent = 'Could not extract motion (need more movement / a longer clip).';
    }
  } catch (err) {
    $('upload-status').textContent = 'Video error: ' + err.message;
  }
  if (reveal) reveal.finish();   // safety: close the overlay on any texture-path exit
  e.target.value = '';
};
