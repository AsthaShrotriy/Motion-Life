/*
 * scenery.js — inline SVG hero: "Amber Jetty" (golden-hour autumn lake).
 *
 * Contract (do not break):
 *   - selectable unit  = <g class="layer" data-name="…">  (click-to-select)
 *   - backdrops        = id-only elements                  (not selectable)
 *   - viewBox          = 0 0 800 500
 *
 * Designed around the user's two real capture clips:
 *   - waving-flag video  → "flag"   (tall pennant at the end of the jetty)
 *   - falling-leaves video → "leaves" (maple shedding leaves over the water)
 *
 * 12 selectable objects: sun · cloud 1 · cloud 2 · birds · mountains · mist
 *   river · boat · flag · tree 1 (maple) · tree 2 (pine) · leaves
 *
 * Craft: 3 rim-lit ridge planes with atmospheric haze, water that mirrors the
 * sky with ridge reflection + sun-glint path, silhouetted jetty, layered
 * maple canopy with light/shadow clusters, graded corner vignette.
 *
 * Palette: dusk indigo #26304e · mauve #9d6f7c · amber #d99270 · gold #f2bc7e
 *          maple rust #c05a2e / #e8923f · plum ridge #4b3960 · water night #262040
 */

function createScenerySVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 500');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.width = '100%';
  svg.style.height = '100%';

  const leaf = (x, y, rot, c, op) =>
    `<path d="M ${x},${y} c 3,-5 8,-5 10,-1 c -2,5 -7,6 -10,1 Z" fill="${c}" opacity="${op}" transform="rotate(${rot} ${x} ${y})"/>`;

  const bird = (x, y, s, op) =>
    `<path d="M ${x},${y} q ${3.2 * s},${-4 * s} ${6.4 * s},0 q ${3.2 * s},${-4 * s} ${6.4 * s},0" stroke="#2e2438" stroke-width="${1.3 * s}" fill="none" stroke-linecap="round" opacity="${op}"/>`;

  svg.innerHTML = `
  <defs>
    <linearGradient id="sky-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#26304e"/>
      <stop offset="30%" stop-color="#575475"/>
      <stop offset="55%" stop-color="#9d6f7c"/>
      <stop offset="75%" stop-color="#d99270"/>
      <stop offset="90%" stop-color="#f2bc7e"/>
      <stop offset="100%" stop-color="#f9dfa3"/>
    </linearGradient>
    <radialGradient id="sun-g" cx="0.5" cy="0.5" r="0.5">
      <stop offset="0%"  stop-color="#ffedc4" stop-opacity="0.95"/>
      <stop offset="38%" stop-color="#f7cd8e" stop-opacity="0.4"/>
      <stop offset="100%" stop-color="#f7cd8e" stop-opacity="0"/>
    </radialGradient>
    <linearGradient id="water-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%"  stop-color="#edb27c"/>
      <stop offset="12%" stop-color="#b57e83"/>
      <stop offset="40%" stop-color="#675178"/>
      <stop offset="75%" stop-color="#3a3054"/>
      <stop offset="100%" stop-color="#262040"/>
    </linearGradient>
    <linearGradient id="glint-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#f9d9a0" stop-opacity="0.55"/>
      <stop offset="100%" stop-color="#f9d9a0" stop-opacity="0"/>
    </linearGradient>
    <linearGradient id="bank-g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#241c34"/><stop offset="100%" stop-color="#140f20"/>
    </linearGradient>
    <radialGradient id="vignette-g" cx="0.5" cy="0.42" r="0.75">
      <stop offset="55%" stop-color="#140c24" stop-opacity="0"/>
      <stop offset="100%" stop-color="#140c24" stop-opacity="0.34"/>
    </radialGradient>
    <filter id="soft"   x="-40%" y="-40%" width="180%" height="180%"><feGaussianBlur stdDeviation="2.5"/></filter>
    <filter id="softer" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="6"/></filter>
  </defs>

  <!-- ================== sky (backdrop) ================== -->
  <g id="sky">
    <rect width="800" height="500" fill="url(#sky-g)"/>
    <circle cx="96"  cy="38" r="1.1" fill="#e8e4f4" opacity="0.5"/>
    <circle cx="210" cy="66" r="0.8" fill="#e8e4f4" opacity="0.35"/>
    <circle cx="152" cy="96" r="0.9" fill="#e8e4f4" opacity="0.4"/>
    <circle cx="318" cy="44" r="0.8" fill="#e8e4f4" opacity="0.3"/>
    <circle cx="52"  cy="120" r="0.8" fill="#e8e4f4" opacity="0.3"/>
    <circle cx="266" cy="24" r="1.0" fill="#e8e4f4" opacity="0.4"/>
  </g>

  <!-- sun low over the ridge -->
  <g class="layer" data-name="sun">
    <circle cx="505" cy="268" r="120" fill="url(#sun-g)"/>
    <circle cx="505" cy="268" r="36" fill="#ffe9c4"/>
    <circle cx="505" cy="268" r="29" fill="#fff6e2"/>
  </g>

  <!-- thin dusk cloud streaks -->
  <g class="layer" data-name="cloud 1">
    <g filter="url(#soft)" transform="translate(190, 118)">
      <ellipse cx="0" cy="0" rx="80" ry="7" fill="#8a7391" opacity="0.45"/>
      <ellipse cx="26" cy="5" rx="52" ry="4" fill="#d9a082" opacity="0.4"/>
    </g>
  </g>
  <g class="layer" data-name="cloud 2">
    <g filter="url(#soft)" transform="translate(596, 168)">
      <ellipse cx="0" cy="0" rx="66" ry="6.5" fill="#a3708a" opacity="0.42"/>
      <ellipse cx="-20" cy="4.5" rx="42" ry="3.5" fill="#eab183" opacity="0.4"/>
    </g>
  </g>

  <g class="layer" data-name="birds">
    ${bird(322, 138, 1.0, 0.75)} ${bird(348, 126, 0.75, 0.6)} ${bird(368, 144, 0.85, 0.65)}
  </g>

  <!-- ================== three rim-lit ridge planes ================== -->
  <g class="layer" data-name="mountains">
    <path d="M 0,302 C 60,296 130,288 200,290 C 280,292 340,300 410,296
             C 470,293 520,284 580,286 C 650,288 730,296 800,292 L 800,364 L 0,364 Z"
          fill="#cf9a92" opacity="0.5"/>
    <rect x="0" y="278" width="800" height="30" fill="#f2bc7e" opacity="0.12" filter="url(#softer)"/>
    <path d="M 0,322 C 80,314 150,306 230,308 C 300,310 360,320 430,318
             C 500,316 550,306 620,306 C 690,306 750,314 800,312 L 800,364 L 0,364 Z"
          fill="#8a5c74"/>
    <path d="M 430,318 C 500,316 550,306 620,306" stroke="#f2bc7e" stroke-width="1.6" fill="none" opacity="0.55"/>
    <path d="M 230,308 C 300,310 360,320 430,318" stroke="#e8a276" stroke-width="1.3" fill="none" opacity="0.35"/>
    <path d="M 0,348 C 90,342 180,336 280,338 C 380,340 460,346 560,344
             C 660,342 740,338 800,340 L 800,366 L 0,366 Z"
          fill="#4b3960"/>
  </g>

  <!-- ================== the lake ================== -->
  <g class="layer" data-name="river">
    <rect x="0" y="362" width="800" height="138" fill="url(#water-g)"/>
    <path d="M 0,364 C 100,370 220,374 340,373 C 480,372 620,368 800,365 L 800,392 C 620,395 480,399 340,400 C 220,401 100,397 0,391 Z"
          fill="#43325a" opacity="0.4" filter="url(#soft)"/>
    <rect x="478" y="362" width="54" height="74" fill="url(#glint-g)" filter="url(#soft)"/>
    <path d="M 488,380 L 522,380 M 482,394 L 528,394 M 490,410 L 520,410 M 494,424 L 516,424"
          stroke="#f9d9a0" stroke-width="1.5" opacity="0.5" stroke-linecap="round"/>
    <path d="M 90,398 Q 160,394 230,398"  stroke="#a5748a" stroke-width="1.1" fill="none" opacity="0.35"/>
    <path d="M 320,426 Q 400,421 480,426" stroke="#7d5f8a" stroke-width="1.1" fill="none" opacity="0.3"/>
    <path d="M 560,452 Q 640,447 720,452" stroke="#524068" stroke-width="1.1" fill="none" opacity="0.3"/>
    <path d="M 244,420 C 246,436 244,452 246,466" stroke="#1c1630" stroke-width="2.5" fill="none" opacity="0.4" filter="url(#soft)"/>
    <ellipse cx="710" cy="452" rx="80" ry="14" fill="#1a1428" opacity="0.4" filter="url(#softer)"/>
  </g>

  <!-- fog patches lying on the far waterline -->
  <g class="layer" data-name="mist">
    <g filter="url(#softer)">
      <ellipse cx="130" cy="370" rx="120" ry="5"   fill="#f2e0d0" opacity="0.24"/>
      <ellipse cx="400" cy="374" rx="140" ry="4.5" fill="#f6e6d2" opacity="0.2"/>
      <ellipse cx="672" cy="369" rx="100" ry="4.5" fill="#f2e0d0" opacity="0.22"/>
    </g>
  </g>

  <!-- canoe silhouette on the glint -->
  <g class="layer" data-name="boat">
    <path d="M 556,420 C 566,424 598,424 608,420 L 601,429 C 592,432 572,432 563,429 Z" fill="#1f1830"/>
    <path d="M 580,420 L 580,410 L 583,410 L 583,420 Z" fill="#1f1830"/>
    <ellipse cx="582" cy="434" rx="20" ry="2.5" fill="#1f1830" opacity="0.35" filter="url(#soft)"/>
  </g>

  <!-- ================== jetty + banks (backdrop) ================== -->
  <g id="ground">
    <path d="M 0,438 L 234,421 L 262,421 L 262,430 L 246,430 L 0,462 Z" fill="#241a30"/>
    <path d="M 0,438 L 234,421 L 262,421 L 262,423.5 L 236,423.5 L 0,441 Z" fill="#c98a5e" opacity="0.55"/>
    <path d="M 64,440 L 71,440 L 71,478 L 64,478 Z"    fill="#1a1226"/>
    <path d="M 154,433 L 161,433 L 161,474 L 154,474 Z" fill="#1a1226"/>
    <path d="M 240,426 L 247,426 L 247,468 L 240,468 Z" fill="#1a1226"/>
    <path d="M 66,478 L 70,478 L 70,488 M 156,474 L 159,474 L 159,484" stroke="#171021" stroke-width="3" opacity="0.5"/>
    <path d="M 800,500 L 800,432 C 760,428 732,432 710,440 C 688,448 672,460 664,476 C 660,486 658,492 658,500 Z" fill="url(#bank-g)"/>
  </g>

  <!-- flag pole: static backdrop — only the CLOTH animates -->
  <g id="flagpole">
    <line x1="250" y1="422" x2="250" y2="252" stroke="#2a2138" stroke-width="3.5" stroke-linecap="round"/>
    <line x1="248.6" y1="422" x2="248.6" y2="254" stroke="#f2bc7e" stroke-width="0.9" opacity="0.55"/>
    <circle cx="250" cy="250" r="3" fill="#f2bc7e"/>
  </g>

  <!-- ============ FLAG: just the pennant cloth (capture target #1) ============ -->
  <g class="layer" data-name="flag">
    <path d="M 253,256 C 271,253 287,260 305,256 C 315,254 322,255 327,258 L 327,261
             C 318,268 306,266 292,269 C 278,273 264,268 253,274 Z" fill="#e86a4e"/>
    <path d="M 253,265 C 269,262 283,266 299,263" stroke="#b34a36" stroke-width="1.2" fill="none" opacity="0.6"/>
    <path d="M 253,258 C 268,256 281,260 296,258" stroke="#f2937a" stroke-width="1" fill="none" opacity="0.7"/>
  </g>

  <!-- ============ TREE 1: autumn maple on the right bank ============ -->
  <g class="layer" data-name="tree 1">
    <path d="M 716,478 L 730,478 C 728,452 726,436 728,420 C 736,410 746,404 754,400
             L 750,394 C 742,398 736,402 730,408 C 728,394 726,382 722,372
             L 712,374 C 716,388 718,404 718,420 C 712,412 704,406 694,402
             L 690,408 C 700,414 708,422 712,432 C 714,448 716,464 716,478 Z" fill="#2e1c12"/>
    <circle cx="700" cy="330" r="46" fill="#c05a2e"/>
    <circle cx="748" cy="316" r="40" fill="#c05a2e"/>
    <circle cx="662" cy="360" r="38" fill="#b84f28"/>
    <circle cx="782" cy="346" r="42" fill="#c05a2e"/>
    <circle cx="722" cy="368" r="44" fill="#b84f28"/>
    <circle cx="676" cy="322" r="30" fill="#c9612f"/>
    <circle cx="798" cy="378" r="36" fill="#b84f28"/>
    <circle cx="668" cy="380" r="30" fill="#8f3d22"/>
    <circle cx="712" cy="392" r="34" fill="#8f3d22"/>
    <circle cx="756" cy="384" r="32" fill="#96401f"/>
    <circle cx="664" cy="330" r="22" fill="#e8923f"/>
    <circle cx="690" cy="352" r="18" fill="#e08438"/>
    <circle cx="646" cy="352" r="14" fill="#efa04b"/>
  </g>

  <!-- ============ LEAVES: shed from the maple, drifting over the water (capture target #2) ============ -->
  <g class="layer" data-name="leaves">
    <rect x="496" y="308" width="150" height="150" fill="transparent"/>
    ${leaf(612, 352, 25,  '#e8923f', 0.9)}  ${leaf(578, 392, -40, '#c05a2e', 0.85)}
    ${leaf(544, 368, 65,  '#e8923f', 0.85)} ${leaf(508, 412, -15, '#b84f28', 0.8)}
    ${leaf(628, 430, 45,  '#c9612f', 0.8)}  ${leaf(560, 442, -55, '#e8923f', 0.75)}
    ${leaf(596, 318, 10,  '#efa04b', 0.9)}  ${leaf(524, 338, -30, '#c05a2e', 0.8)}
    ${leaf(636, 396, 80,  '#e08438', 0.85)}
  </g>

  <!-- ============ TREE 2: backlit pine at the far left ============ -->
  <g class="layer" data-name="tree 2">
    <path d="M 40,472
      C 43,465 45,459 44,455 C 49,448 52,442 50,438 C 55,430 58,424 54,420
      C 59,413 61,408 58,405 L 42,405 L 42,398 L 38,398 L 38,405 L 22,405
      C 19,408 21,413 26,420 C 22,424 25,430 30,438 C 28,442 31,448 36,455
      C 35,459 37,465 40,472 Z" fill="#241c38" transform="translate(0,-70) scale(1,1.55) translate(0,160)"/>
    <path d="M 36,500 L 44,500 L 43,468 L 37,468 Z" fill="#1a1228"/>
  </g>

  <!-- graded vignette (backdrop, never intercepts clicks) -->
  <rect id="vignette" width="800" height="500" fill="url(#vignette-g)" pointer-events="none"/>
  `;

  return svg;
}

window.createScenerySVG = createScenerySVG;
