/*
 * poster.js — Act-1 artwork: a minimal poster with ONE hero flag and title
 * text. Two selectable objects only; the flag defaults to cloth-wave mode
 * (regions.js name heuristic), the text takes any motion.
 */

function createPosterSVG() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 800 500');
  svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  svg.style.width = '100%';
  svg.style.height = '100%';

  svg.innerHTML = `
  <defs>
    <linearGradient id="pp-sky" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="#1d2440"/>
      <stop offset="70%" stop-color="#31406b"/>
      <stop offset="100%" stop-color="#4b5f8f"/>
    </linearGradient>
    <linearGradient id="pp-flag" x1="0" y1="0" x2="1" y2="0">
      <stop offset="0%" stop-color="#ff6a4d"/>
      <stop offset="100%" stop-color="#e8452e"/>
    </linearGradient>
  </defs>

  <rect id="pp-bg" width="800" height="500" fill="url(#pp-sky)"/>
  <circle cx="120" cy="80" r="1.2" fill="#e8e4f4" opacity="0.5"/>
  <circle cx="640" cy="60" r="1" fill="#e8e4f4" opacity="0.4"/>
  <circle cx="700" cy="140" r="1.2" fill="#e8e4f4" opacity="0.45"/>
  <circle cx="220" cy="150" r="0.9" fill="#e8e4f4" opacity="0.35"/>
  <circle cx="420" cy="70" r="1" fill="#e8e4f4" opacity="0.4"/>

  <!-- ground line -->
  <rect id="pp-ground" x="0" y="452" width="800" height="48" fill="#141a2e"/>

  <!-- pole: static backdrop -->
  <g id="pp-pole">
    <rect x="246" y="120" width="8" height="336" rx="4" fill="#1a2138"/>
    <rect x="247.5" y="122" width="2" height="332" fill="#8fa3cf" opacity="0.35"/>
    <circle cx="250" cy="116" r="6" fill="#f2bc7e"/>
  </g>

  <!-- THE FLAG: big hero cloth, cloth-wave target -->
  <g class="layer" data-name="flag">
    <path d="M 258,128 C 310,120 358,140 410,130 C 460,121 502,128 530,140 L 530,148
             C 505,168 468,160 424,172 C 380,184 330,168 288,186 C 276,191 265,194 258,196 Z"
          fill="url(#pp-flag)"/>
    <path d="M 258,150 C 305,142 350,152 400,145 C 445,139 480,144 510,150"
          stroke="#b23520" stroke-width="2.5" fill="none" opacity="0.5"/>
    <path d="M 258,136 C 300,130 345,142 395,136" stroke="#ff9d80" stroke-width="2" fill="none" opacity="0.65"/>
  </g>

  <!-- TITLE: the second motion target -->
  <g class="layer" data-name="title">
    <text x="400" y="330" text-anchor="middle" font-family="-apple-system, Helvetica, sans-serif"
      font-size="64" font-weight="900" letter-spacing="6" fill="#f2efe8">WILDER VALLEY</text>
    <text x="400" y="368" text-anchor="middle" font-family="-apple-system, Helvetica, sans-serif"
      font-size="17" font-weight="500" letter-spacing="10" fill="#9fb0d8">TREKS &amp; STAYS · EST. 2019</text>
  </g>
  `;
  return svg;
}

window.createPosterSVG = createPosterSVG;
