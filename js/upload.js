/* upload.js — the video-upload pipeline: VLM classify -> route -> extract -> apply.
   Handles character (MediaPipe), multi-motion (bbox-localized per detected motion), and
   single-motion RAFT capture. Every path here decides what to do from what the ROUTER
   saw in the clip; nothing branches on the filename. (Step 10 removed the last one: a
   /leaf|autumn/ filename test that replaced the extraction with a hand-written fall.)
   Exposed as window.handleMotionUpload; main.js wires it to the #motion-input change
   event. main.js is IIFE-wrapped, so its symbols are NOT globals — it hands them across
   via window.__mlUpload, which we destructure at call time (not load time). */
window.handleMotionUpload = async (e) => {
  // main.js is a separate IIFE-wrapped script; grab the shared helpers it exposes.
  const { $, status, capture, library, sel, renderMotionList, addVideoThumb,
          showInspector, applyMotionToActive, autoApplyMotions } = window.__mlUpload;
  const file = e.target.files[0]; if (!file) return;

  // show the clip in the Videos section
  const videoUrl = URL.createObjectURL(file);
  const videoRec = addVideoThumb(videoUrl, file.name.replace(/\.[^.]+$/, ''));

  const wrapIsRig = (w) => w && ((w.matches && w.matches('[data-motion-mode="character"]')) ||
                                 w.querySelector('[data-motion-mode="character"], [data-role="body"]'));

  // ===== VLM AUTO-ROUTE ==========================================================
  // The router LOOKS AT THE CLIP and picks the extractor — you don't declare the type.
  //   articulated (a body) -> MediaPipe skeleton   ·   everything else -> RAFT texture
  // If the router is down/unauthed it falls back to the manual selection heuristic.
  let routed = null, allMotions = [];
  try {
    $('upload-status').textContent = 'Reading the clip with the VLM router…';
    const contract = await capture.decomposeMotion(file);
    if (contract && !contract.static && contract.motions && contract.motions.length) {
      allMotions = contract.motions.slice().sort((a, b) => b.confidence - a.confidence);
      routed = allMotions[0];
    }
  } catch (_) {}

  const act0 = sel.getActive();
  const manualRig = act0 && act0.kind === 'svg' && wrapIsRig(act0.wrap);
  const sceneRig = document.querySelector('#artwork-container [data-motion-mode="character"]');
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
      const goChar = confirm(
        act0 ? `Router offline. "${act0.name}" is not the character.\n\nOK = BODY motion (MediaPipe) for the character.\nCancel = TEXTURE motion (RAFT) for "${act0.name}".`
             : 'Router offline. Extract BODY motion (MediaPipe) for the character?\n\nOK = character   ·   Cancel = abort');
      if (goChar) wantCharacter = true;
      else if (!act0) { $('upload-status').textContent = 'Cancelled. Select an object first, then upload.'; e.target.value = ''; return; }
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
    $('upload-status').textContent = 'Extracting body motion with MediaPipe…' +
      (target && !rigged ? ` (${target.name} isn't rigged → whole-body puppet)` : '');
    try {
      // (Step 7) fmt=swatch: one request gives BOTH the unified Contract-B swatch (for the
      // library) and, nested under .pose, the same {joints,fps,frames,detected,total} the
      // rig has always consumed. Verified byte-identical on walk-man.mp4; where they differ
      // it is because fmt=swatch gap-fills frames the detector missed, which the rig wants.
      const sw = await capture.captureCharacter(file, 'pose', 'swatch');
      const pose = sw && (sw.pose || sw);          // tolerate a legacy response
      if (!pose || !pose.detected) {
        $('upload-status').textContent = 'No person detected — use a clear, full-body clip.';
        e.target.value = ''; return;
      }
      const name = file.name.replace(/\.[^.]+$/, '') || 'Character Motion';
      const motion = {
        id: 'char-' + Date.now(), name, desc: `Character motion · MediaPipe (${pose.detected}/${pose.total} frames)`,
        color: '#34d399', character: true,
        pose: { joints: pose.joints, fps: pose.fps, frames: pose.frames.filter(Boolean) },
        params: { frequency: 1, amplitude: 0.2, direction: 0, turbulence: 0, damping: 0, phaseSpread: 0 },
        videoUrl, fromUpload: true, engine: 'mediapipe',
        swatches: sw && sw.kind === 'skeleton' ? [sw] : [],
      };
      library.add(motion); videoRec.motionId = motion.id; renderMotionList();
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
    } catch (err) {
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
      $('upload-status').textContent = `Multi-motion ${i + 1}/${textureMotions.length}: ${m.label} (${m.class})…`;
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
          added.push(sw);
        } else failed.push(`${m.label || m.class} (no motion found)`);
      } catch (err) {
        console.warn(`[MotionLife] region "${m.label || m.class}" failed:`, err.message);
        failed.push(`${m.label || m.class} (${err.message})`);
      }
    }
    if (added.length) {
      added.forEach(sw => library.add(sw));
      videoRec.motionId = added[0].id;
      renderMotionList();
      const lost = failed.length ? ` · ${failed.length} failed: ${failed.join(', ')}` : '';
      $('upload-status').textContent =
        `Extracted ${added.length} motions: ${added.map(s => `"${s.name}"`).join(', ')}${lost} — labelling the artwork…`;
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
      $('upload-status').textContent = `VLM: ${routed.class} → routing to ${via}…`;
      console.log(`[MotionLife] VLM: ${routed.label} → class=${routed.class} `
        + `subject=${routed.subject_type} count=${routed.count} → extractor=${via} (${rt.kind}); ${rt.reason}`);
    }
  }
  if (!routeOpts.engine && !routeOpts.tracker) {
    $('upload-status').textContent = 'Extracting texture motion with RAFT (optical flow)…';
  }
  capture.onProgress = (p, msg) => {
    $('upload-status').textContent = msg || `Analyzing… ${Math.round(p * 100)}%`;
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
          videoRec.motionId = picked[0].id;   // link the clip to its first motion
          renderMotionList();
          const names = picked.map(m => `"${m.name}"`).join(', ');
          $('upload-status').textContent =
            `Added ${picked.length} motion${picked.length > 1 ? 's' : ''}.`;
          status(`Added ${picked.length} motion${picked.length > 1 ? 's' : ''} — ${names}. Click one, then apply to an object.`, true);
        }
      } else {
        // SINGLE-MOTION PATH (unchanged): the "wow" extraction moment only
        // plays when there's really just one motion to celebrate.
        if (motion.trajectories && motion.videoUrl && window.showExtraction) {
          await showExtraction(motion.videoUrl, motion.trajectories, motion.params, motion.color);
        }
        // same fallback gap as the multi-motion branch above: keep the router's class when
        // the extraction dropped to Lucas–Kanade, so Step 8 still dispatches on the class
        // rather than on the layer the user happens to click.
        if (routed && routed.class && !motion.class) motion.class = routed.class;
        library.add(motion); videoRec.motionId = motion.id; renderMotionList();
        $('upload-status').textContent = `Added "${motion.name}"`;
        status(`Motion "${motion.name}" captured from video — click it, then apply to an object.`, true);
      }
    } else {
      $('upload-status').textContent = 'Could not extract motion (need more movement / a longer clip).';
    }
  } catch (err) {
    $('upload-status').textContent = 'Video error: ' + err.message;
  }
  e.target.value = '';
};
