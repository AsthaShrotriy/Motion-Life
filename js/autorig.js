/* autorig.js — derive a limb rig from the LAYER NAMES the artist already wrote.
 *
 * WHY THIS EXISTS
 * The limb applicator (Animator._applyLimbs) needs two attributes per limb: data-limb="<role>"
 * naming the bone, and data-pivot="x y" giving the joint it rotates about. Until now both had
 * to be hand-added to the file. An artist who had already named their layers "Left Hand",
 * "Right Leg" and so on got nothing for it: the scene loaded with no rig, so a pose swatch
 * could not articulate it and the whole figure was handed to a whole-figure applicator, which
 * translates and scales the entire drawing as one block. That is the "they're just bobbing in
 * place" failure — the labels were right and nothing read them.
 *
 * WHAT IT DERIVES, AND WHAT IT MEASURES RATHER THAN GUESSES
 * The ROLE comes from the layer name (side + part). The PIVOT is measured off the artwork:
 * it is the sampled path point of that limb which lies CLOSEST TO ITS FIGURE'S CENTRE — i.e.
 * the end of the limb that meets the body. That rule was checked against eight pivots that had
 * been placed by hand on scene2-station: mean error 1.56px, and 4 of the 8 within 0.4px. The
 * cheaper "nearest bbox corner" rule scored 3.56px and is not used, because a bbox corner can
 * fall in empty space — and because on this artwork the arms point UPWARD, so the shoulder is
 * at the bbox BOTTOM and any fixed "top of the box" rule puts the joint in the glove.
 *
 * WHAT IT DOES NOT DO
 * - It never overwrites an author's own data-limb or data-pivot. Hand authoring always wins.
 * - It does not tag a torso, even when a layer is called one. With retarget off the parent
 *   chain is still composed onto its children, and a limb's track is an ABSOLUTE bone-angle
 *   delta that already contains its parent's rotation, so tagging a torso double-counts torso
 *   swing into every limb below it.
 * - It contributes NO motion of its own. Every angle still comes from the extracted clip;
 *   this file only decides which group rotates about which point.
 */
(() => {
  // Word-boundary matching matters more than it looks: a suitcase artwork has a `Handle`
  // group, and a substring test for "hand" tags the handle as an arm and then swings it.
  const PARTS = [
    { role: 'arm', re: /\b(hand|arm|forearm|upper ?arm|palm|glove|wrist|elbow|shoulder)\b/ },
    { role: 'leg', re: /\b(leg|foot|feet|shoe|shoes|boot|sneaker|thigh|shin|calf|knee|ankle)\b/ },
  ];
  const LEFT  = /\b(left|lt|lh|ll)\b|^l[\s_-]/;
  const RIGHT = /\b(right|rt|rh|rl)\b|^r[\s_-]/;
  // Named like a body/torso: skipped deliberately (see header), not missed.
  const TORSO = /\b(torso|body|chest|hips?|pelvis|spine|trunk)\b/;

  /* "Left_Hand-2" -> "left hand", "RightLeg" -> "right leg".
     The trailing -2 / copy suffixes are Illustrator's duplicate markers; two figures in one
     artwork both have a "Left Hand", and which figure a limb belongs to is settled by the
     ancestor walk below, not by the suffix. */
  const norm = (s) => (s || '')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .replace(/\b(copy|copie?s?)\b/g, ' ')
    .replace(/\s+\d+\s*$/, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const nameOf = (el) => el.getAttribute('data-name') || el.id || '';

  /* role for a layer name, or null. Needs BOTH a side and a part: a group called just
     "Leg" cannot be placed on a two-legged figure, so it is reported, not guessed at. */
  function roleFor(rawName) {
    const n = norm(rawName);
    if (!n) return null;
    if (TORSO.test(n)) return { skip: 'torso-like name — deliberately not tagged' };
    const part = PARTS.find(p => p.re.test(n));
    if (!part) return null;
    const side = LEFT.test(n) ? 'l' : RIGHT.test(n) ? 'r' : null;
    if (!side) return { skip: `"${rawName}" has no left/right — cannot place it` };
    return { role: `${part.role}-${side}` };
  }

  /* The joint: the sampled point of this limb's geometry nearest (cx, cy).
     Returns null when the limb holds no measurable geometry, in which case the limb is
     skipped rather than given a made-up pivot. */
  function pivotOf(el, cx, cy) {
    let best = null;
    const SAMPLES = 64;
    for (const p of el.querySelectorAll('path, line, polyline, polygon, rect, circle, ellipse')) {
      let L = 0;
      try { L = p.getTotalLength(); } catch (_) { continue; }
      if (!L) continue;
      for (let i = 0; i <= SAMPLES; i++) {
        let q;
        try { q = p.getPointAtLength((i / SAMPLES) * L); } catch (_) { break; }
        const d = (q.x - cx) ** 2 + (q.y - cy) ** 2;
        if (!best || d < best.d) best = { d, x: q.x, y: q.y };
      }
    }
    return best ? { x: best.x, y: best.y } : null;
  }

  const bboxOf = (el) => { try { return el.getBBox(); } catch (_) { return null; } };

  /* The figure a limb belongs to: the nearest NAMED ancestor <g> that also holds at least one
     other limb candidate. That is what separates two figures sharing one artwork — each of the
     station scene's two characters owns its own "Left Hand" — without depending on the
     duplicate-name suffix.
     Named is a requirement, not a nicety. The first ancestor holding a sibling limb is often an
     unnamed Illustrator wrapper <g>, and this element is what the retarget declaration below is
     attached to; on the user's own scene2.svg an unnamed group there meant regions.js never
     found the declaration and both legs were retargeted off centre by ~-35deg/+27deg.
     Falls back to the nearest named ancestor when nothing holds a sibling. */
  function figureOf(el, candidates) {
    let cur = el.parentNode, fallback = null, sharedUnnamed = null;
    while (cur && cur.nodeType === 1 && cur.tagName.toLowerCase() !== 'svg') {
      if (cur.tagName.toLowerCase() === 'g' && !cur.classList.contains('ms-wrap')) {
        const named = !!nameOf(cur);
        if (named && !fallback) fallback = cur;
        let n = 0;
        for (const c of candidates) if (c !== el && cur.contains(c)) n++;
        if (n >= 1) {
          if (named) return cur;
          sharedUnnamed = sharedUnnamed || cur;      // remember, but keep looking for a name
        }
      }
      cur = cur.parentNode;
    }
    // sharedUnnamed first: it is known to span at least two limbs, so its centre is the
    // figure's. `fallback` may be a named group wrapping this ONE limb, whose centre would put
    // every pivot inside the limb itself.
    return sharedUnnamed || fallback;
  }

  /* Tag every limb this artwork already named. Returns a report; mutates the SVG in place.
     Call BEFORE regions.js attaches, because its rig detection gates on [data-limb]. */
  window.autoRigFromLayerNames = function autoRigFromLayerNames(svg) {
    const report = { tagged: [], skipped: [], figures: 0 };
    if (!svg || !svg.querySelectorAll) return report;

    // Candidates: named groups whose name reads as a limb. Outermost wins, so a "Glove"
    // inside a "Left Hand" does not become a second, nested arm rotating about its own joint.
    const all = [...svg.querySelectorAll('g[id], g[data-name]')];
    const hits = [];
    for (const el of all) {
      const r = roleFor(nameOf(el));
      if (!r) continue;
      if (r.skip) { report.skipped.push({ name: nameOf(el), why: r.skip }); continue; }
      hits.push({ el, role: r.role });
    }
    const outer = hits.filter(h => !hits.some(o => o !== h && o.el.contains(h.el)));

    const els = outer.map(h => h.el);
    const byFig = new Map();
    for (const h of outer) {
      const fig = figureOf(h.el, els);
      if (!fig) { report.skipped.push({ name: nameOf(h.el), why: 'no enclosing figure group' }); continue; }
      if (!byFig.has(fig)) byFig.set(fig, []);
      byFig.get(fig).push(h);
    }

    for (const [fig, limbs] of byFig) {
      const fb = bboxOf(fig);
      if (!fb || !fb.width) { report.skipped.push({ name: nameOf(fig), why: 'figure has no bbox' }); continue; }
      const cx = fb.x + fb.width / 2, cy = fb.y + fb.height / 2;
      let tagged = 0;
      for (const { el, role } of limbs) {
        if (el.getAttribute('data-limb')) continue;         // the author's own rig wins
        const pv = pivotOf(el, cx, cy);
        if (!pv) { report.skipped.push({ name: nameOf(el), why: 'no measurable geometry for a pivot' }); continue; }
        el.setAttribute('data-limb', role);
        if (!el.getAttribute('data-pivot'))
          el.setAttribute('data-pivot', `${pv.x.toFixed(2)} ${pv.y.toFixed(2)}`);
        report.tagged.push({ figure: nameOf(fig), name: nameOf(el), role,
                             pivot: [+pv.x.toFixed(2), +pv.y.toFixed(2)] });
        tagged++;
      }
      if (!tagged) continue;
      report.figures++;
      /* Retarget OFF for figures rigged here, and only for those.
       *
       * Retarget decides the ZERO the extracted swing is measured from: `legs` remaps the
       * drawn pose onto the CLIP's rest bone, `off` keeps the artist's drawn pose as the
       * zero. Both replay exactly the same extracted angles — this changes no motion, only
       * where that motion is centred.
       *
       * `off` is the honest default here because auto-rigging happens at load, when no clip
       * exists yet, so nothing has been measured about whether this drawing's rest pose
       * agrees with any clip's. When it disagreed on scene2-station the retarget asked for
       * 26-123deg of standing correction and tore the artwork apart. An author who HAS
       * measured their pairing still overrides this by writing data-retarget on the figure.
       */
      if (!fig.getAttribute('data-retarget')) fig.setAttribute('data-retarget', 'off');
    }

    if (report.tagged.length)
      console.info('[autorig] from layer names:', report.figures, 'figure(s),',
                   report.tagged.length, 'limb(s):', report.tagged);
    if (report.skipped.length) console.info('[autorig] not tagged:', report.skipped);
    return report;
  };
})();
