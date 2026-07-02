/**
 * demo.js — VR Mover 2D Interactive Demo
 *
 * Wires together:
 *   - 2D top-down canvas with VR-style interactions:
 *       hover gizmo (move/rotate), click hit-points, object select toggle,
 *       left-drag straight line, right-drag area rectangle,
 *       long-press right-click (or touch long-press) delete
 *   - Editable object catalog (localStorage) synced to the LLM system prompt
 *   - Badge-based contenteditable input editor ([h1]/[o1]/[l1]/[a1] chips)
 *   - Two voice modes: Auto (continuous + auto-submit) and Hold-to-talk
 *   - LLMCore (streaming SSE → StreamingAPIExtractor) from vr-mover.js
 *   - Response panel with per-call status rows
 *   - Welcome modal + guided tour (js/tour.js)
 */

import {
  LLMCore,
  OperatingRound,
  SpeechController,
  loadPromptPack,
  applyPromptSubstitutions,
  timing,
} from './vr-mover.js?v=2';
import { ICONS, ICON_NAMES, iconSVG, drawIcon } from './icons.js';
import { PROVIDERS, applyProviderPreset, createVoiceInput } from './demo-shared.js?v=1';
import { Tour } from './tour.js?v=2';

// ============================================================
// Object catalog — user-editable, persisted to localStorage
// ============================================================
const CATALOG_KEY = 'vrmover_catalog';
const NAME_MAX = 20;
const DESC_MAX = 120;

const DEFAULT_CATALOG = [
  { name: 'Chair',     icon: 'chair',     w: 0.55, d: 0.55, desc: 'A standard four-legged chair' },
  { name: 'Table',     icon: 'table',     w: 1.20, d: 0.80, desc: 'A rectangular dining table' },
  { name: 'Desk',      icon: 'desk',      w: 1.40, d: 0.70, desc: 'An office desk with a drawer' },
  { name: 'Couch',     icon: 'couch',     w: 2.40, d: 0.95, desc: 'A three-seat couch' },
  { name: 'Bookshelf', icon: 'bookshelf', w: 1.00, d: 0.35, desc: 'A tall bookshelf' },
  { name: 'Bed',       icon: 'bed',       w: 1.60, d: 2.10, desc: 'A double bed' },
  { name: 'Wardrobe',  icon: 'wardrobe',  w: 1.20, d: 0.60, desc: 'A two-door wardrobe' },
  { name: 'TV',        icon: 'tv',        w: 1.20, d: 0.12, desc: 'A flat-screen TV' },
  { name: 'Plant',     icon: 'plant',     w: 0.40, d: 0.40, desc: 'A potted plant' },
  { name: 'Cactus',    icon: 'cactus',    w: 0.30, d: 0.30, desc: 'A potted cactus' },
  { name: 'Lamp',      icon: 'lamp',      w: 0.30, d: 0.30, desc: 'A floor lamp' },
  { name: 'Picture',   icon: 'picture',   w: 0.60, d: 0.05, desc: 'A framed picture (very thin)' },
  { name: 'Rug',       icon: 'rug',       w: 2.00, d: 1.40, desc: 'A floor rug' },
];

function loadCatalog() {
  try {
    const raw = localStorage.getItem(CATALOG_KEY);
    if (!raw) return DEFAULT_CATALOG.map(p => ({ ...p }));
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) throw new Error('bad');
    return parsed;
  } catch {
    return DEFAULT_CATALOG.map(p => ({ ...p }));
  }
}

function saveCatalog() {
  localStorage.setItem(CATALOG_KEY, JSON.stringify(state.catalog));
}

function prefab(name) {
  return state.catalog.find(p => p.name === name) ?? null;
}

// ============================================================
// State
// ============================================================
const state = {
  room: { w: 12, d: 10 },

  // Scene objects  { id, prefabId, x, z, angle (rad), w, d, selected, animating }
  objects: [],
  nextId: 1,
  lastCreatedId: null,

  catalog: loadCatalog(),

  // Active operating round + per-round visuals
  round: new OperatingRound(),
  roundN: 0,
  counters: { h: 0, o: 0, l: 0, a: 0 },
  visHits: [],   // { refId, x, z, label, kind }
  visLines: [],  // { refId, a:{x,z}, b:{x,z}, label }
  visAreas: [],  // { refId, x0, z0, x1, z1, label }
  objBadges: new Map(), // objectId -> { hitId, label }
  badgeReg: new Map(),  // token -> { kind, label, refId }

  llm: null,
  llmBusy: false,

  settings: {},

  // Speech
  confirmDelay: 600,

  // Canvas interaction
  gizmoHoverObj: null,      // object whose gizmo zone is hovered (incl. handles)
  deletePending: null,      // { obj, t0 }
  labelRects: [],           // pill rects from last render (for hit testing)
  placePrefab: null,        // armed prefab name for tap-to-place

  // Prompt pack
  systemPromptTemplate: null,
  userFewshot: null,
  assistantFewshot: null,
};

const DRAG_THRESH = 5;       // px before a press becomes a drag
const LONG_PRESS_MS = 600;   // right-click / touch hold delete

// ============================================================
// DOM refs
// ============================================================
const $ = id => document.getElementById(id);
const canvas = $('room-canvas');
const ctx = canvas.getContext('2d');
const respLog = $('resp-log');
const sendBtn = $('send-btn');
const editor = $('editor');
const sttBtn = $('stt-btn');
const statusDot = $('status-dot');
const statusText = $('status-text');
const dragGhost = $('drag-ghost');

// ============================================================
// Settings persistence
// ============================================================
const SETTINGS_KEY = 'vrmover_settings';

const DEFAULT_SETTINGS = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: '',
  model: 'gpt-4o',
  authStyle: 'bearer',
  maxTokens: 2048,
  contextLength: 5,
  confirmDelay: 600,
  temperature: 0.3,
  lang: 'en-US',
  roomW: 12,
  roomD: 10,
  syspromptOverride: '',
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch { return { ...DEFAULT_SETTINGS }; }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

function applySettings(s) {
  state.settings = s;
  state.confirmDelay = s.confirmDelay;
  state.room.w = s.roomW ?? 12;
  state.room.d = s.roomD ?? 10;
  saveSettings(s);
  if (s.apiKey && state.systemPromptTemplate !== null) {
    recreateLLM(s);
  }
}

function settingsToForm(s) {
  $('s-baseurl').value  = s.baseUrl    ?? '';
  $('s-apikey').value   = s.apiKey     ?? '';
  $('s-model').value    = s.model      ?? '';
  $('s-auth').value     = s.authStyle  ?? 'bearer';
  $('s-maxtok').value   = s.maxTokens  ?? 2048;
  $('s-ctxlen').value   = s.contextLength ?? 5;
  $('s-delay').value    = s.confirmDelay  ?? 600;
  $('s-temp').value     = s.temperature   ?? 0.3;
  $('s-lang').value     = s.lang          ?? 'en-US';
  $('s-room-w').value   = s.roomW         ?? 12;
  $('s-room-d').value   = s.roomD         ?? 10;
  $('s-sysprompt').value = s.syspromptOverride ?? '';
  $('s-ctxlen-val').textContent = $('s-ctxlen').value;
  $('s-delay-val').textContent  = $('s-delay').value;
  $('s-temp-val').textContent   = $('s-temp').value;
}

function formToSettings() {
  return {
    baseUrl:         $('s-baseurl').value.trim(),
    apiKey:          $('s-apikey').value.trim(),
    model:           $('s-model').value.trim()   || 'gpt-4o',
    authStyle:       $('s-auth').value,
    maxTokens:       parseInt($('s-maxtok').value)  || 2048,
    contextLength:   parseInt($('s-ctxlen').value)  || 5,
    confirmDelay:    parseInt($('s-delay').value)   || 600,
    temperature:     parseFloat($('s-temp').value)  || 0.3,
    lang:            $('s-lang').value.trim()        || 'en-US',
    roomW:           parseFloat($('s-room-w').value) || 12,
    roomD:           parseFloat($('s-room-d').value) || 10,
    syspromptOverride: $('s-sysprompt').value,
  };
}

// ============================================================
// LLM management
// ============================================================
function buildSystemPrompt(s) {
  const template = (s.syspromptOverride?.trim())
    ? s.syspromptOverride
    : (state.systemPromptTemplate ?? '');

  const prefabsInfo = JSON.stringify(state.catalog.map(p => ({
    prefab_id: p.name,
    description: p.desc || p.name,
    dimensions: { x: p.w.toFixed(2), z: p.d.toFixed(2) },
  })), null, 2);

  const roomInfo = `Room bounds: x=[0, ${state.room.w.toFixed(2)}], z=[0, ${state.room.d.toFixed(2)}]\n` +
                   `Room centre: (${(state.room.w / 2).toFixed(2)}, ${(state.room.d / 2).toFixed(2)})`;

  const envObjs = JSON.stringify([
    { id: 'WallXPositive', name: 'Wall (right)',   position: { x: state.room.w, z: state.room.d / 2 } },
    { id: 'WallXNegative', name: 'Wall (left)',    position: { x: 0, z: state.room.d / 2 } },
    { id: 'WallZPositive', name: 'Wall (back)',    position: { x: state.room.w / 2, z: state.room.d } },
    { id: 'WallZNegative', name: 'Wall (front)',   position: { x: state.room.w / 2, z: 0 } },
  ], null, 2);

  return applyPromptSubstitutions(template, {
    prefabsInfo,
    roomInfo,
    envObjects: envObjs,
  });
}

function resolvedSystemPrompt(s) {
  return buildSystemPrompt(s) ||
    'You are a 2D room design assistant. All coordinates are (x, z) only — no y axis. ' +
    'Reply only with API calls: CREATE("prefab_id"); MOVE("id", x=…, z=…); ' +
    'FORWARD("id", x=…, z=…); LOOKAT("id", x=…, z=…); SCALE("id", x=…, z=…); ' +
    'DELETE("id"); MESSAGE("text");';
}

function recreateLLM(s) {
  state.llm = new LLMCore({
    baseUrl:          s.baseUrl,
    apiKey:           s.apiKey,
    model:            s.model,
    authStyle:        s.authStyle,
    maxTokens:        s.maxTokens,
    temperature:      s.temperature,
    contextLength:    s.contextLength,
    streaming:        $('chk-stream').checked,
    systemPrompt:     resolvedSystemPrompt(s),
    userFewshot:      state.userFewshot,
    assistantFewshot: state.assistantFewshot,
  });
}

/** Called whenever the catalog changes: persist, rebuild UI, resync prompt. */
function catalogChanged() {
  saveCatalog();
  buildPalette();
  if (state.llm) {
    state.llm.updateConfig({ systemPrompt: resolvedSystemPrompt(state.settings) });
    toast('Catalog saved — system prompt updated (conversation reset)', 'success');
  }
  render();
}

// ============================================================
// Scene state → objects array for serialisation
// ============================================================
function sceneObjects() {
  return state.objects.map(o => ({
    object_id: o.id,
    object_name: o.prefabId,
    position: { x: o.x.toFixed(2), z: o.z.toFixed(2) },
    scale: { x: '1.00', z: '1.00' },
    boundary: {
      Central: { x: o.x.toFixed(2), z: o.z.toFixed(2) },
      Size: { x: o.w.toFixed(2), z: o.d.toFixed(2) },
      Forward: {
        x: (-Math.sin(o.angle)).toFixed(2),
        z: (Math.cos(o.angle)).toFixed(2),
      },
    },
  }));
}

// ============================================================
// Canvas — view transform
// ============================================================
const VIEW = { scale: 50, offsetX: 40, offsetY: 30 };

function resizeCanvas() {
  const area = $('canvas-viewport');
  canvas.width  = area.clientWidth;
  canvas.height = area.clientHeight;
  autoScale();
  render();
}

function autoScale() {
  const area = $('canvas-viewport');
  const padX = 56, padY = 44;
  const scaleX = (area.clientWidth  - padX) / state.room.w;
  const scaleY = (area.clientHeight - padY) / state.room.d;
  // Floor at a small positive value so a transient 0-width viewport (before the
  // first layout) can never yield a negative scale and break rendering.
  VIEW.scale   = Math.max(10, Math.min(scaleX, scaleY, 80));
  VIEW.offsetX = (area.clientWidth  - state.room.w * VIEW.scale) / 2;
  VIEW.offsetY = (area.clientHeight - state.room.d * VIEW.scale) / 2;
}

// World → canvas
function wx(x) { return VIEW.offsetX + x * VIEW.scale; }
function wz(z) { return VIEW.offsetY + z * VIEW.scale; }
// Canvas → world
function cw(cx) { return (cx - VIEW.offsetX) / VIEW.scale; }
function cd(cy) { return (cy - VIEW.offsetY) / VIEW.scale; }

const clampX = x => Math.max(0, Math.min(state.room.w, x));
const clampZ = z => Math.max(0, Math.min(state.room.d, z));
const insideRoom = (x, z) => x >= 0 && x <= state.room.w && z >= 0 && z <= state.room.d;

/** Clamp an object position so its rotated bounding box stays in the room. */
function clampObjPos(o, x, z) {
  const c = Math.abs(Math.cos(o.angle)), s = Math.abs(Math.sin(o.angle));
  const hx = (c * o.w + s * o.d) / 2;
  const hz = (s * o.w + c * o.d) / 2;
  return {
    x: Math.max(hx, Math.min(state.room.w - hx, x)),
    z: Math.max(hz, Math.min(state.room.d - hz, z)),
  };
}

const COLOURS = {
  bg:       '#0d1117',
  grid:     '#1a1f27',
  gridMain: '#21262d',
  wall:     '#58a6ff',
  obj:      '#1f3a5f',
  objBorder:'#388bfd',
  selected: '#f0b429',
  forward:  '#3fb950',
  icon:     '#7aa7d4',
  text:     '#c9d1d9',
  muted:    '#8b949e',
  hit:      '#e3b341',
  objHit:   '#58a6ff',
  line:     '#bc8cff',
  area:     '#39d353',
  gizmo:    '#58a6ff',
  roomFill: '#10141a',
  pillBg:   'rgba(22, 27, 34, 0.92)',
};

// A distinct accent per furniture type so the scene reads bright and playful
// rather than a wall of identical blue boxes. Keyed by icon name; falls back
// to the object-border blue for custom icons.
const OBJECT_COLORS = {
  chair:     '#f0883e',   // orange
  table:     '#d2a8ff',   // lilac
  desk:      '#79c0ff',   // sky
  couch:     '#7ee787',   // green
  bookshelf: '#ffa657',   // amber
  bed:       '#a5d6ff',   // light blue
  wardrobe:  '#e3b341',   // gold
  tv:        '#f778ba',   // pink
  plant:     '#3fb950',   // leaf green
  cactus:    '#2ea043',   // cactus green
  lamp:      '#f2cc60',   // warm yellow
  picture:   '#bc8cff',   // purple
  rug:       '#56d4dd',   // teal
  door:      '#8b949e',
  box:       '#a371f7',
  circle:    '#58a6ff',
};

/** Append an alpha byte to a #rrggbb colour → rgba-equivalent #rrggbbaa. */
function hexA(hex, alpha) {
  if (!/^#[0-9a-f]{6}$/i.test(hex)) return hex;
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255).toString(16).padStart(2, '0');
  return hex + a;
}

function objectColor(o) {
  const pf = prefab(o.prefabId);
  return OBJECT_COLORS[pf?.icon] ?? COLOURS.objBorder;
}

/** Pull the theme-dependent canvas colours from the page's CSS variables so the
 *  scene re-themes in lock-step with the rest of the UI (light / dark). */
function refreshCanvasColours() {
  const cs = getComputedStyle(document.documentElement);
  const v = (name, fallback) => {
    const got = cs.getPropertyValue(name).trim();
    return got || fallback;
  };
  COLOURS.bg       = v('--c-bg', '#0d1117');
  COLOURS.grid     = v('--c-grid', '#1a1f27');
  COLOURS.gridMain = v('--c-grid-main', '#21262d');
  COLOURS.roomFill = v('--c-room-fill', '#10141a');
  COLOURS.wall     = v('--c-wall', '#58a6ff');
  COLOURS.text     = v('--text', '#c9d1d9');
  COLOURS.muted    = v('--muted', '#8b949e');
  COLOURS.pillBg   = v('--surface', '#161b22');
}

// ============================================================
// Canvas — render pipeline
// ============================================================
let pointer = null; // active gesture (see onPointerDown)

function render() {
  const W = canvas.width, H = canvas.height;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = COLOURS.bg;
  ctx.fillRect(0, 0, W, H);

  drawGrid();
  drawRoom();
  drawAreas();
  drawLines();
  drawHits();
  drawObjects();
  drawGizmo();
  drawDragPreview();
  drawLabels();
  drawDeleteRing();
}

function drawGrid() {
  const x0 = Math.floor(cw(0)), x1 = Math.ceil(cw(canvas.width));
  const z0 = Math.floor(cd(0)), z1 = Math.ceil(cd(canvas.height));
  for (let xi = x0; xi <= x1; xi++) {
    const isMain = xi % 5 === 0;
    ctx.strokeStyle = isMain ? COLOURS.gridMain : COLOURS.grid;
    ctx.lineWidth = isMain ? 0.8 : 0.5;
    ctx.beginPath();
    ctx.moveTo(wx(xi), 0); ctx.lineTo(wx(xi), canvas.height);
    ctx.stroke();
  }
  for (let zi = z0; zi <= z1; zi++) {
    const isMain = zi % 5 === 0;
    ctx.strokeStyle = isMain ? COLOURS.gridMain : COLOURS.grid;
    ctx.lineWidth = isMain ? 0.8 : 0.5;
    ctx.beginPath();
    ctx.moveTo(0, wz(zi)); ctx.lineTo(canvas.width, wz(zi));
    ctx.stroke();
  }
}

function drawRoom() {
  const x = wx(0), y = wz(0);
  const rw = state.room.w * VIEW.scale;
  const rd = state.room.d * VIEW.scale;
  const rr = 14;   // rounded floor corners

  // Soft floor with a gentle diagonal tint for a less flat look
  const grad = ctx.createLinearGradient(x, y, x + rw, y + rd);
  grad.addColorStop(0, COLOURS.roomFill);
  grad.addColorStop(1, hexA(COLOURS.wall, 0.06));
  ctx.save();
  ctx.beginPath();
  ctx.roundRect(x, y, rw, rd, rr);
  ctx.fillStyle = COLOURS.roomFill;
  ctx.fill();
  ctx.fillStyle = grad;
  ctx.fill();
  // Accent wall outline
  ctx.lineWidth = 3;
  ctx.strokeStyle = COLOURS.wall;
  ctx.stroke();
  ctx.restore();

  // Compass labels (N tinted to anchor orientation)
  ctx.font = '600 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = COLOURS.wall;
  ctx.fillText('N', x + rw / 2, y - 8);
  ctx.fillStyle = COLOURS.muted;
  ctx.fillText('S', x + rw / 2, y + rd + 14);
  ctx.textAlign = 'left';
  ctx.fillText('W', x - 14, y + rd / 2 + 4);
  ctx.textAlign = 'right';
  ctx.fillText('E', x + rw + 14, y + rd / 2 + 4);

  // Scale bar
  const barM = 2;
  const barPx = barM * VIEW.scale;
  const bx = x + 4;
  const by = y + rd + 14;
  ctx.strokeStyle = COLOURS.muted;
  ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(bx + barPx, by); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx, by - 4); ctx.lineTo(bx, by + 4); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(bx + barPx, by - 4); ctx.lineTo(bx + barPx, by + 4); ctx.stroke();
  ctx.fillStyle = COLOURS.muted;
  ctx.font = '9px Inter, sans-serif';
  ctx.textAlign = 'left';
  ctx.fillText(`${barM} m`, bx + barPx + 6, by + 3);
}

function drawHits() {
  ctx.font = '700 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'alphabetic';
  for (const h of state.visHits) {
    const x = wx(h.x), y = wz(h.z);
    const col = h.kind === 'o' ? COLOURS.objHit : COLOURS.hit;
    ctx.strokeStyle = col;
    ctx.fillStyle = col + '33';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 7, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.arc(x, y, 1.6, 0, Math.PI * 2);
    ctx.fillStyle = col;
    ctx.fill();
    ctx.fillText(h.label, x, y - 11);
  }
}

function drawLines() {
  ctx.font = '700 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  for (const l of state.visLines) {
    drawLineShape(l.a, l.b, COLOURS.line, 1);
    ctx.fillStyle = COLOURS.line;
    ctx.fillText(l.label, (wx(l.a.x) + wx(l.b.x)) / 2, (wz(l.a.z) + wz(l.b.z)) / 2 - 8);
  }
}

function drawLineShape(a, b, col, alpha) {
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = col;
  ctx.lineWidth = 2;
  ctx.setLineDash([5, 4]);
  ctx.beginPath();
  ctx.moveTo(wx(a.x), wz(a.z));
  ctx.lineTo(wx(b.x), wz(b.z));
  ctx.stroke();
  ctx.setLineDash([]);
  ctx.fillStyle = col;
  for (const p of [a, b]) {
    ctx.beginPath();
    ctx.arc(wx(p.x), wz(p.z), 3, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
}

function drawAreas() {
  ctx.font = '700 10px Inter, sans-serif';
  ctx.textAlign = 'left';
  for (const a of state.visAreas) {
    drawAreaShape(a.x0, a.z0, a.x1, a.z1, COLOURS.area, 1);
    ctx.fillStyle = COLOURS.area;
    ctx.fillText(a.label, wx(Math.min(a.x0, a.x1)) + 4, wz(Math.min(a.z0, a.z1)) + 13);
  }
}

function drawAreaShape(x0, z0, x1, z1, col, alpha) {
  const x = wx(Math.min(x0, x1)), y = wz(Math.min(z0, z1));
  const w = Math.abs(x1 - x0) * VIEW.scale, h = Math.abs(z1 - z0) * VIEW.scale;
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = col + '1c';
  ctx.fillRect(x, y, w, h);
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.setLineDash([5, 4]);
  ctx.strokeRect(x, y, w, h);
  ctx.setLineDash([]);
  ctx.restore();
}

function drawObjects() {
  for (const o of state.objects) drawObject(o);
}

function drawObject(o) {
  const cx = wx(o.x), cz = wz(o.z);
  const pw = o.w * VIEW.scale, pd = o.d * VIEW.scale;
  const hw = pw / 2, hd = pd / 2;
  const pf = prefab(o.prefabId);

  const color = objectColor(o);
  const r = Math.max(0, Math.min(6, hw, hd));   // rounded corners (never negative)

  ctx.save();
  ctx.translate(cx, cz);
  ctx.rotate(o.angle);

  // Soft drop shadow
  ctx.fillStyle = 'rgba(0,0,0,0.22)';
  ctx.beginPath();
  ctx.roundRect(-hw + 2, -hd + 3, pw, pd, r);
  ctx.fill();

  // Coloured body — translucent tint fill with a saturated border per type
  ctx.fillStyle = o.animating ? hexA(COLOURS.forward, 0.4) : hexA(color, 0.26);
  ctx.strokeStyle = o.selected ? COLOURS.selected
                  : (state.gizmoHoverObj === o ? '#ffffff' : color);
  ctx.lineWidth = o.selected ? 2.5 : 1.5;
  ctx.beginPath();
  ctx.roundRect(-hw, -hd, pw, pd, r);
  ctx.fill();
  ctx.stroke();

  // Icon glyph. Small objects (lamp, cactus…) keep a legible minimum size even
  // when their footprint is tiny, so the glyph never silently disappears.
  const minDim = Math.min(pw, pd);
  if (pf?.icon && ICONS[pf.icon] && minDim >= 9) {
    const iconPx = Math.min(46, Math.max(13, minDim * 0.72));
    drawIcon(ctx, pf.icon, 0, 0, iconPx, color);
  }

  // Forward arrow along local +z (canvas "down" pre-rotation) — consistent
  // with sceneObjects() and the FORWARD/LOOKAT handlers.
  if (hd >= 10 && hw >= 6) {
    const tip = hd - 3;
    ctx.strokeStyle = COLOURS.forward;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(0, Math.max(hd * 0.45, tip - 10));
    ctx.lineTo(0, tip - 4);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(0, tip);
    ctx.lineTo(-3.5, tip - 5);
    ctx.lineTo(3.5, tip - 5);
    ctx.closePath();
    ctx.fillStyle = COLOURS.forward;
    ctx.fill();
  }

  ctx.restore();
}

// ── Gizmo (standard top-down: box + centre move + top rotate handle) ──
const GIZMO = {
  moveHalf: 8,      // half-size of centre square handle (px)
  rotateR: 10,      // rotate handle disc radius (px)
  stemLen: 28,      // stem from top edge to rotate handle centre (px)
  hitMove: 14,      // pointer hit radius for centre handle
  hitRotate: 20,    // pointer hit radius for rotate handle
  hitTouch: 28,     // larger for touch
  smallPx: 36,      // footprints smaller than this get the move handle OUTSIDE
  moveOut: 16,      // gap from the box edge to the offset move handle (px)
};

/** Distance from point (px,py) to line segment (x1,y1)-(x2,y2). */
function distToSegment(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1, dy = y2 - y1;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(px - x1, py - y1);
  let t = ((px - x1) * dx + (py - y1) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
}

function gizmoTarget() {
  if (pointer?.mode === 'gizmo-move' || pointer?.mode === 'gizmo-rotate') return pointer.obj;
  if (state.gizmoHoverObj) return state.gizmoHoverObj;
  const sel = state.objects.filter(o => o.selected);
  return sel.length === 1 ? sel[0] : null;
}

/** Canvas-space geometry for one object's manipulation gizmo. */
function gizmoGeometry(o) {
  const cx = wx(o.x), cz = wz(o.z);
  const hw = o.w * VIEW.scale / 2;
  const hd = o.d * VIEW.scale / 2;
  const a = o.angle;
  const cos = Math.cos(a), sin = Math.sin(a);

  // Forward-edge midpoint in canvas space (local z = +hd) — the stem and rotate
  // handle sit on the object's FORWARD side so the gizmo agrees with the green
  // forward arrow and with sceneObjects()/FORWARD/LOOKAT (forward = local +z).
  const edgeX = cx - hd * sin;
  const edgeY = cz + hd * cos;
  const normX = -sin, normY = cos;        // canvas-space forward direction
  const rotX = edgeX + normX * GIZMO.stemLen;
  const rotY = edgeY + normY * GIZMO.stemLen;

  // Rotated box corners for selection outline
  const corners = [
    { x: -hw, z: -hd }, { x: hw, z: -hd },
    { x: hw, z: hd }, { x: -hw, z: hd },
  ].map(p => ({
    x: cx + p.x * cos - p.z * sin,
    y: cz + p.x * sin + p.z * cos,
  }));

  // For small objects the centre move handle would cover the whole body and block
  // selection, so push it OUTSIDE along the object's local −x (left) side and draw
  // a short connector to it — the body itself stays clickable to select.
  const small = Math.min(o.w, o.d) * VIEW.scale < GIZMO.smallPx;
  let moveX = cx, moveY = cz;
  if (small) {
    const d = hw + GIZMO.moveOut;
    moveX = cx - cos * d;   // local −x direction in canvas = (−cos, −sin)
    moveY = cz - sin * d;
  }

  return { cx, cz, hw, hd, a, cos, sin, edgeX, edgeY, rotX, rotY, normX, normY,
           corners, small, moveX, moveY };
}

/** True when (cx,cy) is inside this object's gizmo hit zone (body, box, stem, handles).
 *  This must be generous so the gizmo stays visible as the cursor travels between handles. */
function gizmoHitZone(o, cx, cy, isTouch) {
  if (pickObject(cx, cy) === o) return true;
  const g = gizmoGeometry(o);
  const hr = isTouch ? GIZMO.hitTouch : 16;

  // Move handle area (centre, or offset for small objects)
  if (Math.hypot(cx - g.moveX, cy - g.moveY) <= GIZMO.moveHalf + hr) return true;
  // Rotate handle area
  if (Math.hypot(cx - g.rotX, cy - g.rotY) <= (isTouch ? GIZMO.hitTouch : GIZMO.hitRotate + 4)) return true;
  // Stem corridor — generous width so cursor can't slip off while travelling to the handle
  if (distToSegment(cx, cy, g.edgeX, g.edgeY, g.rotX, g.rotY) <= hr) return true;
  // Extended from centre to edge midpoint
  if (distToSegment(cx, cy, g.cx, g.cz, g.edgeX, g.edgeY) <= hr) return true;

  // Inside rotated bounding box (with generous padding)
  const lx = (cx - g.cx) * g.cos + (cy - g.cz) * g.sin;
  const lz = -(cx - g.cx) * g.sin + (cy - g.cz) * g.cos;
  const pad = 14;
  if (Math.abs(lx) <= g.hw + pad && Math.abs(lz) <= g.hd + pad) return true;

  return false;
}

/** Top-most object whose gizmo zone contains (cx, cy). */
function findGizmoObjectAt(cx, cy, isTouch) {
  for (let i = state.objects.length - 1; i >= 0; i--) {
    if (gizmoHitZone(state.objects[i], cx, cy, isTouch)) return state.objects[i];
  }
  return null;
}

function drawGizmo() {
  const o = gizmoTarget();
  if (!o) return;
  const g = gizmoGeometry(o);
  const activeMove = pointer?.mode === 'gizmo-move';
  const activeRot = pointer?.mode === 'gizmo-rotate';

  ctx.save();

  // ── Selection box (dashed, rotated) ──
  ctx.strokeStyle = activeMove || activeRot ? '#79c0ff' : '#58a6ff88';
  ctx.lineWidth = 1.2;
  ctx.setLineDash([4, 3]);
  ctx.beginPath();
  g.corners.forEach((p, i) => {
    if (i === 0) ctx.moveTo(p.x, p.y); else ctx.lineTo(p.x, p.y);
  });
  ctx.closePath();
  ctx.stroke();
  ctx.setLineDash([]);

  // ── Stem from top edge to rotate handle ──
  ctx.strokeStyle = activeRot ? '#f59e0b' : '#f0883eaa';
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(g.edgeX, g.edgeY);
  ctx.lineTo(g.rotX, g.rotY);
  ctx.stroke();

  // Small circle at the stem base (anchor point)
  ctx.beginPath();
  ctx.arc(g.edgeX, g.edgeY, 3, 0, Math.PI * 2);
  ctx.fillStyle = activeRot ? '#f59e0b' : '#f0883eaa';
  ctx.fill();

  // ── Rotate handle disc ──
  const rr = GIZMO.rotateR;
  ctx.beginPath();
  ctx.arc(g.rotX, g.rotY, rr, 0, Math.PI * 2);
  ctx.fillStyle = activeRot ? '#f59e0b' : '#2a1a08';
  ctx.fill();
  ctx.strokeStyle = activeRot ? '#fbbf24' : '#f0883e';
  ctx.lineWidth = 2;
  ctx.stroke();
  // Curved arrow glyph
  const arcR = rr - 3.5;
  ctx.strokeStyle = activeRot ? '#fff' : '#f0883e';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(g.rotX, g.rotY, arcR, -Math.PI * 0.8, Math.PI * 0.3);
  ctx.stroke();
  // Arrow tip at the end of the arc
  const tipA = Math.PI * 0.3;
  const atx = g.rotX + arcR * Math.cos(tipA);
  const aty = g.rotY + arcR * Math.sin(tipA);
  ctx.beginPath();
  ctx.moveTo(atx, aty);
  ctx.lineTo(atx + Math.cos(tipA - 1.2) * 5, aty + Math.sin(tipA - 1.2) * 5);
  ctx.lineTo(atx + Math.cos(tipA + 0.6) * 4, aty + Math.sin(tipA + 0.6) * 4);
  ctx.closePath();
  ctx.fillStyle = activeRot ? '#fff' : '#f0883e';
  ctx.fill();

  // ── Move handle (filled square + cross arrows). For small objects it sits
  //    OUTSIDE the body with a short connector so the body stays clickable. ──
  const mx = g.moveX, my = g.moveY;
  if (g.small) {
    ctx.strokeStyle = activeMove ? '#79c0ff' : '#388bfdaa';
    ctx.lineWidth = 1.5;
    ctx.setLineDash([3, 2]);
    ctx.beginPath();
    ctx.moveTo(g.cx, g.cz);
    ctx.lineTo(mx, my);
    ctx.stroke();
    ctx.setLineDash([]);
  }
  const hs = GIZMO.moveHalf;
  ctx.beginPath();
  ctx.roundRect(mx - hs, my - hs, hs * 2, hs * 2, 2);
  ctx.fillStyle = activeMove ? '#388bfd' : '#e6edf3';
  ctx.fill();
  ctx.strokeStyle = activeMove ? '#79c0ff' : '#388bfd';
  ctx.lineWidth = 1.8;
  ctx.stroke();
  // Cross arrows
  const colArrow = activeMove ? '#fff' : '#1f6feb';
  ctx.strokeStyle = colArrow;
  ctx.lineWidth = 1.4;
  const ar = hs - 2;
  ctx.beginPath();
  ctx.moveTo(mx - ar, my); ctx.lineTo(mx + ar, my);
  ctx.moveTo(mx, my - ar); ctx.lineTo(mx, my + ar);
  ctx.stroke();
  for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
    const tx = mx + dx * ar, ty = my + dy * ar;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - dy * 2.5 - dx * 2, ty + dx * 2.5 - dy * 2);
    ctx.lineTo(tx + dy * 2.5 - dx * 2, ty - dx * 2.5 - dy * 2);
    ctx.closePath();
    ctx.fillStyle = colArrow;
    ctx.fill();
  }

  ctx.restore();
}

/** Which gizmo handle (if any) is under canvas point (cx, cy)? */
function gizmoHandleAt(cx, cy, isTouch) {
  const o = gizmoTarget();
  if (!o) return null;
  const g = gizmoGeometry(o);
  const hitRot = isTouch ? GIZMO.hitTouch : GIZMO.hitRotate;
  const hitMove = isTouch ? GIZMO.hitTouch : GIZMO.hitMove + GIZMO.moveHalf;

  // 1) Rotate handle disc — sits well outside the footprint.
  if (Math.hypot(cx - g.rotX, cy - g.rotY) <= hitRot) return { type: 'rotate', obj: o };
  // 2) Move handle (centre, or offset outside for small objects) — checked before
  //    the stem corridor so grabbing it always moves.
  if (Math.hypot(cx - g.moveX, cy - g.moveY) <= hitMove) return { type: 'move', obj: o };
  // 3) Stem between the forward edge and the rotate handle → rotate.
  const stemHit = isTouch ? GIZMO.hitTouch : GIZMO.hitRotate;
  if (distToSegment(cx, cy, g.edgeX, g.edgeY, g.rotX, g.rotY) <= stemHit) return { type: 'rotate', obj: o };
  return null;
}

// ── Drag previews (line / area) ─────────────────────────────
function drawDragPreview() {
  if (!pointer) return;
  if (pointer.mode === 'line' && pointer.curr) {
    drawLineShape(pointer.start, pointer.curr, COLOURS.line, 0.55);
  }
  if (pointer.mode === 'area' && pointer.curr) {
    drawAreaShape(pointer.start.x, pointer.start.z, pointer.curr.x, pointer.curr.z, COLOURS.area, 0.55);
  }
}

// ── External pill labels with greedy collision placement ────
function rectsIntersect(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

function drawLabels() {
  state.labelRects = [];
  const placed = [];
  ctx.font = '600 10px Inter, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  for (const o of state.objects) {
    const label = `${o.prefabId} ${parseInt(o.id, 10)}`;
    const tw = ctx.measureText(label).width;
    const pw = tw + 14, ph = 16;
    const cx = wx(o.x), cz = wz(o.z);

    // Rotated-footprint AABB half-extents in px
    const c = Math.abs(Math.cos(o.angle)), s = Math.abs(Math.sin(o.angle));
    const hx = (c * o.w + s * o.d) * VIEW.scale / 2;
    const hz = (s * o.w + c * o.d) * VIEW.scale / 2;
    const gap = 7;

    // Candidate anchors: above, below, right, left, then radial rings
    const candidates = [
      { x: cx, y: cz - hz - gap - ph / 2 },
      { x: cx, y: cz + hz + gap + ph / 2 },
      { x: cx + hx + gap + pw / 2, y: cz },
      { x: cx - hx - gap - pw / 2, y: cz },
    ];
    for (let ring = 1; ring <= 3; ring++) {
      for (let k = 0; k < 8; k++) {
        const ang = -Math.PI / 2 + k * Math.PI / 4;
        candidates.push({
          x: cx + Math.cos(ang) * (hx + gap + ring * 20 + pw / 2),
          y: cz + Math.sin(ang) * (hz + gap + ring * 18 + ph / 2),
        });
      }
    }

    let rect = null;
    for (const cand of candidates) {
      const rr = { x: cand.x - pw / 2, y: cand.y - ph / 2, w: pw, h: ph };
      if (rr.x < 2 || rr.y < 2 ||
          rr.x + rr.w > canvas.width - 2 || rr.y + rr.h > canvas.height - 2) continue;
      if (placed.some(p => rectsIntersect(p, rr))) continue;
      rect = rr;
      break;
    }
    if (!rect) rect = { x: cx - pw / 2, y: cz - hz - gap - ph, w: pw, h: ph };
    placed.push(rect);

    const px = rect.x + rect.w / 2, py = rect.y + rect.h / 2;

    // Leader line (drawn first; the pill covers its near end)
    if (Math.hypot(px - cx, py - cz) > 4) {
      ctx.strokeStyle = '#8b949e66';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px, py);
      ctx.lineTo(cx, cz);
      ctx.stroke();
    }

    // Pill
    ctx.fillStyle = COLOURS.pillBg;
    ctx.strokeStyle = o.selected ? COLOURS.selected
                    : (state.gizmoHoverObj === o ? COLOURS.gizmo : '#30363d');
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(rect.x, rect.y, rect.w, rect.h, 8);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = o.selected ? COLOURS.selected : COLOURS.text;
    ctx.fillText(label, px, py + 0.5);

    state.labelRects.push({ ...rect, obj: o });
  }
  ctx.textBaseline = 'alphabetic';
}

// ── Long-press delete progress ring ─────────────────────────
function drawDeleteRing() {
  const dp = state.deletePending;
  if (!dp) return;
  const t = Math.min((performance.now() - dp.t0) / LONG_PRESS_MS, 1);
  const cx = wx(dp.obj.x), cz = wz(dp.obj.z);
  const r = Math.max(dp.obj.w, dp.obj.d) * VIEW.scale / 2 + 10;
  ctx.strokeStyle = '#f8514955';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.arc(cx, cz, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = '#f85149';
  ctx.beginPath();
  ctx.arc(cx, cz, r, -Math.PI / 2, -Math.PI / 2 + t * Math.PI * 2);
  ctx.stroke();
}

function startDeletePending(obj) {
  state.deletePending = { obj, t0: performance.now() };
  requestAnimationFrame(deleteTick);
}

function deleteTick() {
  const dp = state.deletePending;
  if (!dp) return;
  if (performance.now() - dp.t0 >= LONG_PRESS_MS) {
    state.deletePending = null;
    removeObjectFromScene(dp.obj);
    toast(`Deleted ${dp.obj.prefabId} ${parseInt(dp.obj.id, 10)}`, 'info');
    pointer = null;
    render();
    return;
  }
  render();
  requestAnimationFrame(deleteTick);
}

function cancelDeletePending() {
  if (state.deletePending) {
    state.deletePending = null;
    render();
  }
}

// ============================================================
// Object management
// ============================================================
function createObject(prefabName, x, z) {
  const pf = prefab(prefabName);
  if (!pf) return null;
  const id = String(state.nextId++).padStart(6, '0');
  const pos = clampObjPos({ w: pf.w, d: pf.d, angle: 0 }, x, z);
  const obj = { id, prefabId: pf.name, x: pos.x, z: pos.z, w: pf.w, d: pf.d,
                angle: 0, selected: false, animating: false };
  state.objects.push(obj);
  state.lastCreatedId = id;
  render();
  return obj;
}

function findObjectById(id) {
  if (id === 'crt') return state.objects.find(o => o.id === state.lastCreatedId) ?? null;
  return state.objects.find(o => o.id === id) ?? null;
}

/** Hit-test canvas point against label pills first, then object bodies. */
function pickObject(cx, cy) {
  for (const r of state.labelRects) {
    if (cx >= r.x && cx <= r.x + r.w && cy >= r.y && cy <= r.y + r.h) return r.obj;
  }
  for (let i = state.objects.length - 1; i >= 0; i--) {
    const o = state.objects[i];
    const dx = cw(cx) - o.x;
    const dz = cd(cy) - o.z;
    const localX = dx * Math.cos(-o.angle) - dz * Math.sin(-o.angle);
    const localZ = dx * Math.sin(-o.angle) + dz * Math.cos(-o.angle);
    if (Math.abs(localX) <= o.w / 2 && Math.abs(localZ) <= o.d / 2) return o;
  }
  return null;
}

function deselectObject(o) {
  o.selected = false;
  const meta = state.objBadges.get(o.id);
  if (meta) removeSceneMarker(meta.hitId, 'o', { removeEditorBadge: true });
}

function removeObjectFromScene(o) {
  if (o.selected) deselectObject(o);
  const idx = state.objects.indexOf(o);
  if (idx !== -1) state.objects.splice(idx, 1);
  if (state.gizmoHoverObj === o) state.gizmoHoverObj = null;
  render();
}

function clearSelection() {
  for (const o of state.objects) {
    if (o.selected) deselectObject(o);
  }
  render();
}

// ============================================================
// LLM API call executor — returns { ok, error? }
// ============================================================
function executeLLMCall(fn, args) {
  switch (fn) {
    case 'CREATE': {
      const pf = prefab(args.id);
      if (!pf) return { ok: false, error: `Unknown prefab "${args.id}"` };
      // Spawn at room centre; the LLM follows up with MOVE("crt", …)
      createObject(pf.name, state.room.w / 2, state.room.d / 2);
      return { ok: true };
    }
    case 'MOVE': {
      const o = findObjectById(args.id);
      if (!o) return { ok: false, error: `No object "${args.id}" in the scene` };
      const newX = args.x !== undefined ? args.x : o.x;
      const newZ = args.z !== undefined ? args.z : o.z;
      const pos = clampObjPos(o, newX, newZ);
      animateObject(o.id, { x: pos.x, z: pos.z });
      return { ok: true };
    }
    case 'FORWARD': {
      const o = findObjectById(args.id);
      if (!o) return { ok: false, error: `No object "${args.id}" in the scene` };
      if (args.x !== undefined || args.z !== undefined) {
        const fx = args.x ?? 0;
        const fz = args.z ?? 1;
        animateObject(o.id, { angle: Math.atan2(-fx, fz) });
      }
      return { ok: true };
    }
    case 'LOOKAT': {
      const o = findObjectById(args.id);
      if (!o) return { ok: false, error: `No object "${args.id}" in the scene` };
      if (args.x !== undefined || args.z !== undefined) {
        const dx = (args.x ?? o.x) - o.x;
        const dz = (args.z ?? o.z) - o.z;
        animateObject(o.id, { angle: Math.atan2(-dx, dz) });
      }
      return { ok: true };
    }
    case 'SCALE': {
      const o = findObjectById(args.id);
      if (!o) return { ok: false, error: `No object "${args.id}" in the scene` };
      const pf = prefab(o.prefabId);
      if (!pf) return { ok: false, error: `Prefab "${o.prefabId}" missing from catalog` };
      const sx = args.x ?? 1, sz = args.z ?? 1;
      animateObject(o.id, { w: pf.w * sx, d: pf.d * sz });
      return { ok: true };
    }
    case 'DELETE': {
      const o = findObjectById(args.id);
      if (!o) return { ok: false, error: `No object "${args.id}" in the scene` };
      removeObjectFromScene(o);
      return { ok: true };
    }
    case 'MESSAGE': {
      toast(args.content ?? '', 'info');
      return { ok: true };
    }
    case 'EXPLAIN':
      return { ok: true };
    default:
      return { ok: false, error: `Unknown API "${fn}"` };
  }
}

// Smooth animation for object state changes
function animateObject(id, target, durationMs = 250) {
  const o = state.objects.find(obj => obj.id === id);
  if (!o) return;

  const start = { x: o.x, z: o.z, angle: o.angle, w: o.w, d: o.d };
  const end   = { x: target.x ?? o.x, z: target.z ?? o.z,
                  angle: target.angle ?? o.angle,
                  w: target.w ?? o.w, d: target.d ?? o.d };

  // Rotate through the shortest arc
  let dAngle = end.angle - start.angle;
  dAngle = ((dAngle + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI;

  const t0 = timing.nowMs();
  o.animating = true;

  function step() {
    const elapsed = timing.nowMs() - t0;
    const t = Math.min(elapsed / durationMs, 1);
    const ease = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;

    o.x     = start.x     + (end.x - start.x) * ease;
    o.z     = start.z     + (end.z - start.z) * ease;
    o.angle = start.angle + dAngle * ease;
    o.w     = start.w     + (end.w - start.w) * ease;
    o.d     = start.d     + (end.d - start.d) * ease;
    render();

    if (t < 1) {
      requestAnimationFrame(step);
    } else {
      o.x = end.x; o.z = end.z;
      o.angle = start.angle + dAngle;
      o.w = end.w; o.d = end.d;
      o.animating = false;
      render();
    }
  }
  requestAnimationFrame(step);
}

// ============================================================
// Badge-based input editor
// ============================================================
const BADGE_KINDS = { h: 'ibadge-h', o: 'ibadge-o', l: 'ibadge-l', a: 'ibadge-a' };
let draggedBadge = null;

function makeBadge(kind, label, token, refId) {
  const span = document.createElement('span');
  span.className = `ibadge ${BADGE_KINDS[kind] ?? 'ibadge-h'}`;
  span.contentEditable = 'false';
  span.draggable = true;
  span.dataset.token = token;
  span.dataset.kind = kind;
  span.dataset.ref = refId;
  span.textContent = label;
  return span;
}

/* The interim-ghost editor helpers live in the shared voice module
   (demo-shared.js); thin wrappers keep the local call sites unchanged. */
function interimNode() { return voice.interimNode(); }
function insertAtEnd(node) { voice.insertAtEnd(node); }

function insertBadge(kind, label, token, refId) {
  state.badgeReg.set(token, { kind, label, refId });
  // Ensure a space before the badge if the preceding content doesn't end in one
  const ghost = interimNode();
  const prev = ghost ? ghost.previousSibling : editor.lastChild;
  if (prev && !(prev.nodeType === Node.TEXT_NODE && /\s$/.test(prev.data))) {
    insertAtEnd(document.createTextNode(' '));
  }
  insertAtEnd(makeBadge(kind, label, token, refId));
  insertAtEnd(document.createTextNode(' '));
  editor.scrollTop = editor.scrollHeight;
}

function removeBadgeByRef(refId) {
  editor.querySelectorAll('.ibadge').forEach(b => {
    if (b.dataset.ref === refId) b.remove();
  });
}

/** Remove a canvas marker + round data when its editor badge is deleted. */
let syncingMarkers = false;

function removeSceneMarker(refId, kind, { removeEditorBadge = false } = {}) {
  if (!refId || syncingMarkers) return;
  syncingMarkers = true;

  if (removeEditorBadge) removeBadgeByRef(refId);

  state.round.removeHit(refId);
  state.round.removeDrawing(refId);
  state.visHits = state.visHits.filter(h => h.refId !== refId);
  state.visLines = state.visLines.filter(l => l.refId !== refId);
  state.visAreas = state.visAreas.filter(a => a.refId !== refId);

  for (const [token, meta] of [...state.badgeReg.entries()]) {
    if (meta.refId === refId) state.badgeReg.delete(token);
  }

  if (kind === 'o' || state.objBadges.size) {
    for (const [objId, meta] of [...state.objBadges.entries()]) {
      if (meta.hitId === refId) {
        const o = findObjectById(objId);
        if (o) o.selected = false;
        state.objBadges.delete(objId);
      }
    }
  }

  syncingMarkers = false;
  render();
}

function onBadgeRemovedFromEditor(badgeEl) {
  if (!badgeEl?.dataset?.ref) return;
  removeSceneMarker(badgeEl.dataset.ref, badgeEl.dataset.kind, { removeEditorBadge: false });
}

function clearInterim() { voice.clearInterim(); }

/** Serialize editor content (badges → tokens, interim ignored). */
function serializeEditor() {
  const out = [];
  (function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.data); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList.contains('interim')) return;
    if (node.classList.contains('ibadge')) { out.push(` ${node.dataset.token} `); return; }
    if (node.tagName === 'BR') { out.push(' '); return; }
    for (const c of node.childNodes) walk(c);
    if (node.tagName === 'DIV' || node.tagName === 'P') out.push(' ');
  })(editor);
  return out.join('').replace(/\s+/g, ' ').trim();
}

/** Serialize an arbitrary fragment (for copy/cut). */
function serializeFragment(frag) {
  const out = [];
  (function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) { out.push(node.data); return; }
    if (node.nodeType !== Node.ELEMENT_NODE) return;
    if (node.classList?.contains('interim')) return;
    if (node.classList?.contains('ibadge')) { out.push(` ${node.dataset.token} `); return; }
    if (node.tagName === 'BR') { out.push(' '); return; }
    for (const c of node.childNodes) walk(c);
  })(frag);
  return out.join('').replace(/\s+/g, ' ').trim();
}

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Parse plain text into a fragment, turning known tokens back into badges. */
function parseTextToFragment(text) {
  const frag = document.createDocumentFragment();
  const tokens = [...state.badgeReg.keys()];
  if (tokens.length === 0) {
    frag.appendChild(document.createTextNode(text));
    return frag;
  }
  const re = new RegExp(tokens.map(escapeRegExp).join('|'), 'g');
  let last = 0, m;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
    const meta = state.badgeReg.get(m[0]);
    frag.appendChild(makeBadge(meta.kind, meta.label, m[0], meta.refId));
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
  return frag;
}

function setupEditor() {
  // Badge removed (backspace, cut, drag-out) → sync canvas markers.
  // Two strategies: MutationObserver catches DOM node removals in most cases;
  // the `input` event fallback handles edge cases where the browser replaces
  // the entire element subtree without firing individual removedNodes.
  const badgeObserver = new MutationObserver(mutations => {
    if (syncingMarkers) return;
    for (const m of mutations) {
      for (const node of m.removedNodes) {
        if (node.nodeType !== Node.ELEMENT_NODE) continue;
        if (node.classList?.contains('ibadge')) onBadgeRemovedFromEditor(node);
        else node.querySelectorAll?.('.ibadge').forEach(onBadgeRemovedFromEditor);
      }
    }
  });
  badgeObserver.observe(editor, { childList: true, subtree: true });

  // Fallback: after any input, check if any tracked refs are missing from the DOM
  editor.addEventListener('input', () => {
    if (syncingMarkers) return;
    const presentRefs = new Set();
    editor.querySelectorAll('.ibadge').forEach(b => presentRefs.add(b.dataset.ref));
    for (const [token, meta] of [...state.badgeReg.entries()]) {
      if (!presentRefs.has(meta.refId)) {
        removeSceneMarker(meta.refId, meta.kind, { removeEditorBadge: false });
      }
    }
  });

  // Enter submits; Shift+Enter inserts a line break
  editor.addEventListener('keydown', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendRound();
    }
  });

  // Copy / cut serialize badges to token text
  editor.addEventListener('copy', e => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    e.clipboardData.setData('text/plain', serializeFragment(range.cloneContents()));
    e.preventDefault();
  });
  editor.addEventListener('cut', e => {
    const sel = window.getSelection();
    if (!sel.rangeCount || sel.isCollapsed) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    const frag = range.cloneContents();
    e.clipboardData.setData('text/plain', serializeFragment(frag));
    range.deleteContents();
    e.preventDefault();
  });

  // Paste parses tokens back into badge chips
  editor.addEventListener('paste', e => {
    e.preventDefault();
    const text = e.clipboardData.getData('text/plain');
    if (!text) return;
    const sel = window.getSelection();
    if (!sel.rangeCount) return;
    const range = sel.getRangeAt(0);
    if (!editor.contains(range.commonAncestorContainer)) return;
    range.deleteContents();
    const frag = parseTextToFragment(text);
    const lastNode = frag.lastChild;
    range.insertNode(frag);
    if (lastNode) {
      const after = document.createRange();
      after.setStartAfter(lastNode);
      after.collapse(true);
      sel.removeAllRanges();
      sel.addRange(after);
    }
  });

  // Badge drag-to-reorder within the editor
  editor.addEventListener('dragstart', e => {
    const badge = e.target.closest?.('.ibadge');
    if (!badge) return;
    draggedBadge = badge;
    badge.classList.add('drag-src');
    e.dataTransfer.setData('text/plain', ` ${badge.dataset.token} `);
    e.dataTransfer.effectAllowed = 'move';
  });
  editor.addEventListener('dragend', () => {
    draggedBadge?.classList.remove('drag-src');
    draggedBadge = null;
  });
  editor.addEventListener('dragover', e => {
    if (draggedBadge) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
    }
  });
  editor.addEventListener('drop', e => {
    if (!draggedBadge) return;
    e.preventDefault();
    let range = null;
    if (document.caretRangeFromPoint) {
      range = document.caretRangeFromPoint(e.clientX, e.clientY);
    } else if (document.caretPositionFromPoint) {
      const pos = document.caretPositionFromPoint(e.clientX, e.clientY);
      if (pos) {
        range = document.createRange();
        range.setStart(pos.offsetNode, pos.offset);
      }
    }
    if (!range || !editor.contains(range.startContainer)) return;
    draggedBadge.classList.remove('drag-src');
    range.collapse(true);
    range.insertNode(draggedBadge); // moves the existing node
    draggedBadge = null;
  });
}

// ============================================================
// Response panel — per-call status rows
// ============================================================
let activeCard = null;
let recvContent = '';
let rowCounter = 0;

function startRespCard(roundN) {
  $('resp-placeholder')?.remove();

  const card = document.createElement('div');
  card.className = 'resp-card';
  card.innerHTML = `
    <div class="resp-card-header">
      <span class="round-label">Round #${roundN}</span>
      <span class="resp-card-time">${new Date().toLocaleTimeString()}</span>
    </div>
    <div class="recv-strip streaming" id="recv-${roundN}"></div>
    <div class="call-rows" id="rows-${roundN}"></div>
    <div class="resp-timing" id="timing-${roundN}"></div>`;
  respLog.appendChild(card);
  respLog.scrollTop = respLog.scrollHeight;
  recvContent = '';
  activeCard = { card, roundN };
  return card;
}

function appendRecv(chunk) {
  if (!activeCard) return;
  recvContent += chunk;
  const el = document.getElementById(`recv-${activeCard.roundN}`);
  if (el) {
    el.textContent = recvContent;
    el.scrollTop = el.scrollHeight;
  }
  respLog.scrollTop = respLog.scrollHeight;
}

/** Split a raw arg string on top-level commas (quotes respected). */
function splitArgs(raw) {
  const parts = [];
  let cur = '', inQ = false;
  for (const ch of raw ?? '') {
    if (ch === '"') { inQ = !inQ; cur += ch; continue; }
    if (ch === ',' && !inQ) { parts.push(cur); cur = ''; continue; }
    cur += ch;
  }
  parts.push(cur);
  return parts.map(s => s.trim().replace(/^"|"$/g, '')).filter(s => s.length > 0);
}

/**
 * Append one aligned call row:  <mark> | FN | ( [arg] , [arg] )
 * Returns the row id so the status can be set once execution finishes.
 */
function addCallRow(roundN, fn, rawArgs) {
  const rowsEl = document.getElementById(`rows-${roundN}`);
  if (!rowsEl) return null;

  const row = document.createElement('div');
  row.className = 'call-row';
  row.id = `crow-${++rowCounter}`;

  const status = document.createElement('span');
  status.className = 'call-status pending';
  status.textContent = '…';

  const fnEl = document.createElement('span');
  fnEl.className = 'call-fn';
  const fnBadge = document.createElement('span');
  fnBadge.className = `cbadge ${BADGE_FN_CLASSES.has(fn) ? 'cb-' + fn : 'cb-default'}`;
  fnBadge.textContent = fn;
  fnEl.appendChild(fnBadge);

  const argsEl = document.createElement('span');
  argsEl.className = 'call-args';
  const open = document.createElement('span');
  open.className = 'call-paren';
  open.textContent = '(';
  argsEl.appendChild(open);
  argsEl.appendChild(document.createTextNode(' '));
  const parts = splitArgs(rawArgs);
  parts.forEach((p, i) => {
    const b = document.createElement('span');
    b.className = 'cbadge cb-param';
    b.textContent = p;
    b.title = p;
    argsEl.appendChild(b);
    if (i < parts.length - 1) {
      argsEl.appendChild(document.createTextNode(' '));
      const comma = document.createElement('span');
      comma.className = 'call-paren';
      comma.textContent = ',';
      argsEl.appendChild(comma);
      argsEl.appendChild(document.createTextNode(' '));
    }
  });
  argsEl.appendChild(document.createTextNode(' '));
  const close = document.createElement('span');
  close.className = 'call-paren';
  close.textContent = ')';
  argsEl.appendChild(close);

  row.append(status, fnEl, argsEl);
  rowsEl.appendChild(row);
  respLog.scrollTop = respLog.scrollHeight;
  return row.id;
}

const BADGE_FN_CLASSES = new Set(['CREATE', 'MOVE', 'FORWARD', 'LOOKAT', 'SCALE', 'DELETE', 'MESSAGE', 'EXPLAIN']);

function setRowStatus(rowId, result) {
  const row = document.getElementById(rowId);
  if (!row) return;
  const status = row.querySelector('.call-status');
  if (!status) return;
  status.classList.remove('pending');
  if (result.ok) {
    status.classList.add('ok');
    status.textContent = '✓';
  } else {
    status.classList.add('err');
    status.textContent = '✗';
    status.title = result.error ?? 'Execution failed';
    row.title = result.error ?? 'Execution failed';
  }
}

function finaliseCard(report) {
  if (!activeCard) return;
  const { roundN } = activeCard;

  document.getElementById(`recv-${roundN}`)?.classList.remove('streaming');

  const timingEl = document.getElementById(`timing-${roundN}`);
  if (timingEl && report) {
    timingEl.innerHTML = `
      <div class="timing-badge">⏱ TTFB <span>${report.ttftMs != null ? report.ttftMs.toFixed(0) + 'ms' : '—'}</span></div>
      <div class="timing-badge">⏱ Total <span>${report.totalMs != null ? (report.totalMs / 1000).toFixed(2) + 's' : '—'}</span></div>
      ${report.usage ? `<div class="timing-badge">▣ tokens <span>${report.usage.total_tokens ?? '—'}</span></div>` : ''}
    `;
  }
  activeCard = null;
}

// ============================================================
// Sending a round to the LLM
// ============================================================

/** Withdraw round hits/drawings whose badges the user deleted from the editor. */
function syncRoundWithEditor() {
  const present = new Set();
  editor.querySelectorAll('.ibadge').forEach(b => present.add(b.dataset.ref));
  for (const h of state.round._hits) {
    if (!present.has(h.id)) state.round.removeHit(h.id);
  }
  for (const d of state.round._drawings) {
    if (!present.has(d.id)) state.round.removeDrawing(d.id);
  }
}

function resetRound() {
  state.round = new OperatingRound();
  state.counters = { h: 0, o: 0, l: 0, a: 0 };
  state.visHits = [];
  state.visLines = [];
  state.visAreas = [];
  state.objBadges.clear();
  state.badgeReg.clear();
  clearInterim();
  editor.textContent = '';
  for (const o of state.objects) o.selected = false;
  render();
}

/** Wipe every object plus all per-round markers/badges from the scene. */
function clearScene() {
  state.objects = [];
  state.gizmoHoverObj = null;
  state.lastCreatedId = null;
  resetRound();   // clears badges, markers, editor and re-renders
}

/** Place a tasteful living-room arrangement so the demo opens with a real
 *  scene to play with rather than an empty floor. Cleared via "Clear scene". */
function seedDemoScene() {
  if (state.objects.length) return;
  const place = (name, x, z, angle = 0) => {
    const o = createObject(name, x, z);
    if (o) {
      o.angle = angle;
      const p = clampObjPos(o, o.x, o.z);
      o.x = p.x; o.z = p.z;
    }
  };
  // Coordinates assume the default 12 × 10 m room. forward = (-sin a, cos a):
  // a = 0 faces +z (south/down); a = π faces -z (north/up);
  // a = -π/2 faces +x (east/right); a = π/2 faces -x (west/left).
  // Conversational living room: TV on the far (north) wall, couch facing it, and
  // two armchairs flanking the coffee table facing EACH OTHER across it.
  place('Rug',       6.0, 6.2);
  place('TV',        6.0, 0.8,  0);            // far (north) wall, screen faces south into the room
  place('Couch',     6.0, 8.3,  Math.PI);      // faces north toward the TV
  place('Table',     6.0, 6.2,  0);            // coffee table in the middle
  place('Chair',     3.3, 6.2, -Math.PI / 2);  // west chair faces east → toward the other chair
  place('Chair',     8.7, 6.2,  Math.PI / 2);  // east chair faces west → toward the other chair
  place('Bookshelf', 11.4, 2.6, Math.PI / 2);  // against the east wall, facing in
  place('Plant',     11.0, 9.2);
  place('Lamp',      1.3, 1.6);
  render();
}

// Example prompt/response shown alongside the starter scene, plus a follow-up
// command pre-filled in the input so the demo opens mid-conversation.
const EXAMPLE_USER_REQUEST =
  'Set up a cozy living room — a couch facing a TV, a coffee table with two ' +
  'armchairs facing each other, and a bookshelf, plant and lamp around the edges.';
const EXAMPLE_FOLLOWUP =
  'Now add a small plant on the coffee table and turn the couch slightly to the left.';
const EXAMPLE_CALLS = [
  ['CREATE', '"TV"'], ['MOVE', '"crt", x=6.00, z=0.80'],
  ['CREATE', '"Rug"'], ['MOVE', '"crt", x=6.00, z=6.20'],
  ['CREATE', '"Couch"'], ['MOVE', '"crt", x=6.00, z=8.30'], ['LOOKAT', '"crt", x=6.00, z=0.80'],
  ['CREATE', '"Table"'], ['MOVE', '"crt", x=6.00, z=6.20'],
  ['CREATE', '"Chair"'], ['MOVE', '"crt", x=3.30, z=6.20'], ['LOOKAT', '"crt", x=8.70, z=6.20'],
  ['CREATE', '"Chair"'], ['MOVE', '"crt", x=8.70, z=6.20'], ['LOOKAT', '"crt", x=3.30, z=6.20'],
  ['CREATE', '"Bookshelf"'], ['MOVE', '"crt", x=11.40, z=2.60'], ['FORWARD', '"crt", x=-1.00'],
  ['CREATE', '"Plant"'], ['MOVE', '"crt", x=11.00, z=9.20'],
  ['CREATE', '"Lamp"'], ['MOVE', '"crt", x=1.30, z=1.60'],
];

function buildExampleRow(fn, rawArgs) {
  const row = document.createElement('div');
  row.className = 'call-row';
  const status = document.createElement('span');
  status.className = 'call-status ok';
  status.textContent = '✓';
  const fnEl = document.createElement('span');
  fnEl.className = 'call-fn';
  const fnBadge = document.createElement('span');
  fnBadge.className = `cbadge ${BADGE_FN_CLASSES.has(fn) ? 'cb-' + fn : 'cb-default'}`;
  fnBadge.textContent = fn;
  fnEl.appendChild(fnBadge);
  const argsEl = document.createElement('span');
  argsEl.className = 'call-args';
  argsEl.appendChild(Object.assign(document.createElement('span'), { className: 'call-paren', textContent: '( ' }));
  splitArgs(rawArgs).forEach((p, i, arr) => {
    const b = document.createElement('span');
    b.className = 'cbadge cb-param';
    b.textContent = p; b.title = p;
    argsEl.appendChild(b);
    if (i < arr.length - 1) argsEl.appendChild(Object.assign(document.createElement('span'), { className: 'call-paren', textContent: ' , ' }));
  });
  argsEl.appendChild(Object.assign(document.createElement('span'), { className: 'call-paren', textContent: ' )' }));
  row.append(status, fnEl, argsEl);
  return row;
}

function seedExampleResponse() {
  respLog.innerHTML = '';
  const card = document.createElement('div');
  card.className = 'resp-card';
  card.innerHTML = `
    <div class="resp-card-header">
      <span class="round-label">Example round</span>
      <span class="resp-card-time">how the scene was built</span>
    </div>
    <div class="resp-userreq"><span class="rr-tag">🗣 You</span><span>${escapeHtml(EXAMPLE_USER_REQUEST)}</span></div>
    <div class="recv-strip"></div>
    <div class="call-rows"></div>
    <div class="resp-timing">${EXAMPLE_CALLS.length} API calls · example output — send the pre-filled command (needs an API key) to continue live.</div>`;
  card.querySelector('.recv-strip').textContent =
    EXAMPLE_CALLS.map(([fn, a]) => `${fn}(${a});`).join('\n');
  const rows = card.querySelector('.call-rows');
  for (const [fn, a] of EXAMPLE_CALLS) rows.appendChild(buildExampleRow(fn, a));
  respLog.appendChild(card);
}

/** Load the starter scene together with its example response + follow-up command. */
function loadExampleEverything() {
  clearScene();
  seedDemoScene();
  seedExampleResponse();
  editor.textContent = EXAMPLE_FOLLOWUP;
}

async function sendRound() {
  if (state.llmBusy) { toast('LLM is busy, please wait', 'info'); return; }

  const requestText = serializeEditor();
  if (!requestText) {
    toast('Nothing to send — speak, type, or interact with the canvas first', 'info');
    return;
  }
  if (!state.llm) {
    toast('API key not configured — open Settings', 'error');
    openSettings();
    return;
  }

  syncRoundWithEditor();

  // Make sure the round has the typed text on record too (for user_request
  // fallback and exports); the override below remains authoritative.
  if (state.round.empty) {
    state.round.addText({ text: requestText.replace(/\[<[^\]>]*>(?:start|end)?\]/g, ' ').replace(/\s+/g, ' ').trim() });
  }

  state.roundN++;
  const roundN = state.roundN;
  startRespCard(roundN);
  state.llmBusy = true;
  sendBtn.disabled = true;
  setStatus('thinking', '🤔 processing…');

  const round = state.round;
  // Visuals + editor reset immediately; the scene keeps animating from calls
  const wasListening = voice.isActive();

  try {
    await state.llm.invokeChat(round, {
      sceneState: {
        objects: sceneObjects(),
      },
      requestTextOverride: requestText,
      onChunk: (chunk) => appendRecv(chunk),
      onCall: (fn, args, rawArgs) => {
        const rowId = addCallRow(roundN, fn, rawArgs);
        const result = executeLLMCall(fn, args);
        // Brief "recognised → consumed" beat before the status lands
        setTimeout(() => setRowStatus(rowId, result), 180);
      },
      onDone: (report) => {
        finaliseCard(report);
        setStatus(wasListening && voice.isActive() ? 'active' : 'idle',
                  voice.isActive() ? '🎙 listening' : '● idle');
      },
      onError: (err) => {
        toast(err.message, 'error');
        finaliseCard(null);
        setStatus('error', '⚠ error');
      },
    });
  } finally {
    state.llmBusy = false;
    sendBtn.disabled = false;
    resetRound();
  }
}

// ============================================================
// Status bar
// ============================================================
function setStatus(type, text) {
  statusDot.className = '';
  if (type === 'active' || type === 'thinking') statusDot.classList.add('active');
  if (type === 'speaking') statusDot.classList.add('speaking');
  statusText.textContent = text;
}

// ============================================================
// Canvas interaction — VR-style gestures
// ============================================================
function canvasPos(e) {
  const rect = canvas.getBoundingClientRect();
  return { cx: e.clientX - rect.left, cy: e.clientY - rect.top };
}

function onPointerDown(e) {
  if (e.pointerType === 'mouse' && e.button !== 0 && e.button !== 2) return;
  e.preventDefault();
  canvas.setPointerCapture(e.pointerId);
  const { cx, cy } = canvasPos(e);
  const isTouch = e.pointerType !== 'mouse';
  const obj = pickObject(cx, cy);

  if (e.button === 2) {
    pointer = { mode: 'pending-right', obj, startCX: cx, startCY: cy, startMs: timing.nowMs() };
    if (obj) startDeletePending(obj);
    return;
  }

  // Left button / touch — pin gizmo target so handles outside the footprint work
  const zoneObj = findGizmoObjectAt(cx, cy, isTouch);
  if (zoneObj) state.gizmoHoverObj = zoneObj;
  const g = gizmoHandleAt(cx, cy, isTouch);
  if (g) {
    if (g.type === 'move') {
      pointer = { mode: 'gizmo-move', obj: g.obj, startCX: cx, startCY: cy,
                  offX: g.obj.x - cw(cx), offZ: g.obj.z - cd(cy) };
    } else {
      pointer = { mode: 'gizmo-rotate', obj: g.obj, startCX: cx, startCY: cy };
    }
    canvas.classList.add('cursor-grabbing');
    render();
    return;
  }

  pointer = { mode: 'pending-left', obj, startCX: cx, startCY: cy, startMs: timing.nowMs() };
  // Touch substitutes long-press for the right-click-hold delete
  if (isTouch && obj) startDeletePending(obj);
}

function onPointerMove(e) {
  const { cx, cy } = canvasPos(e);

  if (!pointer) {
    const isTouch = e.pointerType !== 'mouse';
    const zoneObj = findGizmoObjectAt(cx, cy, isTouch);
    state.gizmoHoverObj = zoneObj;
    const g = gizmoHandleAt(cx, cy, isTouch);
    const bodyObj = pickObject(cx, cy);

    canvas.classList.remove('cursor-grabbing');
    canvas.classList.toggle('cursor-grab', g?.type === 'move');
    canvas.classList.toggle('cursor-rotate', g?.type === 'rotate');
    canvas.classList.toggle('cursor-pointer', !g && !!bodyObj);

    const hoverKey = `${zoneObj?.id ?? ''}:${g?.type ?? ''}`;
    if (hoverKey !== state._gizmoHoverKey) {
      state._gizmoHoverKey = hoverKey;
      render();
    }
    return;
  }

  const moved = pointer.startCX !== undefined
    ? Math.hypot(cx - pointer.startCX, cy - pointer.startCY)
    : 0;

  switch (pointer.mode) {
    case 'gizmo-move': {
      const pos = clampObjPos(pointer.obj, cw(cx) + pointer.offX, cd(cy) + pointer.offZ);
      pointer.obj.x = pos.x;
      pointer.obj.z = pos.z;
      render();
      break;
    }
    case 'gizmo-rotate': {
      const dx = cx - wx(pointer.obj.x);
      const dy = cy - wz(pointer.obj.z);
      const len = Math.hypot(dx, dy);
      if (len > 2) {
        // Forward (canvas) = (-sin a, cos a) → point it at the cursor
        pointer.obj.angle = Math.atan2(-dx / len, dy / len);
        const pos = clampObjPos(pointer.obj, pointer.obj.x, pointer.obj.z);
        pointer.obj.x = pos.x;
        pointer.obj.z = pos.z;
      }
      render();
      break;
    }
    case 'pending-left': {
      if (moved > DRAG_THRESH) {
        cancelDeletePending();
        pointer.mode = 'line';
        pointer.start = { x: clampX(cw(pointer.startCX)), z: clampZ(cd(pointer.startCY)) };
        pointer.curr = { x: clampX(cw(cx)), z: clampZ(cd(cy)) };
        render();
      }
      break;
    }
    case 'pending-right': {
      if (moved > DRAG_THRESH) {
        cancelDeletePending();
        pointer.mode = 'area';
        pointer.start = { x: clampX(cw(pointer.startCX)), z: clampZ(cd(pointer.startCY)) };
        pointer.curr = { x: clampX(cw(cx)), z: clampZ(cd(cy)) };
        render();
      }
      break;
    }
    case 'line':
    case 'area': {
      pointer.curr = { x: clampX(cw(cx)), z: clampZ(cd(cy)) };
      render();
      break;
    }
  }
}

function onPointerUp(e) {
  canvas.classList.remove('cursor-grabbing');
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  cancelDeletePending();
  if (!pointer) return;

  const { cx, cy } = canvasPos(e);
  const p = pointer;
  pointer = null;

  switch (p.mode) {
    case 'gizmo-move':
    case 'gizmo-rotate': {
      // A press on the gizmo that didn't actually drag is a click → select the
      // object. Without this, a small object whose body is fully covered by the
      // move handle could never be selected.
      const moved = p.startCX !== undefined
        ? Math.hypot(cx - p.startCX, cy - p.startCY) : 0;
      if (moved < DRAG_THRESH) {
        toggleObjectSelection(p.obj, { x: clampX(cw(cx)), z: clampZ(cd(cy)) });
      }
      render();
      break;
    }

    case 'line': {
      const a = p.start, b = p.curr ?? p.start;
      if (Math.hypot(b.x - a.x, b.z - a.z) >= 0.05) {
        const id = state.round.addDrawing({
          points: [{ x: a.x, z: a.z }, { x: b.x, z: b.z }],
          startMs: p.startMs,
          durationMs: timing.nowMs() - p.startMs,
        });
        const label = 'l' + (++state.counters.l);
        insertBadge('l', label, `[<${id}>start] [<${id}>end]`, id);
        state.visLines.push({ refId: id, a, b, label });
      }
      render();
      break;
    }

    case 'area': {
      const a = p.start, b = p.curr ?? p.start;
      if (Math.abs(b.x - a.x) >= 0.05 && Math.abs(b.z - a.z) >= 0.05) {
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x);
        const z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
        const id = state.round.addDrawing({
          points: [
            { x: x0, z: z0 }, { x: x1, z: z0 }, { x: x1, z: z1 },
            { x: x0, z: z1 }, { x: x0, z: z0 },
          ],
          startMs: p.startMs,
          durationMs: timing.nowMs() - p.startMs,
        });
        const label = 'a' + (++state.counters.a);
        insertBadge('a', label, `[<${id}>start] [<${id}>end]`, id);
        state.visAreas.push({ refId: id, x0, z0, x1, z1, label });
      }
      render();
      break;
    }

    case 'pending-left': {
      const worldX = cw(cx), worldZ = cd(cy);

      // Tap-to-place an armed prefab (mobile flow)
      if (state.placePrefab && insideRoom(worldX, worldZ)) {
        createObject(state.placePrefab, worldX, worldZ);
        armPlacePrefab(null);
        break;
      }

      if (p.obj) {
        toggleObjectSelection(p.obj, { x: clampX(worldX), z: clampZ(worldZ) });
      } else if (insideRoom(worldX, worldZ)) {
        addFloorHit(worldX, worldZ);
      }
      // Clicks outside the room are ignored
      break;
    }

    case 'pending-right':
      // Click (or aborted hold) — nothing to do
      break;
  }
}

function onPointerCancel(e) {
  canvas.classList.remove('cursor-grabbing');
  try { canvas.releasePointerCapture(e.pointerId); } catch { /* not captured */ }
  cancelDeletePending();
  pointer = null;
  render();
}

function toggleObjectSelection(o, worldPos) {
  if (!o.selected) {
    o.selected = true;
    const hitId = state.round.addHit({
      object: o.id,
      position: { x: worldPos.x, z: worldPos.z },
    });
    const label = 'o' + (++state.counters.o);
    insertBadge('o', label, `[<${hitId}>]`, hitId);
    // Selecting an object is shown by its highlight + the input-area badge only —
    // no extra hit-point marker is drawn on the canvas (unlike a floor "here").
    state.objBadges.set(o.id, { hitId, label });
  } else {
    deselectObject(o);
  }
  render();
}

function addFloorHit(x, z) {
  const px = clampX(x), pz = clampZ(z);
  const hitId = state.round.addHit({
    object: null,
    position: { x: px, z: pz },
  });
  const label = 'h' + (++state.counters.h);
  insertBadge('h', label, `[<${hitId}>]`, hitId);
  state.visHits.push({ refId: hitId, x: px, z: pz, label, kind: 'h' });
  render();
}

// Mouse wheel over an object (or the current selection) rotates it in 15° steps
canvas.addEventListener('wheel', e => {
  const { cx, cy } = canvasPos(e);
  const o = pickObject(cx, cy) ?? state.objects.find(obj => obj.selected);
  if (!o) return;
  e.preventDefault();
  o.angle += (e.deltaY > 0 ? 1 : -1) * Math.PI / 12;
  const pos = clampObjPos(o, o.x, o.z);
  o.x = pos.x;
  o.z = pos.z;
  render();
}, { passive: false });

canvas.addEventListener('contextmenu', e => e.preventDefault());
canvas.addEventListener('pointerleave', () => {
  if (!pointer && state.gizmoHoverObj) {
    state.gizmoHoverObj = null;
    state._gizmoHoverKey = '';
    render();
  }
});

// ============================================================
// Keyboard
// ============================================================
document.addEventListener('keydown', e => {
  if (e.target === editor || /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName) ||
      e.target.isContentEditable) return;
  if (e.key === 'Delete' || e.key === 'Backspace') {
    const sel = state.objects.filter(o => o.selected);
    sel.forEach(removeObjectFromScene);
    if (sel.length) toast(`Deleted ${sel.length} object(s)`, 'info');
  }
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRound(); }
  if (e.key === 'Escape') armPlacePrefab(null);
});

// ============================================================
// Palette — drag to place, tap to arm, edit catalog
// ============================================================
function buildPalette() {
  const list = $('prefab-list');
  list.innerHTML = '';
  for (const pf of state.catalog) {
    const item = document.createElement('div');
    item.className = 'prefab-item';
    item.dataset.name = pf.name;
    if (state.placePrefab === pf.name) item.classList.add('place-armed');

    const color = OBJECT_COLORS[pf.icon] ?? COLOURS.objBorder;
    const iconHtml = (pf.icon && ICONS[pf.icon])
      ? iconSVG(pf.icon, 18)
      : `<span>${escapeHtml(pf.name.slice(0, 2))}</span>`;
    const iconStyle = (pf.icon && ICONS[pf.icon])
      ? ` style="color:${color};background:${hexA(color, 0.16)};border-color:${hexA(color, 0.5)}"`
      : '';
    item.innerHTML = `
      <div class="prefab-icon ${pf.icon && ICONS[pf.icon] ? '' : 'no-icon'}"${iconStyle}>${iconHtml}</div>
      <div class="prefab-info">
        <div class="prefab-name" title="${escapeHtml(pf.name)}">${escapeHtml(pf.name)}</div>
        <div class="prefab-dim">${pf.w.toFixed(2)} × ${pf.d.toFixed(2)} m</div>
      </div>
      <button class="prefab-edit" title="Edit ${escapeHtml(pf.name)}">✎</button>`;

    item.querySelector('.prefab-edit').addEventListener('click', e => {
      e.stopPropagation();
      openObjEditor(pf.name);
    });
    item.addEventListener('pointerdown', onPalettePointerDown);
    list.appendChild(item);
  }

  // "Add object" as the final list entry, sized like a regular object row.
  const add = document.createElement('button');
  add.className = 'prefab-item prefab-add-item';
  add.id = 'palette-add';
  add.innerHTML =
    `<div class="prefab-icon no-icon"><span>＋</span></div>` +
    `<div class="prefab-info"><div class="prefab-name">Add object</div></div>`;
  add.addEventListener('click', () => openObjEditor(null));
  list.appendChild(add);
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function armPlacePrefab(name) {
  state.placePrefab = name;
  document.querySelectorAll('.prefab-item').forEach(el => {
    el.classList.toggle('place-armed', el.dataset.name === name && name !== null);
  });
  // Mobile: once armed, close the object drawer so the canvas is tappable to place.
  if (name && matchMedia('(pointer: coarse)').matches) document.documentElement.classList.remove('palette-open');
}

// Palette items use pointer-event dragging with a ghost element.  A press
// that never crosses the drag threshold "arms" the prefab for tap-to-place.
function onPalettePointerDown(e) {
  if (e.target.closest('.prefab-edit')) return;
  e.preventDefault();
  const item = e.currentTarget;
  const name = item.dataset.name;
  const pf = prefab(name);
  if (!pf) return;

  const startX = e.clientX, startY = e.clientY;
  let dragging = false;

  function onMove(ev) {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > DRAG_THRESH) {
      dragging = true;
      dragGhost.innerHTML = (pf.icon && ICONS[pf.icon] ? iconSVG(pf.icon, 16) : '') +
                            ' ' + escapeHtml(pf.name);
      dragGhost.style.display = 'flex';
    }
    if (dragging) moveDragGhost(ev.clientX, ev.clientY);
  }
  function onUp(ev) {
    window.removeEventListener('pointermove', onMove);
    window.removeEventListener('pointerup', onUp);
    window.removeEventListener('pointercancel', onUp);
    dragGhost.style.display = 'none';
    if (!dragging) {
      // Tap → arm/disarm tap-to-place
      const arm = state.placePrefab === name ? null : name;
      armPlacePrefab(arm);
      if (arm) toast(`Tap the canvas to place a ${name} (Esc to cancel)`, 'info');
      return;
    }
    const rect = canvas.getBoundingClientRect();
    if (ev.clientX >= rect.left && ev.clientX <= rect.right &&
        ev.clientY >= rect.top  && ev.clientY <= rect.bottom) {
      const x = cw(ev.clientX - rect.left), z = cd(ev.clientY - rect.top);
      createObject(name, x, z);
    }
  }
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('pointercancel', onUp);
}

function moveDragGhost(x, y) {
  dragGhost.style.left = (x + 12) + 'px';
  dragGhost.style.top  = (y + 8) + 'px';
}

// ============================================================
// Object catalog editor modal
// ============================================================
let editingName = null;   // null = adding a new entry
let editorIcon = 'box';

function openObjEditor(name) {
  editingName = name;
  const pf = name ? prefab(name) : null;
  $('oe-title').textContent = pf ? `Edit "${pf.name}"` : 'Add object';
  $('oe-name').value = pf?.name ?? '';
  $('oe-desc').value = pf?.desc ?? '';
  $('oe-w').value = pf?.w ?? 0.5;
  $('oe-d').value = pf?.d ?? 0.5;
  editorIcon = pf?.icon ?? 'box';

  buildIconPicker();
  updateCounters();

  const inUse = pf && state.objects.some(o => o.prefabId === pf.name);
  const delBtn = $('oe-delete');
  delBtn.style.display = pf ? '' : 'none';
  delBtn.disabled = !!inUse;
  delBtn.title = inUse ? 'Remove all instances from the scene first' : 'Delete this object type';

  $('editor-overlay').classList.add('open');
  drawObjPreview();
}

function closeObjEditor() {
  $('editor-overlay').classList.remove('open');
}

function buildIconPicker() {
  const grid = $('oe-icons');
  grid.innerHTML = '';
  const none = document.createElement('button');
  none.type = 'button';
  none.className = 'oe-icon-btn' + (editorIcon === null ? ' active' : '');
  none.textContent = 'none';
  none.title = 'No icon (label only)';
  none.addEventListener('click', () => { editorIcon = null; buildIconPicker(); drawObjPreview(); });
  grid.appendChild(none);
  for (const n of ICON_NAMES) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'oe-icon-btn' + (editorIcon === n ? ' active' : '');
    b.innerHTML = iconSVG(n, 18);
    b.title = n;
    b.addEventListener('click', () => { editorIcon = n; buildIconPicker(); drawObjPreview(); });
    grid.appendChild(b);
  }
}

function updateCounters() {
  $('oe-name-count').textContent = `${$('oe-name').value.length}/${NAME_MAX}`;
  $('oe-desc-count').textContent = `${$('oe-desc').value.length}/${DESC_MAX}`;
}

/** Mini-canvas preview rendered with the same visual language as the main canvas. */
function drawObjPreview() {
  const pc = $('oe-preview');
  const pctx = pc.getContext('2d');
  const W = pc.width, H = pc.height;
  pctx.clearRect(0, 0, W, H);
  pctx.fillStyle = '#10141a';
  pctx.fillRect(0, 0, W, H);

  const w = Math.max(parseFloat($('oe-w').value) || 0.05, 0.05);
  const d = Math.max(parseFloat($('oe-d').value) || 0.05, 0.05);
  const name = $('oe-name').value.trim() || 'Object';

  const scale = Math.min((W - 90) / w, (H - 90) / d, 70);
  const pw = w * scale, pd = d * scale;
  const cx = W / 2, cz = H / 2 + 10;

  // Grid hint
  pctx.strokeStyle = '#1a1f27';
  pctx.lineWidth = 0.5;
  for (let gx = cx % scale; gx < W; gx += scale) {
    pctx.beginPath(); pctx.moveTo(gx, 0); pctx.lineTo(gx, H); pctx.stroke();
  }
  for (let gy = cz % scale; gy < H; gy += scale) {
    pctx.beginPath(); pctx.moveTo(0, gy); pctx.lineTo(W, gy); pctx.stroke();
  }

  // Body
  pctx.fillStyle = COLOURS.obj;
  pctx.strokeStyle = COLOURS.objBorder;
  pctx.lineWidth = 1.5;
  pctx.fillRect(cx - pw / 2, cz - pd / 2, pw, pd);
  pctx.strokeRect(cx - pw / 2, cz - pd / 2, pw, pd);

  // Icon
  const iconPx = Math.min(pw, pd) * 0.62;
  if (editorIcon && ICONS[editorIcon] && iconPx >= 12) {
    drawIcon(pctx, editorIcon, cx, cz, Math.min(iconPx, 46), COLOURS.icon);
  }

  // External pill label + leader line
  pctx.font = '600 10px Inter, sans-serif';
  const label = `${name} 1`;
  const tw = pctx.measureText(label).width;
  const lpw = tw + 14, lph = 16;
  const ly = cz - pd / 2 - 7 - lph / 2;
  pctx.strokeStyle = '#8b949e66';
  pctx.lineWidth = 1;
  pctx.beginPath(); pctx.moveTo(cx, ly); pctx.lineTo(cx, cz); pctx.stroke();
  pctx.fillStyle = COLOURS.pillBg;
  pctx.strokeStyle = '#30363d';
  pctx.beginPath();
  pctx.roundRect(cx - lpw / 2, ly - lph / 2, lpw, lph, 8);
  pctx.fill();
  pctx.stroke();
  pctx.fillStyle = COLOURS.text;
  pctx.textAlign = 'center';
  pctx.textBaseline = 'middle';
  pctx.fillText(label, cx, ly + 0.5);

  // Dimension caption
  pctx.fillStyle = '#8b949e';
  pctx.font = '9px Inter, sans-serif';
  pctx.fillText(`${w.toFixed(2)} × ${d.toFixed(2)} m`, cx, cz + pd / 2 + 14);
}

function setupObjEditor() {
  ['oe-name', 'oe-desc', 'oe-w', 'oe-d'].forEach(id => {
    $(id).addEventListener('input', () => { updateCounters(); drawObjPreview(); });
  });

  $('oe-cancel').addEventListener('click', closeObjEditor);
  $('editor-overlay').addEventListener('click', e => {
    if (e.target === $('editor-overlay')) closeObjEditor();
  });

  $('oe-save').addEventListener('click', () => {
    const name = $('oe-name').value.trim().slice(0, NAME_MAX);
    const desc = $('oe-desc').value.trim().slice(0, DESC_MAX);
    let w = parseFloat($('oe-w').value);
    let d = parseFloat($('oe-d').value);
    if (!name) { toast('Name is required', 'error'); return; }
    if (!Number.isFinite(w) || !Number.isFinite(d)) { toast('Width/depth must be numbers', 'error'); return; }
    w = Math.max(0.05, Math.min(5, w));
    d = Math.max(0.05, Math.min(5, d));
    const clash = state.catalog.find(p => p.name === name && p.name !== editingName);
    if (clash) { toast(`An object named "${name}" already exists`, 'error'); return; }

    if (editingName) {
      const pf = prefab(editingName);
      const oldName = pf.name;
      Object.assign(pf, { name, desc, w, d, icon: editorIcon });
      // Keep scene instances coherent with the new catalog entry
      for (const o of state.objects) {
        if (o.prefabId === oldName) {
          o.prefabId = name;
          o.w = w;
          o.d = d;
          const pos = clampObjPos(o, o.x, o.z);
          o.x = pos.x; o.z = pos.z;
        }
      }
    } else {
      state.catalog.push({ name, desc, w, d, icon: editorIcon });
    }
    closeObjEditor();
    catalogChanged();
  });

  $('oe-delete').addEventListener('click', () => {
    if (!editingName) return;
    if (state.objects.some(o => o.prefabId === editingName)) {
      toast('Remove all instances from the scene first', 'error');
      return;
    }
    if (!confirm(`Delete object type "${editingName}" from the catalog?`)) return;
    state.catalog = state.catalog.filter(p => p.name !== editingName);
    closeObjEditor();
    catalogChanged();
  });

  $('palette-restore').addEventListener('click', () => {
    if (!confirm('Restore the default object catalog? Your custom objects will be removed.')) return;
    state.catalog = DEFAULT_CATALOG.map(p => ({ ...p }));
    catalogChanged();
  });
}

// ============================================================
// STT — shared voice module (demo-shared.js) over the vr-mover.js engine.
// Auto (continuous + auto-submit) and Hold-to-talk behave exactly as before.
// ============================================================
const voice = createVoiceInput({
  SpeechController,
  editor,
  sttBtn,
  getLang: () => state.settings.lang ?? 'en-US',
  getConfirmDelay: () => state.confirmDelay,
  serialize: serializeEditor,
  canSend: () => !state.llmBusy,
  send: sendRound,
  addRoundText: (t) => state.round.addText(t),
  setStatus, toast,
  proposalStatusType: 'speaking',
  // Don't auto-dispatch while the user is mid-gesture on the canvas.
  deferAutoSend: () => !!pointer,
});

// ============================================================
// Settings drawer
// ============================================================
function openSettings() {
  settingsToForm(state.settings);
  $('settings-overlay').classList.add('open');
}
function closeSettings() {
  $('settings-overlay').classList.remove('open');
}

// OpenAI-compatible providers offered as one-click presets in Settings.
/* PROVIDERS + applyProviderPreset are imported from demo-shared.js */

function setupSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  // Close only when the backdrop itself (not the modal) is clicked.
  $('settings-overlay').addEventListener('click', e => {
    if (e.target === $('settings-overlay')) closeSettings();
  });
  $('s-cancel').addEventListener('click', closeSettings);

  $('quickstart-toggle').addEventListener('click', () => {
    $('quickstart').classList.toggle('open');
  });
  $('s-provider').addEventListener('change', e => applyProviderPreset(e.target.value));
  applyProviderPreset('custom');

  $('s-save').addEventListener('click', () => {
    const s = formToSettings();
    applySettings(s);
    if (voice.isActive()) { voice.stopSTT(); voice.startSTT(); } // re-init STT if lang changed
    closeSettings();
    toast('Settings saved', 'success');
    autoScale();
    render();
    document.dispatchEvent(new CustomEvent('vrmover:settings-saved', { detail: { hasKey: !!s.apiKey } }));
  });

  $('s-clear-key').addEventListener('click', () => {
    $('s-apikey').value = '';
    toast('API key cleared', 'info');
  });

  $('s-reset-prompt').addEventListener('click', () => {
    $('s-sysprompt').value = '';
    toast('System prompt reset to default', 'info');
  });

  $('s-view-prompt').addEventListener('click', () => {
    const s = formToSettings();
    const resolved = resolvedSystemPrompt(s);
    const w = window.open('', '_blank', 'width=700,height=600');
    w.document.write(`<pre style="font:13px monospace;background:#0d1117;color:#c9d1d9;padding:16px;white-space:pre-wrap">${resolved.replace(/</g, '&lt;')}</pre>`);
  });

  ['s-ctxlen', 's-delay', 's-temp'].forEach(id => {
    $(id).addEventListener('input', () => {
      $(`${id}-val`).textContent = $(id).value;
    });
  });

  $('chk-stream').addEventListener('change', e => {
    state.llm?.updateConfig({ streaming: e.target.checked });
  });
}

// ============================================================
// Welcome modal + guided tour
// ============================================================
const SEEN_KEY = 'vrmover_seen_intro';
let tour = null;

// Highlight a starter object so its gizmo is visible during the gizmo steps.
function tourFocusObject(prefabId) {
  const o = state.objects.find(x => x.prefabId === prefabId) ?? state.objects[0] ?? null;
  if (o) { state.gizmoHoverObj = o; render(); }
  return o;
}

function tourSteps() {
  const isMobile = window.matchMedia('(max-width: 960px)').matches;
  return [
    {
      target: ['#s-baseurl', '#s-apikey'],
      title: '1 · Set your API key',
      body: 'The demo calls an <strong>OpenAI-compatible</strong> LLM straight from your browser. ' +
            'Open the <strong>\u{1F511} quick-start</strong> at the top to pick a provider (some have a ' +
            '<strong>free tier</strong>) — it autofills the endpoint and links you to create a key. ' +
            'Paste the key and press <strong>Save</strong>. It stays in your browser only.',
      before: () => { openSettings(); $('quickstart')?.classList.add('open'); },
      advanceOn: { event: 'vrmover:settings-saved', target: document },
    },
    {
      target: '#canvas-chrome',
      title: '2 · A starter scene to play with',
      body: 'The demo opens with a small <strong>living room</strong> — a couch facing a TV, a coffee ' +
            'table, chairs, a bookshelf and plants. Hit <strong>Clear scene</strong> to start from an ' +
            'empty floor, or <strong>Load example</strong> to bring this arrangement back any time.',
      before: () => { closeSettings(); if (!state.objects.length) seedDemoScene(); },
    },
    {
      target: '#palette',
      title: '3 · Object catalog',
      body: 'Drag an object onto the canvas to add it' + (isMobile ? ' (or tap a chip, then tap the canvas)' : '') +
            '. Press <strong>✎</strong> to edit names, sizes and icons, or <strong>+ Add object</strong> ' +
            'to define your own — the LLM’s catalog updates instantly.',
    },
    {
      target: '#room-canvas',
      title: '4 · Move with the gizmo',
      body: '<strong>Hover an object</strong> (the couch is ready for you) to reveal its gizmo. ' +
            'Grab the <strong>centre square</strong> ✛ and drag to <strong>move</strong> it — objects ' +
            'always stay inside the blue room. Give it a try, then come back.',
      before: () => tourFocusObject('Couch'),
    },
    {
      target: '#room-canvas',
      title: '5 · Rotate with the gizmo',
      body: 'The <strong style="color:#3fb950">green stem</strong> shows which way the object faces. ' +
            'Drag its <strong>round handle</strong> to <strong>rotate</strong> — the object turns to face ' +
            'wherever you drag. The <strong>scroll wheel</strong> over an object also rotates it in 15° steps.',
      before: () => tourFocusObject('Couch'),
    },
    {
      target: '#room-canvas',
      title: '6 · Point while you talk',
      body: '<strong>Click the floor</strong> to drop a <span class="ibadge ibadge-h">here</span> hit-point · ' +
            '<strong>click an object</strong> to select it · <strong>drag</strong> = a direction line · ' +
            '<strong>right-drag</strong> = an area · <strong>hold right-click</strong> (touch: long-press) = delete. ' +
            'These gestures are read by the LLM alongside your words.',
    },
    {
      target: '#editor',
      title: '7 · Compose a command',
      body: 'Every canvas action drops a <strong>badge</strong> (h1, o1, l1, a1) into your text, in order — ' +
            'e.g. <em>"move <b>o1</b> over <b>here</b> and rotate it to face the TV"</em>. ' +
            'Type a command, mix in badges, and press <strong>Send</strong>. We’ve dropped an example ' +
            'in the box — edit it however you like.',
      before: () => {
        editor.textContent = 'Move the couch a little closer to the TV and add a lamp in the empty corner';
      },
    },
    {
      target: '#mic-cluster',
      title: '8 · Or just speak',
      body: '<strong>Auto</strong> mimics the VR system: it listens continuously and auto-submits after a ' +
            'short silence. <strong>Hold</strong> is push-to-talk — words land in the input while you hold ' +
            'the mic, then you press Send. Voice needs the browser’s mic permission (asked on first use).',
    },
    {
      target: '#resp-panel',
      title: '9 · Watch the LLM work',
      body: 'Each round streams the raw tokens, then shows one row per recognised API call — ' +
            '<strong style="color:#3fb950">✓</strong> executed, ' +
            '<strong style="color:#f85149">✗</strong> failed (hover for the reason) — plus timing stats. ' +
            'That’s the whole loop — have fun rearranging the room!',
      before: () => { if (isMobile) showRespPanel(true); },
    },
  ];
}

function startTour() {
  tour?.end();
  tour = new Tour(tourSteps(), {
    onEnd: () => {
      // Leave the UI in a clean state no matter where the tour was abandoned
      closeSettings();
      if (window.matchMedia('(max-width: 960px)').matches) showRespPanel(false);
    },
  });
  tour.start();
}

function openWelcome() {
  $('welcome-overlay').classList.add('open');
}
function closeWelcome() {
  $('welcome-overlay').classList.remove('open');
  localStorage.setItem(SEEN_KEY, '1');
}

function setupWelcome() {
  $('welcome-tour').addEventListener('click', () => {
    closeWelcome();
    startTour();
  });
  $('welcome-skip').addEventListener('click', closeWelcome);
  $('btn-help').addEventListener('click', openWelcome);
  if (!localStorage.getItem(SEEN_KEY)) openWelcome();
}

// ============================================================
// Mobile: tabs + hamburger menu
// ============================================================
function showRespPanel(open) {
  $('resp-panel').classList.toggle('open', open);
  $('mtab-scene').classList.toggle('active', !open);
  $('mtab-resp').classList.toggle('active', open);
}

function setupMobile() {
  $('mtab-scene').addEventListener('click', () => showRespPanel(false));
  $('mtab-resp').addEventListener('click', () => showRespPanel(true));

  // "▦ Objects" pill toggles the slide-in object drawer (mobile only).
  $('palette-toggle')?.addEventListener('click', () => document.documentElement.classList.toggle('palette-open'));

  const menu = $('btn-menu');
  const actions = $('header-actions');
  menu.addEventListener('click', e => {
    e.stopPropagation();
    actions.classList.toggle('open');
  });
  document.addEventListener('click', e => {
    if (!actions.contains(e.target) && e.target !== menu) actions.classList.remove('open');
  });
}

// ============================================================
// Misc UI
// ============================================================
function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.textContent = msg;
  $('toast-container').appendChild(el);
  setTimeout(() => el.remove(), 3100);
}

// ============================================================
// Init
// ============================================================
// ============================================================
// Theme — synced with the project page (shared localStorage 'theme' key
// and the [data-theme] attribute on <html>)
// ============================================================
function currentTheme() {
  return document.documentElement.getAttribute('data-theme')
      || localStorage.getItem('theme')
      || (window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  localStorage.setItem('theme', theme);
  const icon = $('theme-icon');
  if (icon) icon.textContent = theme === 'dark' ? '☀️' : '🌙';
  refreshCanvasColours();
  render();
}
function setupTheme() {
  applyTheme(currentTheme());
  $('theme-toggle')?.addEventListener('click', () => {
    applyTheme(currentTheme() === 'dark' ? 'light' : 'dark');
  });
  // Follow the OS only while the user hasn't made an explicit choice elsewhere.
  window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener('change', e => {
    if (!localStorage.getItem('theme')) applyTheme(e.matches ? 'dark' : 'light');
  });
  // Keep in sync if the theme is toggled on the project page in another tab.
  window.addEventListener('storage', e => {
    if (e.key === 'theme' && e.newValue) applyTheme(e.newValue);
  });
}

// ============================================================
// Resizable sidebars — drag the inner edge of the palette / response panel.
// Widths are stored in CSS vars (--palette-w / --resp-w) and persisted.
// ============================================================
const PALETTE_W_KEY = 'vrmover_palette_w';
const RESP_W_KEY = 'vrmover_resp_w';
const clampN = (v, a, b) => Math.max(a, Math.min(b, v));

function setupResizers() {
  const root = document.documentElement;
  const PMIN = 132, PMAX = 320, RMIN = 240, RMAX = 640;

  const savedP = parseInt(localStorage.getItem(PALETTE_W_KEY) || '', 10);
  const savedR = parseInt(localStorage.getItem(RESP_W_KEY) || '', 10);
  if (savedP) root.style.setProperty('--palette-w', clampN(savedP, PMIN, PMAX) + 'px');
  if (savedR) root.style.setProperty('--resp-w', clampN(savedR, RMIN, RMAX) + 'px');

  const wire = (handle, varName, key, sign, min, max, fallback) => {
    if (!handle) return;
    handle.addEventListener('pointerdown', e => {
      if (window.matchMedia('(max-width: 960px)').matches) return;
      e.preventDefault();
      handle.setPointerCapture(e.pointerId);
      handle.classList.add('dragging');
      const startX = e.clientX;
      const startW = parseFloat(getComputedStyle(root).getPropertyValue(varName)) || fallback;
      const onMove = ev => {
        const w = clampN(startW + sign * (ev.clientX - startX), min, max);
        root.style.setProperty(varName, w + 'px');
        resizeCanvas();
      };
      const onUp = () => {
        handle.classList.remove('dragging');
        try { handle.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
        window.removeEventListener('pointermove', onMove);
        window.removeEventListener('pointerup', onUp);
        const w = Math.round(parseFloat(getComputedStyle(root).getPropertyValue(varName)) || fallback);
        localStorage.setItem(key, w);
        resizeCanvas();
        render();
      };
      window.addEventListener('pointermove', onMove);
      window.addEventListener('pointerup', onUp);
    });
  };

  wire($('resize-palette'), '--palette-w', PALETTE_W_KEY, +1, PMIN, PMAX, 172);
  wire($('resize-resp'), '--resp-w', RESP_W_KEY, -1, RMIN, RMAX, 440);

  // Collapse / expand each sidebar (persisted).
  const app = $('app');
  const setCollapsed = (side, on) => {
    app.classList.toggle(side + '-collapsed', on);
    localStorage.setItem('vrmover_' + side + '_collapsed', on ? '1' : '0');
    resizeCanvas();
    render();
  };
  if (localStorage.getItem('vrmover_palette_collapsed') === '1') app.classList.add('palette-collapsed');
  if (localStorage.getItem('vrmover_resp_collapsed') === '1') app.classList.add('resp-collapsed');
  $('palette-collapse')?.addEventListener('click', () => setCollapsed('palette', true));
  $('expand-palette')?.addEventListener('click', () => setCollapsed('palette', false));
  $('resp-collapse')?.addEventListener('click', () => setCollapsed('resp', true));
  $('expand-resp')?.addEventListener('click', () => setCollapsed('resp', false));
}

async function init() {
  const s = loadSettings();
  state.settings = s;
  state.confirmDelay = s.confirmDelay;
  state.room.w = s.roomW ?? 12;
  state.room.d = s.roomD ?? 10;

  setupTheme();
  buildPalette();
  setupEditor();
  setupObjEditor();
  voice.setupVoice();
  setupSettings();
  setupWelcome();
  setupMobile();
  setupResizers();

  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);

  sendBtn.addEventListener('click', sendRound);
  $('clear-input')?.addEventListener('click', () => { if (voice.isActive()) voice.stopSTT(); resetRound(); voice.clearInterim(); setStatus('idle', '● idle'); });
  $('resp-clear').addEventListener('click', () => {
    respLog.innerHTML = '';
  });
  $('instructions-toggle').addEventListener('click', () => {
    $('instructions').classList.toggle('open');
  });
  $('clear-scene').addEventListener('click', () => {
    if (!state.objects.length) { toast('Scene is already empty', 'info'); return; }
    clearScene();
    toast('Scene cleared', 'info');
  });
  $('load-example').addEventListener('click', () => {
    loadExampleEverything();
    toast('Loaded the example living room', 'success');
  });

  const ro = new ResizeObserver(resizeCanvas);
  ro.observe($('canvas-viewport'));
  resizeCanvas();

  // Load prompt pack
  try {
    const pack = await loadPromptPack('./prompts');
    state.systemPromptTemplate = pack.systemPrompt;
    state.userFewshot = pack.userFewshot;
    state.assistantFewshot = pack.assistantFewshot;
  } catch (err) {
    console.warn('Could not load prompt pack, using fallback system prompt:', err);
    state.systemPromptTemplate = '';
    state.userFewshot = null;
    state.assistantFewshot = null;
  }

  if (s.apiKey) {
    recreateLLM(s);
  }

  // Open with a real, editable scene plus its example response + follow-up command.
  loadExampleEverything();

  setStatus('idle', '● idle');
  console.log('[VR Mover Demo] Initialised');
}

init().catch(console.error);
