/*
 * export.js — bake the current animated scene into a SELF-CONTAINED .svg.
 *
 * The live app drives motion from JS every frame. A website can't run our
 * JS, so we bake: for every selection with a motion, sample computeMotion()
 * over one loop period and emit CSS @keyframes embedded in a <style> inside
 * the SVG. The result animates anywhere SVG renders — including as a plain
 * <img src="poster.svg">, where scripts are disabled but CSS animation runs.
 *
 * Loop seams:
 *  - sine: frequency is snapped so a whole number of cycles fits the loop
 *  - drift: loop duration is exactly one DRIFT_PERIOD sawtooth
 *  - noise (turbulence/envelope): cross-faded over the final 12% of the loop
 */

function buildExportSVG(sel, motions) {
  if (sel.mode !== 'svg' || !sel._svg) return null;
  const animated = sel.selections.filter(s => s.kind === 'svg' && s.motionId);
  if (!animated.length) return null;

  // tag source wraps so the clone carries a stable selector
  animated.forEach((s, i) => s.wrap.setAttribute('data-ms-export', 'msx' + i));
  const clone = sel._svg.cloneNode(true);
  animated.forEach(s => s.wrap.removeAttribute('data-ms-export'));

  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const hl = clone.querySelector('#ms-highlights');
  if (hl) hl.remove();
  clone.querySelectorAll('.ms-wrap').forEach(w => w.removeAttribute('transform'));

  let css = '';
  animated.forEach((s, i) => {
    const m = motions.getById(s.motionId);
    if (!m) return;
    const speed = s.speed || 1;
    const intensity = s.intensity || 1;
    const seed = s.center[0] * 0.01 + s.center[1] * 0.03;

    // ---- per-glyph text: bake one SMIL transform track per letter ----
    if (s.wrap.querySelector('text')) {
      const td = buildTextData(s.wrap);        // idempotent: splits if needed
      if (td) {
        const field = buildTrajField(m);
        const D = (field ? field.period : Math.max(1, 1 / Math.max(0.2, m.params.frequency))) / speed;
        const STEPS = Math.min(60, Math.max(24, Math.round(D * 10)));
        const cloneWrap = clone.querySelector(`[data-ms-export="msx${i}"]`);
        if (cloneWrap) {
          // clone was made BEFORE the split — rebuild its inner markup from the live wrap
          cloneWrap.innerHTML = s.wrap.innerHTML;
          const cloneGlyphs = [...cloneWrap.querySelectorAll('text[data-ms-glyph]')];
          td.items.forEach((it, gi) => {
            const target = cloneGlyphs[gi];
            if (!target) return;
            // SMIL animateTransform takes ONE type per element, so nest:
            // outer <g> animates translate, inner <g> animates rotate.
            const gOuter = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            const gInner = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            target.parentNode.insertBefore(gOuter, target);
            gOuter.appendChild(gInner);
            gInner.appendChild(target);
            target.removeAttribute('transform');
            const trVals = [], rotVals = [];
            for (let step = 0; step <= STEPS; step++) {
              const t = (field ? field.period : D * speed) * step / STEPS;
              const tf = glyphTransform(td, it, field, m.params, t, intensity);
              const mT = tf.match(/translate\(([-\d.]+) ([-\d.]+)\)/);
              const mR = tf.match(/rotate\(([-\d.]+) ([-\d.]+) ([-\d.]+)\)/);
              trVals.push(mT ? `${mT[1]} ${mT[2]}` : '0 0');
              rotVals.push(mR ? `${mR[1]} ${mR[2]} ${mR[3]}` : '0 0 0');
            }
            const aT = document.createElementNS('http://www.w3.org/2000/svg', 'animateTransform');
            aT.setAttribute('attributeName', 'transform');
            aT.setAttribute('type', 'translate');
            aT.setAttribute('values', trVals.join(';'));
            aT.setAttribute('dur', D.toFixed(2) + 's');
            aT.setAttribute('repeatCount', 'indefinite');
            aT.setAttribute('calcMode', 'linear');
            gOuter.appendChild(aT);
            const aR = document.createElementNS('http://www.w3.org/2000/svg', 'animateTransform');
            aR.setAttribute('attributeName', 'transform');
            aR.setAttribute('type', 'rotate');
            aR.setAttribute('values', rotVals.join(';'));
            aR.setAttribute('dur', D.toFixed(2) + 's');
            aR.setAttribute('repeatCount', 'indefinite');
            aR.setAttribute('calcMode', 'linear');
            gInner.appendChild(aR);
          });
          return;   // no CSS keyframes for this selection
        }
      }
    }

    // ---- cloth/wave mode: bake as SMIL d-morphing (CSS can't animate d in <img>) ----
    if (s.waveMode) {
      const wave = buildWaveData(s.wrap);          // live wrap: pristine geometry
      if (wave) {
        const width = Math.max(1, wave.maxX - wave.minX);
        const cloneWrap = clone.querySelector(`[data-ms-export="msx${i}"]`);
        const clonePaths = cloneWrap ? [...cloneWrap.querySelectorAll('path')] : [];
        const field = buildTrajField(m);

        if (field) {
          // captured motion: bake the real trajectory field. The sampler's
          // ping-pong period is inherently seamless.
          const height = Math.max(1, wave.maxY - wave.minY);
          const D = field.period / speed;
          const STEPS = Math.min(60, Math.max(24, Math.round(D * 8)));
          wave.paths.forEach((pd, pi) => {
            const target = clonePaths[pi];
            if (!target) return;
            const frames = [];
            for (let step = 0; step <= STEPS; step++) {
              const t = field.period * step / STEPS;
              frames.push(fieldD(pd, wave.minX, wave.minY, width, height, field, t, intensity));
            }
            const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
            anim.setAttribute('attributeName', 'd');
            anim.setAttribute('values', frames.join(';'));
            anim.setAttribute('dur', D.toFixed(2) + 's');
            anim.setAttribute('repeatCount', 'indefinite');
            anim.setAttribute('calcMode', 'linear');
            target.setAttribute('d', frames[0]);
            target.removeAttribute('data-ms-d0');
            target.appendChild(anim);
          });
          return;
        }

        // preset: synthetic sine (phase spans exactly 2π → perfect loop)
        const p = m.params;
        const D = Math.max(1, (1 / Math.max(0.2, p.frequency)) ) / speed; // one wave cycle
        const A = WAVE_AMP_PX * (0.35 + p.amplitude) * intensity;
        const k = 2 * Math.PI * WAVE_CYCLES * (0.5 + p.phaseSpread) / width;
        const turb = p.turbulence * 4 * intensity;
        const STEPS = 24;
        wave.paths.forEach((pd, pi) => {
          const target = clonePaths[pi];
          if (!target) return;
          const frames = [];
          for (let step = 0; step <= STEPS; step++) {
            const phase = 2 * Math.PI * step / STEPS;
            frames.push(waveD(pd, wave.minX, width, A, k, phase, turb));
          }
          const anim = document.createElementNS('http://www.w3.org/2000/svg', 'animate');
          anim.setAttribute('attributeName', 'd');
          anim.setAttribute('values', frames.join(';'));
          anim.setAttribute('dur', D.toFixed(2) + 's');
          anim.setAttribute('repeatCount', 'indefinite');
          anim.setAttribute('calcMode', 'linear');
          target.setAttribute('d', frames[0]);
          target.removeAttribute('data-ms-d0');
          target.appendChild(anim);
        });
        return;   // no CSS keyframes for this selection
      }
    }

    // loop duration in animation-seconds; motion-time spans D*speed
    const hasDrift = !!(m.params.driftX || m.params.driftY);
    const D = hasDrift ? DRIFT_PERIOD / speed : 8;
    const span = D * speed;
    // snap frequency so sine closes exactly at the loop point
    const cycles = Math.max(1, Math.round(m.params.frequency * span));
    const p = { ...m.params, frequency: cycles / span };

    const STEPS = Math.min(200, Math.max(60, Math.round(D * 15)));
    let kf = `@keyframes msx${i}{`;
    for (let k = 0; k <= STEPS; k++) {
      const frac = k / STEPS;
      const t = frac * span;
      let d = computeMotion(p, seed, t, intensity);
      if (frac > 0.88) {                       // cross-fade noise seam
        const w = (frac - 0.88) / 0.12;
        const d0 = computeMotion(p, seed, t - span, intensity);
        d = {
          dx: d.dx * (1 - w) + d0.dx * w,
          dy: d.dy * (1 - w) + d0.dy * w,
          rot: d.rot * (1 - w) + d0.rot * w,
        };
      }
      kf += `${+(frac * 100).toFixed(2)}%{transform:translate(${d.dx.toFixed(2)}px,${d.dy.toFixed(2)}px) rotate(${d.rot.toFixed(3)}deg)}`;
    }
    kf += '}';
    css += `[data-ms-export="msx${i}"]{animation:msx${i} ${D.toFixed(2)}s linear infinite;transform-box:fill-box;transform-origin:50% 50%;will-change:transform}` + kf + '\n';
  });

  const style = document.createElementNS('http://www.w3.org/2000/svg', 'style');
  style.textContent = css;
  clone.insertBefore(style, clone.firstChild);
  return new XMLSerializer().serializeToString(clone);
}

window.buildExportSVG = buildExportSVG;
