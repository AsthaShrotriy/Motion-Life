/*
 * make_boy_limbs.js — build /tmp/boy_v3_limbs.svg from the user's boy_grouped.svg by
 * adding the limb-rig tags. The source file is read only; never written.
 *
 * The tags are the whole contract for _applyLimbs:
 *   #Boy            class="layer" data-name="Boy"   -> one selectable unit for the figure
 *   each part       data-limb="<role>"              -> which captured bone drives it
 *                   data-pivot="x y"                -> the joint, in viewBox units
 *
 * The group names in this file are ANATOMICAL, not screen-side: "Right_Hand" is the boy's
 * right arm, which appears on the viewer's LEFT. The role mapping follows the boy, and the
 * pivots below were read off a render of the artwork (700x1150 px image, viewBox
 * 1199.45x1972.66, so image px * 1.7135 = viewBox units) at each visible shoulder/hip.
 */
const fs = require('fs');

const SRC = '/Users/prajjwas/Downloads/boy_grouped.svg';
const OUT = process.env.MS_OUT || '/tmp/boy_v3_limbs.svg';

const RIG = {
  Right_Hand:   { limb: 'arm-r', pivot: [437, 690] },   // viewer-left arm, at the shoulder
  Left_Hand:    { limb: 'arm-l', pivot: [740, 690] },
  Right_Leg:    { limb: 'leg-r', pivot: [500, 1180] },  // at the hip
  Left_Leg:     { limb: 'leg-l', pivot: [737, 1200] },
  Face:         { limb: 'head',  pivot: [514, 655] },    // at the neck
  Rest_of_Body: { limb: 'torso', pivot: [610, 1200] },   // torso hinges at the hips
};

let svg = fs.readFileSync(SRC, 'utf8');
const before = svg;

for (const [id, r] of Object.entries(RIG)) {
  const re = new RegExp(`(<g\\s+id="${id}")`);
  if (!re.test(svg)) throw new Error(`group id="${id}" not found — the source changed`);
  svg = svg.replace(re, `$1 data-limb="${r.limb}" data-pivot="${r.pivot[0]} ${r.pivot[1]}"`);
}
// the figure itself becomes one named unit, so a click anywhere on it selects the whole rig
const boy = /(<g\s+id="Boy")/;
if (!boy.test(svg)) throw new Error('group id="Boy" not found');
svg = svg.replace(boy, '$1 class="layer" data-name="Boy"');

if (svg === before) throw new Error('nothing was tagged');
fs.writeFileSync(OUT, svg);
console.log(`wrote ${OUT}  (${svg.length} bytes, +${svg.length - before.length} vs source)`);
console.log('source untouched:', fs.readFileSync(SRC, 'utf8').length, 'bytes');
for (const [id, r] of Object.entries(RIG)) console.log(`  ${id.padEnd(13)} -> ${r.limb.padEnd(6)} pivot ${r.pivot.join(',')}`);
