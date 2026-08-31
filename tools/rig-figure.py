#!/usr/bin/env python3
"""Add a limb rig to a figure in an SVG, so a captured pose swatch can drive it.

    python3 tools/rig-figure.py IN.svg OUT.svg Shirt=torso Left_Leg=leg-l@211,270 ...

Each argument names a group by its `id` and the limb role to give it, optionally with the
JOINT that limb rotates about. `js/animate.js` only articulates elements carrying
`data-limb`; without any, a pose swatch falls through every pose gate to the generic texture
path and the whole figure wobbles in place instead of walking. That is the entire difference
between "it just oscillates" and a walk cycle.

PIVOTS. `@x,y` writes `data-pivot`, in the SVG's OWN user space (the space getBBox reports
and the space the rig's rotate() acts in). Omit it and the rig infers a joint by clamping the
body centre into the limb's bounding box, which lands on the edge where the limb attaches —
usable, but a hand-placed joint is better, and hip placement is what decides whether a seam
shows. Measure the parts first:

    SVG=/path/to/art.svg node tools/measure-parts.js '#Girl_Reaching'

then read the joints off the boxes: a hip is the TOP of a leg box, a shoulder the top corner
of the torso box on that side, the neck the top-centre of the torso.

ROLES. arm-l/arm-r, forearm-l/forearm-r, leg-l/leg-r, shin-l/shin-r, head, torso — these are
the keys of LIMB_BONES in js/animate.js; anything else is left alone by the rig, so this
script refuses it rather than writing a tag that will silently do nothing.

TWO ELEMENTS MAY SHARE A ROLE. Give hair and a face the same role AND the same pivot and they
rotate identically, staying glued without re-parenting the SVG (which would change z-order).
That is how assets/scenes/girl-scene3.svg keeps its hair on.

WHAT NOT TO TAG. Anything that isn't a bone. A skirt left untagged stays put while the legs
swing beneath it, which is also what hides the hip seam.
"""
import re
import sys

# the keys of LIMB_BONES in js/animate.js — keep in sync
ROLES = {'arm-l', 'arm-r', 'forearm-l', 'forearm-r', 'leg-l', 'leg-r',
         'shin-l', 'shin-r', 'head', 'torso'}


def parse_spec(spec):
    """`id=role` or `id=role@x,y` -> (el_id, role, pivot|None)."""
    if '=' not in spec:
        sys.exit('bad spec %r — want id=role or id=role@x,y' % spec)
    el_id, rhs = spec.split('=', 1)
    pivot = None
    if '@' in rhs:
        rhs, pv = rhs.split('@', 1)
        parts = pv.replace(',', ' ').split()
        if len(parts) != 2:
            sys.exit('bad pivot in %r — want @x,y' % spec)
        try:
            pivot = '%g %g' % (float(parts[0]), float(parts[1]))
        except ValueError:
            sys.exit('non-numeric pivot in %r' % spec)
    if rhs not in ROLES:
        sys.exit('unknown role %r in %r — the rig ignores anything outside %s'
                 % (rhs, spec, ', '.join(sorted(ROLES))))
    return el_id, rhs, pivot


def main(argv):
    if len(argv) < 4:
        sys.exit(__doc__)
    src, dst, specs = argv[1], argv[2], [parse_spec(a) for a in argv[3:]]

    s = open(src).read()
    if 'data-limb' in s:
        sys.exit('%s already carries data-limb — refusing to double-tag; edit it or start '
                 'from the unrigged original' % src)

    for el_id, role, pivot in specs:
        # match the opening tag with exactly this id, so a nested <g id="Left"> inside
        # <g id="Left_Leg"> is never hit by accident
        pat = re.compile(r'(<g\s[^>]*id="' + re.escape(el_id) + r'")')
        n = len(pat.findall(s))
        if n != 1:
            sys.exit('expected exactly one <g id="%s">, found %d' % (el_id, n))
        attrs = ' data-limb="%s"' % role
        if pivot:
            attrs += ' data-pivot="%s"' % pivot
        s = pat.sub(r'\1' + attrs, s, count=1)

    open(dst, 'w').write(s)
    print('wrote %s' % dst)
    inferred = 0
    for el_id, role, pivot in specs:
        print('  %-14s data-limb="%s"%s' % (el_id, role,
              ' data-pivot="%s"' % pivot if pivot else '   (pivot INFERRED at run time)'))
        inferred += 0 if pivot else 1
    if inferred:
        print('\n%d limb(s) have no declared joint. The rig will infer one from the bounding '
              'box;\nmeasure them with tools/measure-parts.js if a seam shows.' % inferred)


if __name__ == '__main__':
    main(sys.argv)
