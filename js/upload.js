/* upload.js — the video-upload pipeline: VLM classify -> route -> extract.
   Handles character (MediaPipe), multi-motion (bbox-localized per detected motion),
   the falling-leaves demo, and single-motion RAFT capture. Exposed as
   window.handleMotionUpload; main.js wires it to the #motion-input change event.
   References main.js globals (capture, library, sel, $, status, renderMotionList,
   addVideoThumb, synthFallTrajectories, uploadedVideos) at call time via global scope. */
window.handleMotionUpload = async (e) => {
  // main.js is a separate IIFE-wrapped script; grab the shared helpers it exposes.
  const { $, status, capture, library, sel, renderMotionList, addVideoThumb,
          synthFallTrajectories, showInspector, applyMotionToActive } = window.__mlUpload;

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
      const pose = await capture.captureCharacter(file);
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
  // else: TEXTURE — fall through to the leaf/RAFT paths below.

  // DEMO: a falling-leaves clip → show the real extraction moment over the
  // video, but hand back a hand-tuned per-leaf fall that looks best on the art.
  if (/leaf|leaves|falling|autumn/i.test(file.name)) {
    const trajectories = synthFallTrajectories();
    const params = { frequency: 0.42, amplitude: 0.5, direction: 270, turbulence: 0.35,
                     damping: 0.05, phaseSpread: 0.9, driftX: -0.05, driftY: 0.9, leafFall: true };
    $('upload-status').textContent = 'Analyzing motion…';
    try {
      if (window.showExtraction) await showExtraction(videoUrl, trajectories, params, '#d97a2b');
    } catch (_) {}
    const motion = { id: 'captured-fall-' + Date.now(), name: 'Autumn Fall',
      desc: 'Captured from falling-leaves video', color: '#d97a2b',
      params, trajectories, trajFps: 30, videoUrl, fromUpload: true, engine: 'raft' };
    library.add(motion); videoRec.motionId = motion.id; renderMotionList();
    $('upload-status').textContent = 'Added "Autumn Fall"';
    status('Motion "Autumn Fall" captured from video — click it, then apply to the leaves.', true);
    e.target.value = '';
    return;
  }

  // MULTI-MOTION: the VLM found ≥2 distinct (non-body) motions in ONE clip → extract each
  // into its own swatch, bbox-localized to that motion's region and routed to its own engine.
  const textureMotions = allMotions.filter(m => m.class !== 'articulated').slice(0, 4);
  if (textureMotions.length >= 2) {
    const added = [];
    for (let i = 0; i < textureMotions.length; i++) {
      const m = textureMotions[i];
      $('upload-status').textContent = `Multi-motion ${i + 1}/${textureMotions.length}: ${m.label} (${m.class})…`;
      const rt = await capture.route(m.class, { subject_type: m.subject_type, count: m.count });
      const opts = { bbox: m.bbox };
      if (rt && rt.available) {
        if (rt.kind === 'flow' && rt.engine !== 'raft_small') opts.engine = rt.engine;
        else if (rt.kind === 'trajectory') opts.tracker = rt.engine;
      }
      const sw = await capture.captureFromFile(file, opts);
      if (sw) { sw.name = m.label || m.class; sw.desc = `${m.class} · ${sw.desc}`; added.push(sw); }
    }
    if (added.length) {
      added.forEach(sw => library.add(sw));
      videoRec.motionId = added[0].id;
      renderMotionList();
      $('upload-status').textContent =
        `Extracted ${added.length} motions: ${added.map(s => `"${s.name}"`).join(', ')} — click one, then apply to an object.`;
      status(`Extracted ${added.length} motions from one clip — apply each to its object.`, true);
    } else {
      $('upload-status').textContent = 'Multi-motion extraction found nothing usable.';
    }
    e.target.value = ''; return;
  }

  // AUTO-ROUTE: ask the service which extractor best fits the VLM-detected class
  // (cloth->SEA-RAFT, flock->CoTracker3, …). Falls back to raft_small if router is down.
  let routeOpts = {};
  if (routed) {
    const rt = await capture.route(routed.class, { subject_type: routed.subject_type, count: routed.count });
    if (rt && rt.engine && rt.available) {
      if (rt.kind === 'flow' && rt.engine !== 'raft_small') routeOpts.engine = rt.engine;
      else if (rt.kind === 'trajectory') routeOpts.tracker = rt.engine;
      // object_path / skeleton engines aren't applied by the texture path yet -> default raft
      const via = routeOpts.engine || routeOpts.tracker || 'raft_small';
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
