/**
 * icons.js — preset SVG glyph set for the VR Mover 2D demo.
 *
 * ~16 furniture glyphs drawn as stroke-based paths in a 24×24 viewBox.
 * Each icon is rendered in two ways from the same path data:
 *   - `iconSVG(name)`            → inline `<svg>` markup for DOM (palette, editor)
 *   - `drawIcon(ctx, name, …)`   → `Path2D` strokes on a canvas 2D context
 *
 * Icons are deliberately simple pictograms — recognisable at 14 px.
 */

/** @type {Record<string, string[]>} icon name → array of SVG path `d` strings */
export const ICONS = {
  // Top-down chair: seat square with a backrest bar at the BACK (top / −z).
  // The open front faces +z (down) at angle 0, matching the forward convention,
  // and it is left/right symmetric so a 180° turn never looks upside-down.
  chair: [
    'M7 8 h10 v10 h-10 z',   // seat
    'M6 5 h12 v3 h-12 z',    // backrest bar (back)
  ],
  table: [
    'M4 8 h16',
    'M6 8 v12',
    'M18 8 v12',
    'M4 8 l2 -3 h12 l2 3',
  ],
  desk: [
    'M3 8 h18',
    'M5 8 v12',
    'M19 8 v12',
    'M12 11 h7 v4 h-7 z',
  ],
  // Top-down couch: a back bar at the BACK (top / −z), arm-rests on the left and
  // right sides, and seat cushions. The open front faces +z at angle 0. Arms are
  // on the sides (symmetric L/R) so a 180° turn still reads as a proper couch.
  couch: [
    'M7 6 h10 v12 h-10 z',     // seat + back body
    'M7 6 h10 v3 h-10 z',      // backrest bar (back)
    'M4 8 h3 v9 h-3 z',        // left armrest
    'M17 8 h3 v9 h-3 z',       // right armrest
    'M12 9 v9',                // cushion divider
  ],
  bookshelf: [
    'M5 3 h14 v18 h-14 z',
    'M5 9 h14',
    'M5 15 h14',
    'M9 4 v4',
    'M13 10 v4',
    'M11 16 v4',
  ],
  bed: [
    'M3 19 v-9 h18 v9',
    'M3 15 h18',
    'M5 10 v-3 h6 v3',
  ],
  wardrobe: [
    'M6 3 h12 v18 h-12 z',
    'M12 3 v18',
    'M10 11 v2',
    'M14 11 v2',
  ],
  tv: [
    'M3 5 h18 v11 h-18 z',
    'M9 20 h6',
    'M12 16 v4',
  ],
  plant: [
    'M9 21 h6',
    'M9.5 21 l-1 -6 h7 l-1 6',
    'M12 15 v-7',
    'M12 8 c0 -3.5 2 -4.5 4.5 -4.5 c0 3.5 -2 4.5 -4.5 4.5',
    'M12 11 c0 -3 -2 -4 -4.5 -4 c0 3 2 4 4.5 4',
  ],
  cactus: [
    'M12 20 v-13',
    'M12 14 h-3.5 v-4',
    'M12 11 h3.5 v-3',
    'M8.5 20 h7',
  ],
  lamp: [
    'M9 3 h6 l3 7 h-12 z',
    'M12 10 v8',
    'M8 21 h8',
  ],
  picture: [
    'M4 4 h16 v16 h-16 z',
    'M4 16 l5 -5 l4 4 l3 -3 l4 4',
    'M9.5 8.5 a1.5 1.5 0 1 0 -0.01 0',
  ],
  rug: [
    'M4 5 h16 v14 h-16 z',
    'M7.5 8 h9 v8 h-9 z',
  ],
  door: [
    'M4 20 h16',
    'M6 20 v-14',
    'M6 6 a14 14 0 0 1 14 14',
  ],
  box: [
    'M4 8 l8 -4 l8 4 v8 l-8 4 l-8 -4 z',
    'M4 8 l8 4 l8 -4',
    'M12 12 v8',
  ],
  circle: [
    'M12 4 a8 8 0 1 0 0.01 0',
  ],
};

/** Ordered icon names for picker UIs. */
export const ICON_NAMES = Object.keys(ICONS);

/* Path2D cache — built lazily, only in environments that have Path2D */
const path2dCache = new Map();
function getPaths2D(name) {
  let paths = path2dCache.get(name);
  if (!paths) {
    paths = (ICONS[name] ?? []).map(d => new Path2D(d));
    path2dCache.set(name, paths);
  }
  return paths;
}

/**
 * Inline SVG markup for an icon.
 * @param {string} name   - Icon name (key of `ICONS`)
 * @param {number} [size] - Width/height in px
 * @param {string} [color]
 * @returns {string} `<svg>…</svg>` string ('' for unknown / 'none')
 */
export function iconSVG(name, size = 20, color = 'currentColor') {
  const paths = ICONS[name];
  if (!paths) return '';
  const d = paths.map(p => `<path d="${p}"/>`).join('');
  return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" ` +
         `stroke="${color}" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
}

/**
 * Stroke an icon onto a canvas, centred at (cx, cy), scaled to `sizePx`.
 * @param {CanvasRenderingContext2D} ctx
 * @param {string} name
 * @param {number} cx - Centre x in current canvas coordinates
 * @param {number} cy - Centre y
 * @param {number} sizePx - Rendered width/height in px
 * @param {string} [color]
 */
export function drawIcon(ctx, name, cx, cy, sizePx, color = '#7aa7d4') {
  if (!ICONS[name]) return;
  const s = sizePx / 24;
  ctx.save();
  ctx.translate(cx - sizePx / 2, cy - sizePx / 2);
  ctx.scale(s, s);
  ctx.strokeStyle = color;
  ctx.lineWidth = 1.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  for (const p of getPaths2D(name)) ctx.stroke(p);
  ctx.restore();
}
