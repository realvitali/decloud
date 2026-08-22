# DeCloud Procedural Agent Avatars

Deterministic, animated, 3D-projected avatars for DeCloud agents and bots.
Each agent gets a unique avatar derived from its name (or a stored seed), and
the avatar can be re-rolled at any time.

## What they are

Each avatar is a **3D superellipsoid** (sphere, cube, capsule, cone, diamond,
mickey-with-ears, or cylinder) that is:

1. **Projected** to 2D with perspective (the "flattening" of a 3D shape)
2. Rendered as a **smooth flat-colored silhouette** (convex hull of the
   projected surface, smoothed with Catmull-Rom curves)
3. Given **eyes** that are projected onto the curved surface and clipped to
   the head, so they wrap around the shape as it turns
4. **Animated** with natural idle motion:
   - **Gaze** — a state machine of pauses and glances (hold → look over →
     hold → glance back), not a constant drift
   - **Eye micro-saccades** — quick small eye jumps
   - **Blinking** — periodic eye-height collapse

## Determinism

The avatar is fully determined by a seed string:

- `FNV-1a` hash of the seed → `mulberry32` PRNG
- Same seed → same shape, colors, eye geometry, and motion, forever, on any
  machine.

Bots use a stored `avatar_seed` (re-rollable via the 🎲 button). Static agents
(Nika, Pengy) use their name as the seed.

## Files

| File | Purpose |
| --- | --- |
| `static/js/avatar3d.js` | The renderer + generator + live animation component |
| `static/js/modules/bots.js` | Wires avatars into the bot roster + reroll button |
| `routes/bots.py` | `avatar_seed` field + `/api/bots/<name>/avatar` reroll endpoint |
| `static/avatar-animated.html` | Standalone preview page (type a name, watch it animate) |

## License compliance

This is an **independent, from-scratch implementation** and is **MIT-licensed**
like the rest of DeCloud. It is *not* a port or copy of any third-party code.

The *idea* of "a procedural 3D shape with eyes" was inspired by the
[Bible Strong Avatar Lab](https://github.com/smontlouis/bible-strong-avatar-lab)
(AGPL-3.0), but:

- **No code was copied.** The superellipsoid math, convex-hull silhouette,
  Catmull-Rom smoothing, gaze state machine, and saccade/blink logic were all
  written fresh for DeCloud.
- **No assets were copied.** No `.avatar.json` definitions, no SVG paths, no
  color palettes were taken from that project.
- **The shared elements are ideas and math**, which are not copyrightable
  expression. The specific *implementation* (the actual code) is original.

Because no AGPL code or assets are included, DeCloud's MIT license is
unaffected. There is no AGPL obligation.

### Why this is safe

- Copyright protects *expression* (the specific code), not *ideas* (a
  procedural avatar, a superellipsoid, a convex hull).
- The superellipsoid formula is a standard mathematical surface (Barr, 1981),
  in the public domain as a concept.
- Convex hull and Catmull-Rom splines are standard computational geometry.
- The gaze/blink/saccade behaviors are generic animation techniques.

If you ever want to *also* support importing `.avatar.json` files exported
from the Bible Strong editor, that's fine too — those JSON files are *data*,
not code, and data is not covered by the AGPL. (That feature is not currently
implemented.)

## Tuning

The motion parameters live in `static/js/avatar3d.js`:

- Gaze angles and pause durations: `createGaze()`
- Blink interval: `generate()` → `blinkInterval`
- Saccade timing: `saccade()`
- Shape families and proportions: `FAMILIES` + `shapeParams()`
