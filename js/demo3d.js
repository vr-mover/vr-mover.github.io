/* ============================================================
   VR Mover · Interactive 3D Demo — demo3d.js  (v3, free-cursor FPS)

   ARCHITECTURE — vr-mover.js is the engine (the paper's pipeline):
     OperatingRound (speech/text + hit-points + drawings + gaze frames)
       → LLMCore (ContextManager: system + PINNED FEW-SHOT + rolling pairs;
         SSE streaming → StreamingAPIExtractor → onCall per API call)
       → this file only renders the scene and EXECUTES the calls
         (executeLLMCall), exactly like the Unity C# side does.
   Shared page chrome (provider presets, voice input) lives in
   demo-shared.js and is reused verbatim by the 2D demo.

   Design notes vs. the Unity project:
     - First-person, but FREE CURSOR so the side panels + input stay usable
       without toggling pointer-lock: WALK with WASD while the mouse is over
       the room, LOOK by holding the RIGHT mouse button and dragging.
     - HOVER an object (cursor over it) → a single UNIFIED gizmo appears,
       CENTRED on the object: 3 translate arrows + 3 rotate rings + a scale
       cube, all at once (like Unity's universal gizmo / VRGizmoCore).
       A gizmo handle under the cursor overrides the left-click.
     - Pointing: left-click = "here", left-drag = line, Shift+left-drag = area.
       (Right-drag is reserved for look.)
     - Objects are kept inside the room: their world AABB is pushed back on
       x/y/z every frame (cf. ManipulatableObject.OutOfBoundDeltaMeasure).
     - Real CC0 furniture (Kenney Furniture Kit, glTF).
   ============================================================ */

import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { iconSVG, ICONS } from './icons.js';
import { LLMCore, OperatingRound, SpeechController } from './vr-mover.js?v=2';
import { PROVIDERS, applyProviderPreset, createVoiceInput } from './demo-shared.js?v=1';
import { Tour } from './tour.js?v=2';

const $ = id => document.getElementById(id);

// Built-in furniture (Kenney CC0 glb). Users can ADD their own objects built from
// primitive shapes via the "Add object" editor (see openObjEditor / USER_KEY).
const BUILTIN_CATALOG = [
  { name: 'Chair',      icon: 'chair',     w: 0.55, h: 0.95, d: 0.55, color: '#f0883e', desc: 'Modern wooden chair with an orange-toned seat and backrest; minimalist four-leg frame.', remarks: 'Bottom-centre anchor. Pairs with a Table or Desk; should face the work/dining surface (use LOOKAT toward it).' },
  { name: 'Table',      icon: 'table',     w: 1.20, h: 0.75, d: 0.80, color: '#d2a8ff', desc: 'Rectangular dining table, light-wood frame with a purple-tinted top; solid panel sides.', remarks: 'Bottom-centre anchor. Central gathering piece; chairs orbit and face it.' },
  { name: 'Desk',       icon: 'desk',      w: 1.40, h: 0.75, d: 0.70, color: '#79c0ff', desc: 'Rectangular work desk, light-wood frame with a white top and four cylindrical legs.', remarks: 'Bottom-centre anchor. A chair faces it for work positioning.' },
  { name: 'Couch',      icon: 'couch',     w: 1.90, h: 0.80, d: 0.90, color: '#7ee787', desc: 'Three-seat sofa with green cushioning, rounded armrests and a deep seat.', remarks: 'Bottom-centre anchor. Faces the TV (use LOOKAT toward the TV centre); primary viewing seat.' },
  { name: 'TV',         icon: 'tv',        w: 1.20, h: 0.75, d: 0.30, color: '#f778ba', desc: 'Flat-screen television, black frame with a cyan display and thin bezel on a base stand.', remarks: 'Bottom-centre anchor. PAIRED WITH TV Console: the TV sits on top and moves as one unit with the console. The couch faces it.' },
  { name: 'TV Console', icon: 'desk',      w: 1.60, h: 0.45, d: 0.40, color: '#d2a8ff', desc: 'Long wooden sideboard with a white top, three black-panelled doors and metal legs.', remarks: 'Bottom-centre anchor. PAIRED WITH TV: position the console first, then place the TV on top of it; move them together.', model: 'TVConsole' },
  { name: 'Bookshelf',  icon: 'bookshelf', w: 0.90, h: 1.80, d: 0.35, color: '#ffa657', desc: 'Tall white open bookshelf with multiple shelves holding colourful books and decor.', remarks: 'Bottom-centre anchor. Tall; place against a wall and FORWARD it toward the room interior. Good for corners.' },
  { name: 'Bed',        icon: 'bed',       w: 1.60, h: 0.60, d: 2.10, color: '#a5d6ff', desc: 'Double bed with a tall brown wooden headboard, green blanket and matching pillows.', remarks: 'Bottom-centre anchor. Place against a wall; FORWARD the headboard side toward the wall. Needs floor space along its length.' },
  { name: 'Wardrobe',   icon: 'wardrobe',  w: 1.00, h: 1.80, d: 0.55, color: '#e3b341', desc: 'Tall light-wood cabinet with closed doors; rectangular profile, vertical emphasis.', remarks: 'Bottom-centre anchor. Tall storage; place against a wall or in a corner, FORWARD toward the interior.' },
  { name: 'Plant',      icon: 'plant',     w: 0.50, h: 1.20, d: 0.50, color: '#3fb950', desc: 'Tall potted plant with vibrant green foliage in a decorative pot; organic accent.', remarks: 'Bottom-centre anchor. Decorative; fills corners or frames entryways.' },
  { name: 'Lamp',       icon: 'lamp',      w: 0.40, h: 1.50, d: 0.40, color: '#f2cc60', desc: 'Floor lamp with a slender pole, round base and a warm glowing conical shade.', remarks: 'Bottom-centre anchor. Lighting accent; place beside seating or in corners.', builder: 'lamp' },
  { name: 'Rug',        icon: 'rug',       w: 2.00, h: 0.04, d: 1.40, color: '#56d4dd', desc: 'Rectangular cyan floor rug with subtle texture and rounded corners; lies flat.', remarks: 'Lies flat on the floor. Largest horizontal surface; place under a seating group to define the zone; orientation rarely matters.' },
  { name: 'Picture',    icon: 'picture',   w: 0.80, h: 0.60, d: 0.06, color: '#a5d6ff', desc: 'Framed picture/painting: a wooden frame around a coloured canvas; thin and flat.', remarks: 'WALL-HUNG — its anchor is the CENTRE (the ONLY object not bottom-anchored). Hang flat against a wall at eye height (y≈1.50) and FORWARD it toward the room interior so the image faces inward. Never place it on the floor.', wall: true, builder: 'picture' },
];
const USER_KEY = 'vrmover3d_user_catalog';
const SHAPES = [
  { prim: 'box',      label: 'Cube' },
  { prim: 'sphere',   label: 'Sphere' },
  { prim: 'cylinder', label: 'Cylinder' },
  { prim: 'cone',     label: 'Cone' },
];
const SHAPE_ICON = { box: 'box', sphere: 'circle', cylinder: 'box', cone: 'box' };
function loadUserCatalog() { try { return (JSON.parse(localStorage.getItem(USER_KEY) || '[]')).map(p => ({ ...p, user: true })); } catch { return []; } }
function saveUserCatalog() { localStorage.setItem(USER_KEY, JSON.stringify(CATALOG.filter(p => p.user))); }
let CATALOG = BUILTIN_CATALOG.map(p => ({ ...p })).concat(loadUserCatalog());
const prefab = name => CATALOG.find(p => p.name === name) ?? null;

const state = {
  room: { w: 12, d: 10, h: 3 },
  objects: [], nextId: 1, lastCreatedId: null,
  hovered: null, gizmoObj: null, selected: new Set(),   // multi-select
  round: new OperatingRound(), roundN: 0,
  counters: { h: 0, o: 0, l: 0, a: 0 }, objBadges: new Map(),
  llm: null, llmBusy: false, settings: {},
  userFewshot: null, assistantFewshot: null,   // pinned few-shot pair (cf. Unity ContextManager)
  confirmDelay: 600,
};

// ============================================================
// Settings (shared localStorage with the 2D demo) — unchanged
// ============================================================
const SETTINGS_KEY = 'vrmover_settings';
const DEFAULT_SETTINGS = { baseUrl: 'https://api.openai.com/v1', apiKey: '', model: 'gpt-4o', authStyle: 'bearer', maxTokens: 2048, contextLength: 5, temperature: 0.3, lang: 'en-US' };
const loadSettings = () => { try { return { ...DEFAULT_SETTINGS, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; } catch { return { ...DEFAULT_SETTINGS }; } };
const saveSettings = s => localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...loadSettings(), ...s }));
function settingsToForm(s) {
  $('s-baseurl').value = s.baseUrl; $('s-apikey').value = s.apiKey; $('s-model').value = s.model;
  $('s-auth').value = s.authStyle; $('s-maxtok').value = s.maxTokens;
  $('s-ctxlen').value = s.contextLength; $('s-ctxlen-val').textContent = s.contextLength;
  $('s-temp').value = s.temperature; $('s-temp-val').textContent = s.temperature; $('s-lang').value = s.lang;
}
const formToSettings = () => ({ baseUrl: $('s-baseurl').value.trim(), apiKey: $('s-apikey').value.trim(), model: $('s-model').value.trim(), authStyle: $('s-auth').value, maxTokens: +$('s-maxtok').value, contextLength: +$('s-ctxlen').value, temperature: +$('s-temp').value, lang: $('s-lang').value.trim() || 'en-US' });
function buildSystemPrompt() {
  const prefabs = JSON.stringify(CATALOG.map(p => ({
    prefab_id: p.name,
    description: p.desc,
    remarks: p.remarks ?? '',
    dimensions: { x: p.w.toFixed(2), y: p.h.toFixed(2), z: p.d.toFixed(2) },
  })), null, 2);
  const envText = ENV.length ? JSON.stringify(ENV.map(e => ({ name: e.name, kind: e.kind, position: e.position, size: e.size })), null, 2) : '[]';
  const { w, d, h } = state.room;
  return `You are an expert assistant for a 3D object-manipulation system: a user standing INSIDE a room asks you to move, rotate, place, scale or remove objects around them. Reply ONLY with formatted API calls.

Coordinates (3D, right-handed, metres): x right (0…${w.toFixed(2)}), y up (0=floor, ceiling ${h.toFixed(2)}), z depth (0=back/north wall … ${d.toFixed(2)}=front/south wall). Room centre (${(w / 2).toFixed(2)}, 0, ${(d / 2).toFixed(2)}).

Anchoring: an object's "position" is its BOTTOM-CENTRE — it sits ON a surface, never floating. You set this bottom-centre directly via MOVE x/y/z.
  • On the floor → y = 0 (the default for every object).
  • ON TOP of another object B → set y to B's TOP = B.position.y + B.Size.y (B's bottom plus its full height). Do NOT add the placed object's own height or any half — only its bottom touches the surface, so its position.y IS the surface top. ("boundary.Central" is the geometric centre, for reasoning about extents only — do not use it as the position you set.)
  • Never set y below 0 (buried) or leave a gap under an object.
  • EXCEPTION — wall-hung items (the Picture): their position is the CENTRE, not the bottom. Hang flat on a wall at eye height (y≈1.50) and orient the image toward the room interior.

Orientation: objects face +Z when unrotated.
  • FORWARD(id, x, y, z) faces a DIRECTION vector — use for cardinal / wall-aligned facing (e.g. against the east wall x≈${w.toFixed(2)} → FORWARD(id,-1,0,0) to face inward).
  • LOOKAT(id, x, y, z) faces a POINT — use when an object should face another object or landmark (give the target's centre).
  *** Use EITHER FORWARD OR LOOKAT on a given object in a round, NEVER both — the second silently overwrites the first. ***
  Relationship defaults: dining/desk chairs LOOKAT their table/desk; couch/sofa LOOKAT the TV; bookcases, wardrobes and beds placed against a wall use FORWARD toward the room interior; lamps/plants in corners face inward.

APIs:
  CREATE(string prefab_id);                       // spawn at the room centre, then MOVE
  MOVE(string id, float? x, float? y, float? z);  // omit an axis to keep it; position is the bottom-centre anchor
  FORWARD(string id, float x, float y, float z);  // set facing by a direction
  LOOKAT(string id, float x, float y, float z);   // face a point
  SCALE(string id, float x, float y, float z);    // multiply size per axis (only when asked)
  DELETE(string id);
  MESSAGE(string content);                        // only for questions you cannot satisfy with calls
* id "crt" = the object from the previous call.

Prefabs (each has a "remarks" note on anchoring and pairing/facing — honour it; e.g. the TV and TV Console move together as one unit):
${prefabs}

Environment (fixed fixtures — walls, door, windows, ceiling lights, floor, ceiling; you CANNOT create/move/delete these, but use them as spatial anchors, e.g. "against the north wall", "beside the door", "under the window"):
${envText}

User context (in each request body):
  • "player" = the user's head transform {position, forward, right}. Interpret "left/right/in front of me/behind me/here/next to me" relative to it. "In front of me" ≈ player.position + a couple of metres along player.forward.
  • "head_stay_frames" = where the user was GAZING, newest last. Each frame lists in-view objects/environment with a Weight (higher = looked at longer & more centred) and may carry "Speak words" (what they said while looking there). Resolve vague references ("this", "that", "it", "the chair", "over here") to the HIGHEST-weighted in-view object of the right type.
  • "hit_points" = precise points the user pointed at. Each has "object" (the surface or object it landed on — e.g. a Wall, the Floor, the Ceiling, or an object id), a 3D "position", and a "normal" (which way that surface faces). A point can be ON A WALL/CEILING/OBJECT, not just the floor — use the normal (e.g. mount a Picture flush on the wall the point hit, facing along its normal).
  • "drawing_lines" = a start point and an end point, each with object + position + normal; the END normal is the line's DIRECTION. Use a line to set an object's facing/orientation or to lay objects along it; the start may be on an object. The user may also reference multiple objects at once (several "o" hit_points) — handle them together.

Rules: keep objects inside the room; two decimals; no maths in output (compute values yourself); calls only (no prose) unless using MESSAGE(); never call EXPLAIN(). Pointing references appear as [<id>] tokens — match "here/there/this" to the matching hit_point/line. Orient each object at most once per round.`;
}
function recreateLLM(s) { state.llm = new LLMCore({ baseUrl: s.baseUrl, apiKey: s.apiKey, model: s.model, authStyle: s.authStyle, maxTokens: s.maxTokens, temperature: s.temperature, contextLength: s.contextLength, streaming: $('chk-stream').checked, systemPrompt: buildSystemPrompt(), userFewshot: state.userFewshot, assistantFewshot: state.assistantFewshot }); }
// Pinned few-shot pair (3D variant of the paper's): a serialized scene + the ideal
// reply — incl. the stack-on-top y = position.y + Size.y worked example, mirroring
// the original PromptCactus-on-PromptDesk demonstration. Loaded once at startup;
// LLMCore's ContextManager pins it at the start of every conversation (as in Unity).
async function loadFewshot3D() {
  try {
    const [u, a] = await Promise.all([
      fetch('./prompts/user_fewshot3d.txt').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
      fetch('./prompts/assistant_fewshot3d.txt').then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); }),
    ]);
    state.userFewshot = u.trim(); state.assistantFewshot = a.trim();
  } catch (e) { console.warn('[VR Mover 3D] few-shot pair unavailable:', e.message); }
}
const openSettings = () => { settingsToForm(state.settings); $('settings-overlay').classList.add('open'); };
const closeSettings = () => $('settings-overlay').classList.remove('open');
function setupSettings() {
  $('btn-settings').addEventListener('click', openSettings);
  $('settings-close').addEventListener('click', closeSettings);
  $('settings-overlay').addEventListener('click', e => { if (e.target === $('settings-overlay')) closeSettings(); });
  $('s-cancel').addEventListener('click', closeSettings);
  $('quickstart-toggle').addEventListener('click', () => $('quickstart').classList.toggle('open'));
  $('s-provider').addEventListener('change', e => applyProviderPreset(e.target.value));
  applyProviderPreset('custom');
  ['s-ctxlen', 's-temp'].forEach(id => $(id).addEventListener('input', () => { $(`${id}-val`).textContent = $(id).value; }));
  $('chk-stream').addEventListener('change', e => state.llm?.updateConfig?.({ streaming: e.target.checked }));
  $('s-clear-key').addEventListener('click', () => { $('s-apikey').value = ''; toast('API key cleared', 'info'); });
  $('s-save').addEventListener('click', () => { const s = formToSettings(); state.settings = s; saveSettings(s); if (s.apiKey) recreateLLM(s); else state.llm = null; closeSettings(); toast('Settings saved', 'success'); document.dispatchEvent(new Event('vrmover:settings-saved')); });
}

// ============================================================
// Three.js scene + free-cursor first-person camera
// ============================================================
let renderer, scene, camera, raycaster, floorMesh, dom;
const viewport = $('three-viewport');
const EYE = 1.6, MOVE_SPEED = 3.4, LOOK_SENS = 0.0026;
const keys = {}; let yaw = 0, pitch = 0, overViewport = false;
const clock = new THREE.Clock();
const cssVar = (n, fb) => getComputedStyle(document.documentElement).getPropertyValue(n).trim() || fb;

function setupThree() {
  renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(viewport.clientWidth, viewport.clientHeight);
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  dom = renderer.domElement;
  viewport.appendChild(dom);

  scene = new THREE.Scene();
  const { w, d, h } = state.room, cx = w / 2, cz = d / 2;
  camera = new THREE.PerspectiveCamera(62, viewport.clientWidth / viewport.clientHeight, 0.05, 200);
  camera.rotation.order = 'YXZ'; scene.add(camera); resetView();

  floorMesh = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x000000, roughness: 1 }));
  floorMesh.rotation.x = -Math.PI / 2; floorMesh.position.set(cx, 0, cz); floorMesh.userData.env = true; floorMesh.userData.envName = 'Floor'; scene.add(floorMesh);
  const grid = new THREE.GridHelper(Math.max(w, d), Math.max(w, d)); grid.position.set(cx, 0.002, cz); grid.name = 'grid'; scene.add(grid);
  buildEnvironment();

  raycaster = new THREE.Raycaster();
  buildGizmo();
  applySceneTheme();
  setupInput();
  window.addEventListener('resize', onResize);
  new ResizeObserver(onResize).observe(viewport);
  animate();
}
function resetView() { const { w, d } = state.room; camera.position.set(w / 2, EYE, d - 0.4); yaw = 0; pitch = -0.16; applyLook(); }
function applyLook() { camera.rotation.y = yaw; camera.rotation.x = pitch; }
function applySceneTheme() {
  if (!scene) return;
  scene.background = new THREE.Color(cssVar('--c-bg', '#0d1117'));
  floorMesh.material.color.set(cssVar('--c-room-fill', '#10141a'));
  const grid = scene.getObjectByName('grid'); if (grid) { grid.material.color = new THREE.Color(cssVar('--c-grid-main', '#21262d')); grid.material.transparent = true; grid.material.opacity = 0.85; }
  const wire = scene.getObjectByName('roomwire'); if (wire) wire.material.color.set(cssVar('--c-wall', '#58a6ff'));
}
function onResize() { if (!renderer) return; const w = viewport.clientWidth, h = viewport.clientHeight; if (!w || !h) return; renderer.setSize(w, h); camera.aspect = w / h; camera.updateProjectionMatrix(); }

// ── Environment objects: walls, windows, ceiling lights. These are fixed scene
//    fixtures — NOT in state.objects, so they can't be hovered/selected/moved —
//    but they ARE described to the LLM as <env_objects> (cf. Unity EnvironmentObject). ──
let ENV = [];
function buildEnvironment() {
  const { w, d, h } = state.room, cx = w / 2, cz = d / 2;
  ENV = [];
  const env = new THREE.Group(); env.name = 'environment'; scene.add(env);

  // Lighting
  env.add(new THREE.HemisphereLight(0xffffff, 0x3a3f47, 0.7));
  const sun = new THREE.DirectionalLight(0xfff2dc, 0.6); sun.position.set(cx - 3, 9, cz - 2); env.add(sun);
  env.add(new THREE.AmbientLight(0xffffff, 0.32));

  // Walls (opaque, double-sided so they read from inside) + accent top edge
  const wallMat = new THREE.MeshStandardMaterial({ color: 0x3a414c, roughness: 0.95, side: THREE.DoubleSide });
  const addWall = (id, name, ww, x, z, ry, sx, sz) => {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(ww, h), wallMat); m.position.set(x, h / 2, z); m.rotation.y = ry; m.userData.env = true; m.userData.envName = name; env.add(m);
    ENV.push({ id, name, kind: 'wall', position: { x: +x.toFixed(2), y: +(h / 2).toFixed(2), z: +z.toFixed(2) }, size: { x: sx, y: +h.toFixed(2), z: sz } });
  };
  addWall('WallNorth', 'Wall (north, far)', w, cx, 0, 0, +w.toFixed(2), 0.10);
  addWall('WallSouth', 'Wall (south, near)', w, cx, d, 0, +w.toFixed(2), 0.10);
  addWall('WallWest', 'Wall (west, left)', d, 0, cz, Math.PI / 2, 0.10, +d.toFixed(2));
  addWall('WallEast', 'Wall (east, right)', d, w, cz, Math.PI / 2, 0.10, +d.toFixed(2));
  const wire = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(w, h, d)), new THREE.LineBasicMaterial({ color: 0x58a6ff })); wire.position.set(cx, h / 2, cz); wire.name = 'roomwire'; env.add(wire);

  // Door: a framed opening in the south (near) wall, toward the west end.
  const addDoor = (id, name, x, z, ry) => {
    const dw = 0.9, dh = 2.1, g = new THREE.Group(); g.position.set(x, dh / 2, z); g.rotation.y = ry;
    const leaf = new THREE.Mesh(new THREE.PlaneGeometry(dw, dh), new THREE.MeshStandardMaterial({ color: 0x6b4f3a, roughness: 0.8, side: THREE.DoubleSide }));
    leaf.position.z = -0.01; g.add(leaf);
    const fmat = new THREE.MeshStandardMaterial({ color: 0xe6edf3, roughness: 0.6 });
    const bar = (bw, bh, ox, oy) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.08), fmat); m.position.set(ox, oy, 0.02); g.add(m); };
    bar(dw + 0.14, 0.1, 0, dh / 2); bar(0.1, dh, -dw / 2, 0); bar(0.1, dh, dw / 2, 0);
    const knob = new THREE.Mesh(new THREE.SphereGeometry(0.04, 12, 8), fmat); knob.position.set(dw / 2 - 0.12, 0, 0.04); g.add(knob);
    g.traverse(o => { o.userData.env = true; o.userData.envName = name; }); env.add(g);
    ENV.push({ id, name, kind: 'door', position: { x: +x.toFixed(2), y: +(dh / 2).toFixed(2), z: +z.toFixed(2) }, size: { x: dw, y: dh, z: 0.1 } });
  };
  addDoor('DoorSouth', 'Door (south wall)', w * 0.22, d, 0);

  // Windows: a bright glass panel + frame let into a wall, with daylight spilling in.
  const addWindow = (id, name, x, z, ry) => {
    const g = new THREE.Group(); g.position.set(x, 1.45, z); g.rotation.y = ry;
    const ww = 1.6, wh = 1.2;
    g.add(new THREE.Mesh(new THREE.PlaneGeometry(ww, wh), new THREE.MeshBasicMaterial({ color: 0xbfe3ff, side: THREE.DoubleSide })));
    const fmat = new THREE.MeshStandardMaterial({ color: 0xe6edf3, roughness: 0.6 });
    const bar = (bw, bh, ox, oy) => { const m = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, 0.06), fmat); m.position.set(ox, oy, 0.02); g.add(m); };
    bar(ww + 0.12, 0.08, 0, wh / 2); bar(ww + 0.12, 0.08, 0, -wh / 2); bar(0.08, wh, -ww / 2, 0); bar(0.08, wh, ww / 2, 0); bar(0.06, wh, 0, 0); bar(ww, 0.06, 0, 0);
    g.traverse(o => { o.userData.env = true; o.userData.envName = name; }); env.add(g);
    const dl = new THREE.PointLight(0xdcefff, 0.5, 9); dl.position.set(x + Math.sin(ry) * 0.6, 1.6, z + Math.cos(ry) * 0.6); env.add(dl);
    ENV.push({ id, name, kind: 'window', position: { x: +x.toFixed(2), y: 1.45, z: +z.toFixed(2) }, size: { x: ww, y: wh, z: 0.1 } });
  };
  addWindow('WindowWest', 'Window (west wall)', 0.06, d * 0.5, Math.PI / 2);
  addWindow('WindowEast', 'Window (east wall)', w - 0.06, d * 0.35, Math.PI / 2);

  // Ceiling lights: emissive panels + point lights.
  const addCeilingLight = (id, x, z) => {
    const panel = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.06, 0.8), new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff3da, emissiveIntensity: 0.9 }));
    panel.position.set(x, h - 0.06, z); panel.userData.env = true; panel.userData.envName = 'Ceiling light'; env.add(panel);
    const pl = new THREE.PointLight(0xfff2dc, 0.55, 12); pl.position.set(x, h - 0.2, z); env.add(pl);
    ENV.push({ id, name: 'Ceiling light', kind: 'light', position: { x: +x.toFixed(2), y: +(h - 0.06).toFixed(2), z: +z.toFixed(2) }, size: { x: 0.8, y: 0.06, z: 0.8 } });
  };
  addCeilingLight('CeilingLight1', cx, d * 0.35);
  addCeilingLight('CeilingLight2', cx, d * 0.7);

  // Floor & ceiling as spatial anchors (floor mesh already exists; add a ceiling slab).
  const ceil = new THREE.Mesh(new THREE.PlaneGeometry(w, d), new THREE.MeshStandardMaterial({ color: 0x2b3038, roughness: 1, side: THREE.DoubleSide }));
  ceil.rotation.x = Math.PI / 2; ceil.position.set(cx, h, cz); ceil.userData.env = true; ceil.userData.envName = 'Ceiling'; env.add(ceil);
  ENV.push({ id: 'Floor',   name: 'Floor',   kind: 'floor',   position: { x: +cx.toFixed(2), y: 0,            z: +cz.toFixed(2) }, size: { x: +w.toFixed(2), y: 0.02, z: +d.toFixed(2) } });
  ENV.push({ id: 'Ceiling', name: 'Ceiling', kind: 'ceiling', position: { x: +cx.toFixed(2), y: +h.toFixed(2), z: +cz.toFixed(2) }, size: { x: +w.toFixed(2), y: 0.02, z: +d.toFixed(2) } });
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  // Movement from keyboard (when the mouse is over the room) and/or the on-screen joystick.
  let mvx = joyVec.x, mvz = joyVec.z;
  if (overViewport) { if (keys.w) mvz += 1; if (keys.s) mvz -= 1; if (keys.d) mvx += 1; if (keys.a) mvx -= 1; }
  if (mvx || mvz) {
    const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
    const right = new THREE.Vector3(Math.cos(yaw), 0, -Math.sin(yaw));
    const v = new THREE.Vector3().addScaledVector(fwd, mvz).addScaledVector(right, mvx);
    if (v.lengthSq() > 1) v.normalize();
    v.multiplyScalar(MOVE_SPEED * dt); const m = 0.3;
    camera.position.x = Math.max(m, Math.min(state.room.w - m, camera.position.x + v.x));
    camera.position.z = Math.max(m, Math.min(state.room.d - m, camera.position.z + v.z));
  }
  stepTweens();
  if (lastHover) updateHover(lastHover);   // re-evaluate hover as the camera moves
  updateGaze(dt);                          // accumulate gaze "head-stay" frames
  updateGizmoTransform();
  updateMarkerScale();
  updateGazeReadout();
  updateSelOutlines();
  renderer.render(scene, camera);
}

// ============================================================
// Input: free cursor, right-drag look, WASD walk, click pointing
// ============================================================
let look = null;       // { lx, ly }  active right-drag look
let gesture = null;    // { kind, start:{x,z}, shift }
let gizmoDrag = null;  // active gizmo handle drag
let lastHover = null;  // last mouse event, for per-frame hover re-evaluation
const ndc = new THREE.Vector2();
const joyVec = { x: 0, z: 0 };   // on-screen joystick movement (mobile)
let touchMode = 'look';          // 'look' | 'line' | 'area' (mobile drag mode)

// ── Smooth tweens (used to ease objects back in-bounds on release) ──────────
const tweens = [];
function tweenTo(o, target, dur = 0.45) { cancelTween(o); tweens.push({ o, from: o.group.position.clone(), to: target, t0: clock.elapsedTime, dur }); }
function cancelTween(o) { for (let i = tweens.length - 1; i >= 0; i--) if (tweens[i].o === o) tweens.splice(i, 1); }
function stepTweens() {
  for (let i = tweens.length - 1; i >= 0; i--) {
    const tw = tweens[i]; let t = (clock.elapsedTime - tw.t0) / tw.dur;
    if (t >= 1) t = 1;
    const e = t < 0.5 ? 2 * t * t : -1 + (4 - 2 * t) * t;   // smoothstep
    tw.o.group.position.lerpVectors(tw.from, tw.to, e);
    if (t >= 1) tweens.splice(i, 1);
  }
}
// Out-of-bounds delta from the object's world AABB (cf. OutOfBoundDeltaMeasure).
// World extent of the object's ORIENTED box (OBB) — the 8 corners of its cached
// local box transformed by the group's scale·rotation·position. Same box used for
// the selection outline, so bounds & outline agree (vs. a looser axis-aligned box).
const _obbMin = new THREE.Vector3(), _obbMax = new THREE.Vector3(), _obbC = new THREE.Vector3();
function obbWorldBounds(o) {
  const g = o.group, s = g.scale, lc = o.localCenter, ls = o.localSize;
  _obbMin.set(Infinity, Infinity, Infinity); _obbMax.set(-Infinity, -Infinity, -Infinity);
  for (let i = 0; i < 8; i++) {
    _obbC.set(lc.x + (i & 1 ? 0.5 : -0.5) * ls.x, lc.y + (i & 2 ? 0.5 : -0.5) * ls.y, lc.z + (i & 4 ? 0.5 : -0.5) * ls.z)
      .multiply(s).applyQuaternion(g.quaternion).add(g.position);
    _obbMin.min(_obbC); _obbMax.max(_obbC);
  }
}
function boundsDelta(o) {
  obbWorldBounds(o);
  const { w, h, d } = state.room, adj = new THREE.Vector3();
  if (_obbMin.x < 0) adj.x = -_obbMin.x; else if (_obbMax.x > w) adj.x = w - _obbMax.x;
  if (_obbMin.y < 0) adj.y = -_obbMin.y; else if (_obbMax.y > h) adj.y = h - _obbMax.y;
  if (_obbMin.z < 0) adj.z = -_obbMin.z; else if (_obbMax.z > d) adj.z = d - _obbMax.z;
  return adj;
}
// Allow out-of-bounds during a drag; on release ease the object back smoothly.
function settleInBounds(o, smooth = true) {
  const adj = boundsDelta(o);
  if (adj.lengthSq() < 1e-6 || adj.length() > 12) return;
  const target = o.group.position.clone().add(adj);
  if (smooth) tweenTo(o, target); else o.group.position.copy(target);
}

function setupInput() {
  viewport.addEventListener('mouseenter', () => { overViewport = true; });
  viewport.addEventListener('mouseleave', () => {
    overViewport = false; keys.w = keys.a = keys.s = keys.d = false; lastHover = null;
    if (state.hovered) { setHighlight(state.hovered, null); state.hovered = null; }
    if (state.gizmoObj && !gizmoDrag) hideGizmo();
  });
  dom.addEventListener('contextmenu', e => e.preventDefault());
  dom.addEventListener('mousedown', onDown);
  window.addEventListener('mousemove', onMove);
  window.addEventListener('mouseup', onUp);
  dom.addEventListener('wheel', e => { e.preventDefault(); dolly(-Math.sign(e.deltaY) * 0.6); }, { passive: false });
  window.addEventListener('keydown', e => {
    const el = document.activeElement;
    if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return;
    const k = e.key.toLowerCase();
    if ('wasd'.includes(k)) keys[k] = true;
    else if (e.key === 'Escape') clearSelection();
    else if (e.key === 'Delete' || e.key === 'Backspace') deleteSelectionOrHovered();
  });
  window.addEventListener('keyup', e => { keys[e.key.toLowerCase()] = false; });
}

// ── Mobile: virtual joystick + one-finger look / tap / draw + gizmo touch ───
// Fullscreen to reclaim the space the mobile browser UI steals. Works where the
// Fullscreen API exists (Android Chrome, desktop); hidden on iOS Safari (use
// "Add to Home Screen" for fullscreen there — the web-app meta tags enable it).
function setupFullscreen() {
  const root = document.documentElement;
  const req = root.requestFullscreen || root.webkitRequestFullscreen;
  const exitFn = document.exitFullscreen || document.webkitExitFullscreen;
  const isTouch = matchMedia('(pointer: coarse)').matches;
  const isIOS = /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));
  root.classList.toggle('has-fs', !!req);                 // FS API present (Android Chrome, desktop)
  root.classList.toggle('no-fs', !req);                   // no FS API (iPhone Safari)
  root.classList.toggle('is-ios', isIOS);
  const isFs = () => !!(document.fullscreenElement || document.webkitFullscreenElement);
  const isLandscape = () => matchMedia('(orientation: landscape)').matches;
  const enterFs = () => { if (!req) return; try { const r = req.call(root); if (r && r.catch) r.catch(() => {}); } catch {} };
  const exitFs = () => { if (isFs() && exitFn) try { exitFn.call(document); } catch {} };

  if (!isTouch) { root.classList.add('app-ready'); return; }   // desktop: never gate

  // Prerequisites by platform:
  //   • FS API present → must be in fullscreen AND landscape (gate shows "Enter the demo").
  //   • no FS API (iPhone) → only landscape; we DON'T mention fullscreen, we tell the user
  //     to hide Safari's toolbar instead (toast + a tip in the rotate prompt).
  const fsOk = () => req ? isFs() : true;
  const ready = () => isLandscape() && fsOk();
  let raf = 0, tid = 0, iosNotified = false;
  function refreshGate() {
    cancelAnimationFrame(raf); clearTimeout(tid);
    raf = requestAnimationFrame(() => { tid = setTimeout(() => {
      root.classList.toggle('fs-ok', fsOk());     // switches the gate from "Enter" → "Rotate"
      root.classList.toggle('is-fs', isFs());     // shows the ✕ exit button
      const ok = ready();
      root.classList.toggle('app-ready', ok);
      onResize();                                 // re-fit the renderer to the new box
      if (ok && isIOS && !req && !iosNotified) {  // iPhone: can't fullscreen → tell them how
        iosNotified = true;
        toast('iPhone: tap “aA” in the address bar → Hide Toolbar for full screen.', 'info');
      }
    }, 60); });
  }
  $('gate-enter-btn')?.addEventListener('click', () => { if (req && !isFs()) enterFs(); refreshGate(); });
  $('exit-fs-btn')?.addEventListener('click', () => { exitFs(); refreshGate(); });
  document.addEventListener('fullscreenchange', refreshGate);
  document.addEventListener('webkitfullscreenchange', refreshGate);
  window.addEventListener('orientationchange', refreshGate);
  window.addEventListener('resize', refreshGate);
  const mq = matchMedia('(orientation: landscape)');
  mq.addEventListener ? mq.addEventListener('change', refreshGate) : mq.addListener(refreshGate);
  refreshGate();
}
function setupTouch() {
  const joy = $('joystick'), nub = $('joynub');
  if (joy) {
    let jid = null, jcx = 0, jcy = 0;
    const moveNub = e => {
      const dx = e.clientX - jcx, dy = e.clientY - jcy, R = 44, len = Math.hypot(dx, dy) || 1, cl = Math.min(len, R);
      const nx = dx / len * cl, ny = dy / len * cl;
      nub.style.transform = `translate(${nx}px,${ny}px)`;
      joyVec.x = nx / R; joyVec.z = -ny / R;   // up on the pad = forward
    };
    const end = e => { if (e.pointerId !== jid) return; jid = null; joyVec.x = joyVec.z = 0; nub.style.transform = ''; };
    joy.addEventListener('pointerdown', e => { jid = e.pointerId; const r = joy.getBoundingClientRect(); jcx = r.left + r.width / 2; jcy = r.top + r.height / 2; try { joy.setPointerCapture(e.pointerId); } catch {} moveNub(e); e.preventDefault(); });
    joy.addEventListener('pointermove', e => { if (e.pointerId === jid) moveNub(e); });
    joy.addEventListener('pointerup', end); joy.addEventListener('pointercancel', end);
  }
  document.querySelectorAll('#touch-modes .tmode').forEach(b => b.addEventListener('click', () => {
    touchMode = b.dataset.mode;
    document.querySelectorAll('#touch-modes .tmode').forEach(x => x.classList.toggle('active', x === b));
  }));

  // ── Viewport gesture: ONE tracked finger (the "camera/draw" touch). ─────────
  // The joystick owns its own finger via Pointer Events on the #joystick overlay;
  // a finger that lands inside the joystick rect is skipped here (onJoystick), so
  // left-thumb walk + right-thumb look/draw run SIMULTANEOUSLY. Everything is keyed
  // by Touch.identifier (camId) so a second finger never hijacks the camera.
  let tt = null;          // active viewport gesture
  let camId = null;       // identifier of the finger that owns the viewport
  const TAP_SLOP = 10;    // px of travel still counted as a tap
  const pt = t => ({ clientX: t.clientX, clientY: t.clientY });
  // A touch only drives the 3D world if it lands DIRECTLY on the canvas — never on an
  // overlay (palette, pills, joystick, menu, input…). elementFromPoint ignores the
  // pointer-events:none labels, so taps over a readout still reach the canvas behind.
  const onCanvas = (x, y) => document.elementFromPoint(x, y) === dom;
  const findCam = list => { for (let i = 0; i < list.length; i++) if (list[i].identifier === camId) return list[i]; return null; };
  function finishGesture() {
    if (!tt) return;
    if (tt.mode === 'gizmo') { endGizmoDrag(); tt = null; return; }
    if (tt.moved) {
      if (touchMode !== 'look' && tt.start && tt.curr) {     // drag → draw (look already applied live)
        const dd = tt.start.v.distanceTo(tt.curr.v);
        if (dd > 0.2) (touchMode === 'area' ? addArea : addLine)(tt.start, tt.curr);
        clearPreview();
      }
    } else {                                                  // tap → PC left-click (mode-independent)
      const o = pickObjectAt(tt.p);
      if (o) { toggleSelect(o); if (state.selected.has(o)) showGizmoOn(o); else if (state.gizmoObj === o) hideGizmo(); }
      else if (tt.start) addHerePoint(tt.start);
    }
    tt = null;
  }
  dom.addEventListener('touchstart', e => {
    if (camId !== null) return;
    for (let i = 0; i < e.changedTouches.length; i++) {
      const t = e.changedTouches[i];
      if (!onCanvas(t.clientX, t.clientY)) continue;          // overlay/joystick tap — not the 3D world
      camId = t.identifier;
      const p = pt(t);
      const part = state.gizmoObj ? pickGizmoPart(p) : null;
      if (part) { beginGizmoDrag(part, p); tt = { mode: 'gizmo' }; }
      else tt = { mode: 'pending', x0: p.clientX, y0: p.clientY, sx0: p.clientX, sy0: p.clientY, moved: false, start: surfaceAt(p), p };
      e.preventDefault();
      break;
    }
  }, { passive: false });
  dom.addEventListener('touchmove', e => {
    if (camId === null || !tt) return;
    const t = findCam(e.changedTouches); if (!t) return;
    const p = pt(t);
    if (tt.mode === 'gizmo') { dragGizmo(p); e.preventDefault(); return; }
    if (!tt.moved && Math.hypot(p.clientX - tt.sx0, p.clientY - tt.sy0) > TAP_SLOP) tt.moved = true;
    if (touchMode === 'look') {
      yaw -= (p.clientX - tt.x0) * LOOK_SENS;
      pitch = Math.max(-1.45, Math.min(1.45, pitch - (p.clientY - tt.y0) * LOOK_SENS)); applyLook();
      tt.x0 = p.clientX; tt.y0 = p.clientY;
    } else if (tt.start) {
      const fp = surfaceAt(p); if (fp) { tt.curr = fp; drawPreview({ start: tt.start, curr: fp, shift: touchMode === 'area' }); }
    }
    e.preventDefault();
  }, { passive: false });
  const endTouch = e => {
    if (camId === null) return;
    if (findCam(e.changedTouches)) { finishGesture(); camId = null; return; }
    if (e.touches.length === 0) { finishGesture(); camId = null; }   // safety: never lock the viewport
  };
  dom.addEventListener('touchend', endTouch, { passive: false });
  dom.addEventListener('touchcancel', endTouch, { passive: false });
}
function dolly(amount) {
  const fwd = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw)).multiplyScalar(amount);
  const m = 0.3;
  camera.position.x = Math.max(m, Math.min(state.room.w - m, camera.position.x + fwd.x));
  camera.position.z = Math.max(m, Math.min(state.room.d - m, camera.position.z + fwd.z));
}
function setNDC(e) { const r = dom.getBoundingClientRect(); ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1); }
// Raycast ANY surface — floor, walls, ceiling, door/windows, or an object — and
// return the 3D point, the outward world normal, and the surface/object name. So
// pointing/lining/area can land on a wall or ceiling or object (cf. Unity HitPoint).
function surfaceAt(e) {
  setNDC(e); raycaster.setFromCamera(ndc, camera);
  const envGroup = scene.getObjectByName('environment');
  const targets = [floorMesh, ...state.objects.map(o => o.group)];
  if (envGroup) targets.push(envGroup);
  const hit = raycaster.intersectObjects(targets, true).find(h => h.face);   // need a surface face
  if (!hit) return null;
  const p = hit.point;
  const n = new THREE.Vector3().copy(hit.face.normal).transformDirection(hit.object.matrixWorld).normalize();
  if (n.dot(raycaster.ray.direction) > 0) n.negate();          // face the viewer (out of the surface)
  let node = hit.object;
  while (node && !node.userData?.id && !node.userData?.envName && node.parent) node = node.parent;
  const object = node?.userData?.id ?? hit.object.userData?.envName ?? node?.userData?.envName ?? null;
  return { v: p.clone(), x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), normal: n, object };
}

function onDown(e) {
  if (e.button === 2) { look = { lx: e.clientX, ly: e.clientY }; dom.style.cursor = 'grabbing'; return; }
  if (e.button !== 0) return;
  // gizmo handle under the cursor overrides the left-click
  if (state.gizmoObj) { const part = pickGizmoPart(e); if (part) { beginGizmoDrag(part, e); return; } }
  const obj = pickObjectAt(e);
  const fp = surfaceAt(e);
  if (!obj && !fp) return;
  gesture = { kind: 'pending', start: fp, obj, shift: e.shiftKey };
}
function onMove(e) {
  if (look) { yaw -= (e.clientX - look.lx) * LOOK_SENS; pitch -= (e.clientY - look.ly) * LOOK_SENS; pitch = Math.max(-1.45, Math.min(1.45, pitch)); applyLook(); look.lx = e.clientX; look.ly = e.clientY; return; }
  if (gizmoDrag) { dragGizmo(e); return; }
  if (gesture) { const fp = surfaceAt(e); if (fp) { gesture.curr = fp; drawPreview(gesture); } return; }
  // hover (cursor over the viewport)
  if (e.target === dom) updateHover(e);
}
function onUp(e) {
  if (e.button === 2 && look) { look = null; dom.style.cursor = ''; return; }
  if (gizmoDrag && e.button === 0) { endGizmoDrag(); return; }
  if (gesture && e.button === 0) {
    const fp = surfaceAt(e) || gesture.curr || gesture.start;
    const dist = (gesture.start && fp) ? gesture.start.v.distanceTo(fp.v) : 0;
    if (dist < 0.2) {
      if (gesture.obj) toggleSelect(gesture.obj);     // click an object → select / deselect
      else if (gesture.start) addHerePoint(gesture.start);   // click a surface → here
    } else if (gesture.shift) addArea(gesture.start, fp);
    else addLine(gesture.start, fp);
    clearPreview(); gesture = null;
  }
}

// Distance from a point to a ray (cf. Unity Ray2PointDistance).
function rayPointDist(ray, p) {
  const t = new THREE.Vector3().subVectors(p, ray.origin).dot(ray.direction);
  return p.distanceTo(ray.origin.clone().add(ray.direction.clone().multiplyScalar(t)));
}
// Hysteresis radius: the gizmo stays shown while the cursor ray passes within this
// of the gizmo centre — kept just past the arrow tips (which reach ~1.05*gizmoScale)
// so it releases as soon as the cursor leaves the handles.
function gizmoKeepRadius() { return gizmo.scale.x * 1.2; }

const HOVER_HL = 0x214b73;   // faint hover tint
const SELECT_HL = 0x3f7fd6;  // brighter "selected" tint

function pickObjectAt(e) {
  setNDC(e); raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(state.objects.map(o => o.group), true)[0];
  if (!hit) return null;
  let n = hit.object; while (n && !n.userData?.id) n = n.parent;
  return n ? state.objects.find(x => x.group === n) : null;
}
// Multi-select: click an object to add/remove it from the selection. Each selected
// object gets a bold highlight + bounding-box outline + an "o" reference badge.
const isSelected = o => state.selected.has(o);
function addSelect(o) {
  if (!o || state.selected.has(o)) return;
  state.selected.add(o); setHighlight(o, SELECT_HL); attachObjRef(o); updateReadout();
}
function removeSelect(o) {
  if (!o || !state.selected.has(o)) return;
  state.selected.delete(o); setHighlight(o, state.hovered === o ? HOVER_HL : null); detachObjRef(o);
}
function toggleSelect(o) { state.selected.has(o) ? removeSelect(o) : addSelect(o); }
function clearSelection() { for (const o of [...state.selected]) removeSelect(o); }
// An "o" reference badge mirrors a selected object: it adds a hit_point ON the
// object (so the LLM resolves "this/that object"), and deleting the badge deselects.
function attachObjRef(o) {
  if (o._refId != null) return;
  const c = objCenter(o);
  const id = state.round.addHit({ object: o.id, position: { x: +c.x.toFixed(2), y: +c.y.toFixed(2), z: +c.z.toFixed(2) } });
  o._refId = id; refObj.set(id, o);
  insertBadge('o', 'o' + (++state.counters.o), `[<${id}>]`, id);
}
function detachObjRef(o) {
  const id = o._refId; if (id == null) return;
  o._refId = null; refObj.delete(id); refKind.delete(id);
  state.round.removeHit(id);
  syncingRefs = true; removeBadgeByRef(id); syncingRefs = false;
}

// ── Hover: faint highlight + a transient gizmo preview when nothing is selected.
//    A SELECTED object keeps its gizmo regardless of where the cursor goes. ───
function updateHover(e) {
  if (gizmoDrag || look || gesture) return;
  lastHover = e;
  setNDC(e); raycaster.setFromCamera(ndc, camera);

  // 1) Handle-hover highlight (topmost handle under the cursor).
  let overHandle = null;
  if (state.gizmoObj) { gizmo.updateMatrixWorld(true); const gh = raycaster.intersectObjects(gizmoMeshes, false)[0]; overHandle = gh ? gh.object.userData.gizmo : null; }
  setGizmoHover(overHandle);

  // 2) Object under the cursor → faint hover highlight (selected stays bold).
  const hit = raycaster.intersectObjects(state.objects.map(o => o.group), true)[0];
  let o = null;
  if (hit) { let n = hit.object; while (n && !n.userData?.id) n = n.parent; o = n ? state.objects.find(x => x.group === n) : null; }
  if (o !== state.hovered) {
    if (state.hovered && !isSelected(state.hovered)) setHighlight(state.hovered, null);
    state.hovered = o;
    if (o && !isSelected(o)) setHighlight(o, HOVER_HL);
  }

  // 3) Gizmo target: purely hover-driven (with hysteresis so the cursor can reach
  //    far handles without it vanishing). Selection is independent (see selectObject).
  if (o) { if (state.gizmoObj !== o) showGizmoOn(o); }
  else if (state.gizmoObj) {
    const keep = overHandle || rayPointDist(raycaster.ray, objCenter(state.gizmoObj)) < gizmoKeepRadius(state.gizmoObj);
    if (!keep) hideGizmo();
  }
  dom.style.cursor = overHandle ? 'move' : (o ? 'pointer' : 'crosshair');
}

// ============================================================
// Models (CC0 glTF, preloaded + auto-fitted) + forward indicator
// ============================================================
const modelCache = new Map();
async function preloadModels() {
  const loader = new GLTFLoader();
  await Promise.all(CATALOG.map(pf => new Promise(resolve => {
    if (pf.prim || pf.builder) { resolve(); return; }   // built fresh per instance
    loader.load(`assets/models3d/${pf.model || pf.name}.glb`, gltf => {
      const root = gltf.scene;
      const box = new THREE.Box3().setFromObject(root); const size = new THREE.Vector3(); box.getSize(size);
      const s = Math.min(pf.w / (size.x || 1), pf.h / (size.y || 1), pf.d / (size.z || 1)); root.scale.setScalar(s);
      const b2 = new THREE.Box3().setFromObject(root); const c = new THREE.Vector3(); b2.getCenter(c);
      root.position.x -= c.x; root.position.z -= c.z; root.position.y -= b2.min.y;
      root.traverse(o => { if (o.isMesh) o.userData.baseEmissive = o.material.emissive?.clone?.(); });
      modelCache.set(pf.name, root); resolve();
    }, undefined, () => { modelCache.set(pf.name, primitiveMesh({ ...pf, prim: 'box' })); resolve(); });
  })));
}
function primitiveMesh(pf) {
  let geo;
  if (pf.prim === 'sphere') geo = new THREE.SphereGeometry(pf.w / 2, 28, 18);
  else if (pf.prim === 'cylinder') geo = new THREE.CylinderGeometry(pf.w / 2, pf.w / 2, pf.h, 28);
  else if (pf.prim === 'cone') geo = new THREE.ConeGeometry(pf.w / 2, pf.h, 28);
  else geo = new THREE.BoxGeometry(pf.w, pf.h, pf.d);
  const m = new THREE.Mesh(geo, new THREE.MeshStandardMaterial({ color: pf.color, roughness: 0.5, metalness: 0.05 }));
  m.position.y = pf.h / 2;           // sit on the floor
  m.userData.baseEmissive = m.material.emissive.clone();
  const g = new THREE.Group(); g.add(m); return g;
}
// Procedurally-built prefabs (cleaner than ill-proportioned glb for these).
function builtMesh(pf) { return pf.builder === 'lamp' ? lampMesh(pf) : pf.builder === 'picture' ? pictureMesh(pf) : null; }
const tagEmissive = m => { m.userData.baseEmissive = m.material.emissive ? m.material.emissive.clone() : null; return m; };
// Floor lamp: base + slim pole + shade (correctly proportioned, bottom-anchored), with a soft glow.
function lampMesh(pf) {
  const g = new THREE.Group();
  const h = pf.h, shadeH = Math.min(0.34, h * 0.24), shadeBot = pf.w / 2, shadeTop = pf.w * 0.3;
  const metal = () => new THREE.MeshStandardMaterial({ color: 0x4a4f57, roughness: 0.5, metalness: 0.6 });
  const base = new THREE.Mesh(new THREE.CylinderGeometry(pf.w * 0.32, pf.w * 0.36, 0.04, 24), metal()); base.position.y = 0.02; g.add(tagEmissive(base));
  const poleTop = h - shadeH;
  const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.018, 0.018, poleTop - 0.04, 12), metal()); pole.position.y = (0.04 + poleTop) / 2; g.add(tagEmissive(pole));
  const shade = new THREE.Mesh(new THREE.CylinderGeometry(shadeTop, shadeBot, shadeH, 28, 1, true),
    new THREE.MeshStandardMaterial({ color: pf.color, emissive: pf.color, emissiveIntensity: 0.55, roughness: 0.6, side: THREE.DoubleSide }));
  shade.position.y = poleTop + shadeH / 2; g.add(tagEmissive(shade));
  const bulb = new THREE.PointLight(0xfff0c0, 0.5, 6); bulb.position.y = poleTop + shadeH * 0.4; g.add(bulb);
  return g;
}
// Wall picture: framed canvas, CENTRE-anchored (it hangs on a wall, not the floor). Faces +Z.
function pictureMesh(pf) {
  const g = new THREE.Group();
  const frame = new THREE.Mesh(new THREE.BoxGeometry(pf.w, pf.h, pf.d),
    new THREE.MeshStandardMaterial({ color: 0x6b4f2a, roughness: 0.6, metalness: 0.1 }));
  g.add(tagEmissive(frame));
  const canvas = new THREE.Mesh(new THREE.PlaneGeometry(pf.w - 0.1, pf.h - 0.1),
    new THREE.MeshStandardMaterial({ color: pf.color, roughness: 0.8 }));
  canvas.position.z = pf.d / 2 + 0.002; g.add(tagEmissive(canvas));
  return g;   // centred at origin → group.position is the picture's centre
}
// Give an instance its OWN materials so highlighting one object never bleeds to
// other instances that shared the cached template's material.
function cloneInstanceMaterials(model) {
  model.traverse(m => {
    if (!m.isMesh || !m.material) return;
    m.material = Array.isArray(m.material) ? m.material.map(x => x.clone()) : m.material.clone();
    const mat = Array.isArray(m.material) ? m.material[0] : m.material;
    m.userData.baseEmissive = mat && mat.emissive ? mat.emissive.clone() : null;
  });
}
function createObject(prefabName, x, z, angle = 0) {
  const pf = prefab(prefabName); if (!pf) return null;
  const id = String(state.nextId++).padStart(6, '0');
  const group = new THREE.Group();
  // Procedural builders (lamp/picture) and user primitives are built fresh per
  // instance (already own their materials); glb furniture is cloned from cache
  // and given its OWN materials so highlights don't bleed between instances.
  let model;
  if (pf.builder) model = builtMesh(pf);
  else if (pf.prim) model = primitiveMesh(pf);
  else { model = (modelCache.get(pf.name) || primitiveMesh({ ...pf, prim: 'box' })).clone(true); cloneInstanceMaterials(model); }
  model.rotation.y = pf.yaw || 0;    // per-model facing correction
  group.add(model);
  // Cache the model's LOCAL box now (group still at identity) so the selection
  // outline can be drawn as an oriented box (OBB) that rotates with the object.
  const lb = new THREE.Box3().setFromObject(model);
  const localCenter = lb.getCenter(new THREE.Vector3()), localSize = lb.getSize(new THREE.Vector3());
  // Wall-hung objects (e.g. Picture) are centre-anchored and hang at eye height;
  // everything else is bottom-anchored on the floor (y=0).
  group.position.set(x, pf.wall ? (pf.anchorY ?? 1.5) : 0, z); group.rotation.y = angle;
  group.userData = { id, prefabId: pf.name };
  scene.add(group);
  const obj = { id, prefabId: pf.name, group, model, w: pf.w, h: pf.h, d: pf.d, color: pf.color, _refId: null, localCenter, localSize };
  state.objects.push(obj); state.lastCreatedId = id;
  return obj;
}
// Spawn point: 2 m in front of the user at floor level (cf. ManipulatableCore:
// initPos = PlayerTm.position + 2*PlayerTm.forward; initPos.y = RoomCenter.y).
function spawnPos() {
  const f = new THREE.Vector3(-Math.sin(yaw), 0, -Math.cos(yaw));
  const x = camera.position.x + 2 * f.x, z = camera.position.z + 2 * f.z;
  return { x: Math.max(0.6, Math.min(state.room.w - 0.6, x)), z: Math.max(0.6, Math.min(state.room.d - 0.6, z)) };
}
// Yaw so a new object faces back toward the user (so you see its front).
function faceUserAngle(x, z) { return Math.atan2(camera.position.x - x, camera.position.z - z); }
// Wall-hung spawn: snap to the wall nearest the user's spawn point, flush, facing inward.
function wallSpawn() {
  const sp = spawnPos(), { w, d } = state.room, off = 0.06;
  const dN = sp.z, dS = d - sp.z, dW = sp.x, dE = w - sp.x, m = Math.min(dN, dS, dW, dE);
  if (m === dN) return { x: sp.x, z: off, angle: 0 };                       // north wall → face +z
  if (m === dS) return { x: sp.x, z: d - off, angle: Math.PI };             // south wall → face -z
  if (m === dW) return { x: off, z: sp.z, angle: Math.PI / 2 };             // west wall  → face +x
  return { x: w - off, z: sp.z, angle: -Math.PI / 2 };                      // east wall  → face -x
}

function findObjectById(id) { return id === 'crt' ? state.objects.find(o => o.id === state.lastCreatedId) ?? null : state.objects.find(o => o.id === id) ?? null; }
function removeObject(o) { detachObjRef(o); state.selected.delete(o); if (state.gizmoObj === o) hideGizmo(); if (state.hovered === o) state.hovered = null; setHighlight(o, null); scene.remove(o.group); state.objects.splice(state.objects.indexOf(o), 1); state.objBadges.delete(o.id); }
// Delete every selected object, or the one under the cursor if nothing is selected.
function deleteSelectionOrHovered() {
  const targets = state.selected.size ? [...state.selected] : (state.gizmoObj ? [state.gizmoObj] : []);
  targets.forEach(removeObject);
}
function objMeshes(o) { const a = []; o.model.traverse(n => { if (n.isMesh) a.push(n); }); return a; }
function setHighlight(o, hex) { for (const m of objMeshes(o)) { if (!m.material?.emissive) continue; if (hex) m.material.emissive.setHex(hex); else if (m.userData.baseEmissive) m.material.emissive.copy(m.userData.baseEmissive); else m.material.emissive.setHex(0x000000); } }

const _box = new THREE.Box3();

// ============================================================
// Unified universal gizmo (translate arrows + rotate rings + scale cube)
// ============================================================
let gizmo, gizmoMeshes = [];
// Touch handling: the gizmo is scaled up (GIZMO_SCALE_MULT) AND its handles built
// fatter (HT) so they're tappable with a finger instead of pixel-precise. An extra
// invisible "proxy" mesh around the thin arrows/rings gives a generous hit area.
const IS_TOUCH = matchMedia('(pointer: coarse)').matches;
const GIZMO_SCALE_MULT = IS_TOUCH ? 1.8 : 1;
function buildGizmo() {
  gizmo = new THREE.Group(); gizmo.visible = false;
  const HT = IS_TOUCH ? 1.8 : 1;                 // handle-thickness boost on touch
  const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
  const COL = { x: 0xf85149, y: 0x3fb950, z: 0x58a6ff };
  const mkMat = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true });
  // Register a mesh for picking WITHOUT changing its parent.
  const mark = (mesh, data, color) => { mesh.material.depthTest = false; mesh.renderOrder = 1000; mesh.userData.gizmo = data; mesh.userData.baseColor = color; gizmoMeshes.push(mesh); };
  // Invisible fat hit-proxy (touch only) — generous pick target, never rendered.
  const proxy = (geo, data, parent) => { if (!IS_TOUCH) return; const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ visible: false, depthTest: false })); m.userData.gizmo = data; (parent || gizmo).add(m); gizmoMeshes.push(m); };

  for (const ax of ['x', 'y', 'z']) {
    const dir = AX[ax], col = COL[ax];
    // translate arrow (shaft + cone) reaching length ~1.0, built along +Y then
    // the whole arm oriented to the axis (shaft/tip stay children of the arm)
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(0.02 * HT, 0.02 * HT, 0.8, 8), mkMat(col));
    const tip = new THREE.Mesh(new THREE.ConeGeometry(0.07 * HT, 0.2, 12), mkMat(col));
    shaft.position.set(0, 0.5, 0); tip.position.set(0, 0.95, 0);
    const arm = new THREE.Group(); arm.add(shaft, tip); orientY(arm, dir); gizmo.add(arm);
    mark(shaft, { type: 'translate', axis: ax }, col); mark(tip, { type: 'translate', axis: ax }, col);
    proxy(new THREE.CylinderGeometry(0.14, 0.14, 1.05, 6).translate(0, 0.52, 0), { type: 'translate', axis: ax }, arm);  // fat finger target
    // scale cube partway along the axis
    const cube = new THREE.Mesh(new THREE.BoxGeometry(0.11 * HT, 0.11 * HT, 0.11 * HT), mkMat(col)); cube.position.copy(dir).multiplyScalar(0.62); gizmo.add(cube);
    mark(cube, { type: 'scale', axis: ax }, col);
    // rotate ring perpendicular to the axis
    const ring = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.022 * HT, 8, 40), mkMat(col)); orientRing(ring, ax); gizmo.add(ring);
    mark(ring, { type: 'rotate', axis: ax }, col);
    const rp = new THREE.Mesh(new THREE.TorusGeometry(0.62, 0.1, 6, 32), new THREE.MeshBasicMaterial({ visible: false, depthTest: false })); orientRing(rp, ax); rp.userData.gizmo = { type: 'rotate', axis: ax }; if (IS_TOUCH) { gizmo.add(rp); gizmoMeshes.push(rp); }
  }
  // Plane-translate handles: drag a small quad to move within that plane at once.
  // Coloured by the plane's NORMAL axis; XZ (ground) is the most useful.
  const PS = 0.16 * (IS_TOUCH ? 1.4 : 1);
  const planeMat = c => new THREE.MeshBasicMaterial({ color: c, depthTest: false, transparent: true, opacity: 0.4, side: THREE.DoubleSide });
  const PLANES = [
    { axis: 'xz', normal: 'y', col: COL.y, pos: [0.3, 0, 0.3], rot: q => { q.rotation.x = -Math.PI / 2; } },
    { axis: 'xy', normal: 'z', col: COL.z, pos: [0.3, 0.3, 0], rot: () => {} },
    { axis: 'yz', normal: 'x', col: COL.x, pos: [0, 0.3, 0.3], rot: q => { q.rotation.y = Math.PI / 2; } },
  ];
  for (const pl of PLANES) {
    const q = new THREE.Mesh(new THREE.PlaneGeometry(PS, PS), planeMat(pl.col));
    q.position.set(pl.pos[0], pl.pos[1], pl.pos[2]); pl.rot(q); gizmo.add(q);
    mark(q, { type: 'planeTranslate', axis: pl.axis, normal: pl.normal }, pl.col);
  }
  const uc = new THREE.Mesh(new THREE.BoxGeometry(0.14 * HT, 0.14 * HT, 0.14 * HT), mkMat(0xffffff)); gizmo.add(uc);
  mark(uc, { type: 'uscale' }, 0xffffff);
  scene.add(gizmo);
}
// Bright bounding-box outlines for EVERY selected object (a pooled set of meshes).
const _selSize = new THREE.Vector3(), _selCtr = new THREE.Vector3();
const selOutlines = [];
function makeOutline() {
  const o = new THREE.LineSegments(new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1)), new THREE.LineBasicMaterial({ color: 0xffd166, depthTest: false, transparent: true }));
  o.renderOrder = 997; scene.add(o); return o;
}
function updateSelOutlines() {
  const sel = [...state.selected];
  while (selOutlines.length < sel.length) selOutlines.push(makeOutline());
  selOutlines.forEach((ol, i) => {
    const o = sel[i]; if (!o) { ol.visible = false; return; }
    // Oriented box (OBB): take the cached LOCAL box, apply the object's scale + rotation
    // + position, so the outline hugs the object and ROTATES with it (not axis-aligned).
    const g = o.group, s = g.scale;
    _selCtr.copy(o.localCenter).multiply(s).applyQuaternion(g.quaternion).add(g.position);
    ol.position.copy(_selCtr);
    ol.quaternion.copy(g.quaternion);
    ol.scale.set(o.localSize.x * s.x + 0.04, o.localSize.y * s.y + 0.04, o.localSize.z * s.z + 0.04);
    ol.visible = true;
  });
}
function orientY(group, dir) { group.quaternion.setFromUnitVectors(new THREE.Vector3(0, 1, 0), dir); }
function orientRing(ring, ax) { if (ax === 'x') ring.rotation.y = Math.PI / 2; else if (ax === 'y') ring.rotation.x = Math.PI / 2; /* z: default XY plane */ }

function objCenter(o) { o.group.updateWorldMatrix(true, true); const c = new THREE.Vector3(); _box.setFromObject(o.model); _box.getCenter(c); return c; }
function showGizmoOn(o) { state.gizmoObj = o; gizmo.visible = true; updateGizmoTransform(); updateReadout(); }
function hideGizmo() { state.gizmoObj = null; gizmo.visible = false; $('sel-readout').classList.remove('show'); }
function updateGizmoTransform() {
  const o = state.gizmoObj; if (!o || !gizmo.visible) return;
  const c = objCenter(o);
  gizmo.position.copy(c);
  gizmo.quaternion.copy(o.group.quaternion);            // align with the object
  const dcam = camera.position.distanceTo(c);
  gizmo.scale.setScalar(Math.max(0.45, Math.min(1.4, dcam / 5)) * GIZMO_SCALE_MULT);
}
function pickGizmoPart(e) {
  gizmo.updateMatrixWorld(true);   // ensure handle world matrices are current
  setNDC(e); raycaster.setFromCamera(ndc, camera);
  const hit = raycaster.intersectObjects(gizmoMeshes, false)[0];
  return hit ? hit.object.userData.gizmo : null;
}
function setGizmoHover(part) {
  for (const m of gizmoMeshes) {
    const d = m.userData.gizmo;
    const on = part && d.type === part.type && d.axis === part.axis;
    m.material.color.setHex(on ? 0xffe066 : m.userData.baseColor);
  }
}
function setGizmoHighlight(active) {
  for (const m of gizmoMeshes) {
    const d = m.userData.gizmo;
    const on = active && d.type === active.type && d.axis === active.axis;
    m.material.color.setHex(on ? 0xffff66 : m.userData.baseColor);
  }
}

// ── Gizmo dragging (free cursor → accurate ray math) ───────────────────────
let dragData = null;
function worldAxis(ax) { const v = ax === 'x' ? new THREE.Vector3(1, 0, 0) : ax === 'y' ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1); return v.applyQuaternion(state.gizmoObj.group.quaternion).normalize(); }
function rayLineParam(ray, p, dir) { const op = new THREE.Vector3().subVectors(ray.origin, p); const b = ray.direction.dot(dir), d = ray.direction.dot(op), e = dir.dot(op); const denom = 1 - b * b; if (Math.abs(denom) < 1e-6) return 0; return (e - b * d) / denom; }
function rayPlane(ray, p, n) { const denom = n.dot(ray.direction); if (Math.abs(denom) < 1e-6) return null; const t = n.dot(new THREE.Vector3().subVectors(p, ray.origin)) / denom; return t < 0 ? null : ray.origin.clone().add(ray.direction.clone().multiplyScalar(t)); }
function beginGizmoDrag(part, e) {
  gizmoDrag = part; setGizmoHighlight(part);
  const o = state.gizmoObj, c = objCenter(o);
  cancelTween(o);   // stop any in-progress settle so the grab is immediate
  setNDC(e); raycaster.setFromCamera(ndc, camera);
  if (part.type === 'translate' || part.type === 'scale') {
    const axis = worldAxis(part.axis);
    dragData = { axis, center: c.clone(), t0: rayLineParam(raycaster.ray, c, axis), startPos: o.group.position.clone(), startScale: o.group.scale.clone() };
  } else if (part.type === 'planeTranslate') {
    const n = worldAxis(part.normal); const grab = rayPlane(raycaster.ray, c, n) || c;
    dragData = { n, center: c.clone(), grab: grab.clone(), startPos: o.group.position.clone() };
  } else if (part.type === 'rotate') {
    const n = worldAxis(part.axis); const p = rayPlane(raycaster.ray, c, n) || c;
    const u = new THREE.Vector3(); u.crossVectors(n, new THREE.Vector3(0, 1, 0)); if (u.lengthSq() < 1e-4) u.set(1, 0, 0); u.normalize();
    const v = new THREE.Vector3().crossVectors(n, u);
    const d0 = new THREE.Vector3().subVectors(p, c);
    dragData = { n, u, v, c, a0: Math.atan2(d0.dot(v), d0.dot(u)), startQuat: o.group.quaternion.clone() };
  } else if (part.type === 'uscale') {
    const proj = c.clone().project(camera); const r = dom.getBoundingClientRect();
    const sx = (proj.x * 0.5 + 0.5) * r.width + r.left, sy = (-proj.y * 0.5 + 0.5) * r.height + r.top;
    dragData = { c2: { x: sx, y: sy }, d0: Math.max(20, Math.hypot(e.clientX - sx, e.clientY - sy)), startScale: o.group.scale.clone() };
  }
}
function dragGizmo(e) {
  const o = state.gizmoObj; if (!o || !gizmoDrag) return;
  setNDC(e); raycaster.setFromCamera(ndc, camera);
  const p = gizmoDrag;
  if (p.type === 'translate') {
    const t = rayLineParam(raycaster.ray, dragData.center, dragData.axis);
    o.group.position.copy(dragData.startPos).add(dragData.axis.clone().multiplyScalar(t - dragData.t0));
  } else if (p.type === 'planeTranslate') {
    const pt = rayPlane(raycaster.ray, dragData.center, dragData.n); if (!pt) return;
    o.group.position.copy(dragData.startPos).add(new THREE.Vector3().subVectors(pt, dragData.grab));
  } else if (p.type === 'scale') {
    const t = rayLineParam(raycaster.ray, dragData.center, dragData.axis);
    const f = Math.max(0.25, Math.min(4, 1 + (t - dragData.t0) * 1.2));
    const s = dragData.startScale.clone(); s[p.axis] *= f; o.group.scale.copy(s);
  } else if (p.type === 'rotate') {
    const pt = rayPlane(raycaster.ray, dragData.c, dragData.n); if (!pt) return;
    const dd = new THREE.Vector3().subVectors(pt, dragData.c);
    const ang = Math.atan2(dd.dot(dragData.v), dd.dot(dragData.u));
    const q = new THREE.Quaternion().setFromAxisAngle(dragData.n, ang - dragData.a0);
    o.group.quaternion.copy(q.multiply(dragData.startQuat));
  } else if (p.type === 'uscale') {
    const f = Math.max(0.25, Math.min(4, Math.hypot(e.clientX - dragData.c2.x, e.clientY - dragData.c2.y) / dragData.d0));
    o.group.scale.copy(dragData.startScale.clone().multiplyScalar(f));
  }
  updateReadout();   // no clamping while dragging → no shaking
}
function endGizmoDrag() {
  const o = state.gizmoObj;
  gizmoDrag = null; dragData = null; setGizmoHighlight(null);
  if (o) settleInBounds(o);   // ease back inside the room on release
}

function updateReadout() {
  const o = state.gizmoObj, el = $('sel-readout'); if (!o) { el.classList.remove('show'); return; }
  const g = o.group, eu = new THREE.Euler().setFromQuaternion(g.quaternion, 'YXZ');
  el.classList.add('show');
  el.innerHTML = `<b>${o.prefabId}</b> #${o.id}<br>x ${g.position.x.toFixed(2)}  y ${g.position.y.toFixed(2)}  z ${g.position.z.toFixed(2)}<br>yaw ${(eu.y * 180 / Math.PI).toFixed(0)}°  ·  scale ${g.scale.x.toFixed(2)}`;
}

// ============================================================
// Pointing markers + round badges
// ============================================================
const markers = new THREE.Group();
// Editor badge ⇄ 3D world sync. Each here-point/line/area marker and each object
// reference is tagged with the round ref id of its editor badge; deleting the
// badge (backspace/cut) removes the matching 3D marker / deselects the object.
const refKind = new Map();   // refId -> 'h' | 'l' | 'a' | 'o'
const refObj = new Map();    // refId -> object  (for 'o' references)
let syncingRefs = false;
function ensureMarkers() { if (!markers.parent) scene.add(markers); }
function tagMarker(m, ref, kind) { m.userData.ref = ref; m.userData.kind = kind; markers.add(m); }
function disposeMarker(m) { markers.remove(m); m.traverse(c => c.geometry?.dispose?.()); }
// Cursors are world-sized → re-scale each frame so a far "here" point stays legible
// (lines/areas mark fixed world points and must NOT distance-scale).
function updateMarkerScale() {
  if (!markers.parent) return;
  for (const m of markers.children) if (m.userData.cursor) m.scale.setScalar(cursorDistScale(m.position) * m.userData.baseScale / MARKER_SCALE);
}
const vecObj = n => ({ x: +n.x.toFixed(2), y: +n.y.toFixed(2), z: +n.z.toFixed(2) });
const niceName = id => state.objects.find(x => x.id === id)?.prefabId ?? id;
const _up = new THREE.Vector3(0, 1, 0);
// Markers authored at desktop scale are hard to see on a phone — bump them on touch/small screens.
const MARKER_SCALE = ((matchMedia('(pointer: coarse)').matches || matchMedia('(max-width: 760px)').matches) ? 2.3 : 1);
const cursorDistScale = pos => Math.max(1, Math.min(2.2, camera.position.distanceTo(pos) / 4));
// Hit cursor: a small cone aiming down at a ring on the surface, oriented to the
// surface normal — shows the spot AND which way the surface faces (cf. Unity HitPointMarker).
function makeCursor(point, normal, color) {
  const s = MARKER_SCALE;
  const g = new THREE.Group(); g.position.copy(point);
  g.quaternion.setFromUnitVectors(_up, normal && normal.lengthSq() ? normal.clone().normalize() : _up);
  g.userData.cursor = true; g.userData.baseScale = s;                 // per-frame distance scaling
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: true });
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.05 * s, 0.085 * s, 28), mat); ring.rotation.x = -Math.PI / 2; ring.position.y = 0.002;
  const dot = new THREE.Mesh(new THREE.CircleGeometry(0.022 * s, 16), mat); dot.rotation.x = -Math.PI / 2; dot.position.y = 0.003;
  const cone = new THREE.Mesh(new THREE.ConeGeometry(0.05 * s, 0.14 * s, 16), mat); cone.position.y = 0.155 * s; cone.rotation.x = Math.PI;   // tip points down at the spot
  g.add(ring, dot, cone); g.traverse(m => { m.renderOrder = 998; }); return g;
}
// A 3D line with an arrowhead at the END. LineBasicMaterial.linewidth is ignored on
// WebGL/ANGLE, so the shaft is a CYLINDER — real, scalable thickness that reads bold
// on mobile. Opaque so overlapping shaft+head don't double-blend; depthTest off + high
// renderOrder keep it on top.
function makeLine(start, end, color) {
  const s = MARKER_SCALE, g = new THREE.Group();
  const mat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: false });
  const dir = new THREE.Vector3().subVectors(end, start), len = dir.length();
  if (len > 1e-4) {
    dir.normalize();
    const radius = 0.012 * s;
    const shaft = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 10), mat);
    shaft.position.copy(start).addScaledVector(dir, len / 2); shaft.quaternion.setFromUnitVectors(_up, dir); g.add(shaft);
    const arrow = new THREE.Mesh(new THREE.ConeGeometry(0.05 * s, 0.16 * s, 14), mat);
    arrow.position.copy(end); arrow.quaternion.setFromUnitVectors(_up, dir); g.add(arrow);
  }
  g.traverse(m => { m.renderOrder = 998; }); return g;
}
// A filled rectangle + outline lying in the plane of the start surface.
function planeBasis(n) {
  let u = new THREE.Vector3().crossVectors(_up, n); if (u.lengthSq() < 1e-4) u = new THREE.Vector3().crossVectors(new THREE.Vector3(1, 0, 0), n); u.normalize();
  return { u, v: new THREE.Vector3().crossVectors(n, u).normalize() };
}
function areaCorners(a, b) {
  const n = a.normal.clone().normalize(), { u, v } = planeBasis(n);
  const d = new THREE.Vector3().subVectors(b.v, a.v), du = d.dot(u), dv = d.dot(v);
  const corner = (s, t) => a.v.clone().addScaledVector(u, s).addScaledVector(v, t);
  return [corner(0, 0), corner(du, 0), corner(du, dv), corner(0, dv)];
}
function makeArea(c, color) {
  const s = MARKER_SCALE, g = new THREE.Group();
  const geo = new THREE.BufferGeometry().setFromPoints([c[0], c[1], c[2], c[0], c[2], c[3]]);
  g.add(new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthTest: false })));
  // Bold border: a cylinder per edge (LineLoop is 1px on ANGLE → invisible on mobile).
  const edgeMat = new THREE.MeshBasicMaterial({ color, depthTest: false, transparent: false }), radius = 0.01 * s;
  for (let i = 0; i < c.length; i++) {
    const a = c[i], b = c[(i + 1) % c.length], d = new THREE.Vector3().subVectors(b, a), len = d.length();
    if (len < 1e-4) continue;
    d.normalize();
    const edge = new THREE.Mesh(new THREE.CylinderGeometry(radius, radius, len, 8), edgeMat);
    edge.position.copy(a).addScaledVector(d, len / 2); edge.quaternion.setFromUnitVectors(_up, d); g.add(edge);
  }
  g.traverse(m => { m.renderOrder = 998; }); return g;
}
let preview = null;
function clearPreview() { if (preview) { disposeMarker(preview); preview = null; } }
function drawPreview(g) {
  if (!g.curr || !g.start) return; ensureMarkers(); clearPreview();
  preview = g.shift ? makeArea(areaCorners(g.start, g.curr), 0x39d353) : makeLine(g.start.v, g.curr.v, 0xbc8cff);
  markers.add(preview);
}
function insertBadge(kind, label, token, refId) { refKind.set(refId, kind); const b = document.createElement('span'); b.className = `ibadge ibadge-${kind}`; b.contentEditable = 'false'; b.dataset.token = token; b.dataset.ref = refId; b.dataset.kind = kind; b.textContent = label; editor.append(b, document.createTextNode(' ')); }
function removeBadgeByRef(refId) { editor.querySelectorAll('.ibadge').forEach(b => { if (b.dataset.ref === String(refId)) b.remove(); }); }
function serializeEditor() { let out = ''; editor.childNodes.forEach(n => { if (n.nodeType === Node.TEXT_NODE) out += n.textContent; else if (n.classList?.contains('interim')) { /* live speech ghost — not committed */ } else if (n.dataset?.token) out += ' ' + n.dataset.token + ' '; else out += n.textContent ?? ''; }); return out.replace(/\s+/g, ' ').trim(); }
// A "here" point on ANY surface — records the surface/object hit + its normal.
function addHerePoint(hit) {
  const id = state.round.addHit({ object: hit.object, position: { x: hit.x, y: hit.y, z: hit.z }, normal: vecObj(hit.normal) });
  insertBadge('h', 'h' + (++state.counters.h), `[<${id}>]`, id);
  ensureMarkers(); tagMarker(makeCursor(hit.v, hit.normal, 0xe3b341), id, 'h');
  clearPreview(); toast(hit.object ? `Marked “here” on ${niceName(hit.object)}` : 'Marked “here”', 'info');
}
// A line from a start surface/object to an end — endpoints carry object + normal;
// the END normal doubles as the direction (cf. Unity DrawingLine Start/End).
function addLine(a, b) {
  const dir = new THREE.Vector3().subVectors(b.v, a.v).normalize();
  const id = state.round.addDrawing({ points: [
    { x: a.x, y: a.y, z: a.z, object: a.object, normal: vecObj(a.normal) },
    { x: b.x, y: b.y, z: b.z, object: b.object, normal: vecObj(dir) },
  ] });
  insertBadge('l', 'l' + (++state.counters.l), `[<${id}>start] [<${id}>end]`, id);
  ensureMarkers(); tagMarker(makeLine(a.v, b.v, 0xbc8cff), id, 'l');
  clearPreview(); toast(a.object ? `Drew a line from ${niceName(a.object)}` : 'Drew a line', 'info');
}
// An area rectangle in the plane of the start surface.
function addArea(a, b) {
  const c = areaCorners(a, b), n = a.normal.clone().normalize();
  const id = state.round.addDrawing({ points: c.map(p => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2), object: a.object, normal: vecObj(n) })) });
  insertBadge('a', 'a' + (++state.counters.a), `[<${id}>start] [<${id}>end]`, id);
  ensureMarkers(); tagMarker(makeArea(c, 0x39d353), id, 'a');
  clearPreview(); toast('Marked an area', 'info');
}
function clearMarkers() { if (markers.parent) markers.clear(); refKind.clear(); refObj.clear(); }
// Remove the 3D counterpart of a deleted editor badge: drop its round entry +
// any tagged marker meshes; an object reference deselects (keeps the object).
function removeSceneRef(refId) {
  if (syncingRefs) return;
  syncingRefs = true;
  state.round.removeHit(refId); state.round.removeDrawing(refId);
  for (const m of [...markers.children]) if (String(m.userData.ref) === String(refId)) disposeMarker(m);
  const o = refObj.get(refId);
  if (o) { refObj.delete(refId); o._refId = null; state.selected.delete(o); setHighlight(o, state.hovered === o ? HOVER_HL : null); }
  refKind.delete(refId);
  syncingRefs = false;
}
// After any editor edit, drop refs whose badge is no longer present.
function reconcileEditorRefs() {
  if (syncingRefs) return;
  const present = new Set(); editor.querySelectorAll('.ibadge').forEach(b => present.add(b.dataset.ref));
  for (const refId of [...refKind.keys()]) if (!present.has(String(refId))) removeSceneRef(refId);
}
function setupEditorSync() {
  new MutationObserver(() => reconcileEditorRefs()).observe(editor, { childList: true, subtree: true });
  editor.addEventListener('input', reconcileEditorRefs);
}
function resetRound() {
  state.round = new OperatingRound(); state.counters = { h: 0, o: 0, l: 0, a: 0 }; state.objBadges.clear();
  for (const o of [...state.selected]) { setHighlight(o, state.hovered === o ? HOVER_HL : null); }
  state.selected.clear();
  for (const o of state.objects) o._refId = null;                                   // refs belonged to the old round
  editor.textContent = ''; clearMarkers();
}

// ── Scene serialisation (3D) ───────────────────────────────────────────────
function sceneObjects() {
  return state.objects.map(o => { const g = o.group; const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(g.quaternion); const ctr = objCenter(o);
    return { object_id: o.id, object_name: o.prefabId,
      position: { x: g.position.x.toFixed(2), y: g.position.y.toFixed(2), z: g.position.z.toFixed(2) },
      scale: { x: g.scale.x.toFixed(2), y: g.scale.y.toFixed(2), z: g.scale.z.toFixed(2) },
      boundary: { Central: { x: ctr.x.toFixed(2), y: ctr.y.toFixed(2), z: ctr.z.toFixed(2) }, Size: { x: (o.w * g.scale.x).toFixed(2), y: (o.h * g.scale.y).toFixed(2), z: (o.d * g.scale.z).toFixed(2) }, Forward: { x: fwd.x.toFixed(2), y: fwd.y.toFixed(2), z: fwd.z.toFixed(2) } } };
  });
}
// Player head transform (cf. Unity user prompt "player").
function playerState() {
  const f = new THREE.Vector3(); camera.getWorldDirection(f);
  const r = new THREE.Vector3().crossVectors(f, new THREE.Vector3(0, 1, 0)).normalize();
  const fx = v => +v.toFixed(2);
  return { position: { x: fx(camera.position.x), y: fx(camera.position.y), z: fx(camera.position.z) },
           forward: { x: fx(f.x), y: fx(f.y), z: fx(f.z) },
           right: { x: fx(r.x), y: fx(r.y), z: fx(r.z) } };
}

// ── Gaze / head-stay frames (cf. Unity ManipulatableCore.HeadKeyFrame) ──────
// While the head dwells (small move/rotate) we accumulate a per-object "staring"
// weight — higher the longer & more centrally an object sits in view — then feed
// committed frames to the LLM so it can resolve "this/that/here" from gaze.
const HEAD_MOVE_THRESH = 0.15, HEAD_ROT_THRESH = 18 * Math.PI / 180, HEAD_STAY_THRESH = 1.2, HEAD_MAX_FRAMES = 6;
const gaze = { frames: [], current: null };
const _gv = new THREE.Vector3(), _gbox = new THREE.Box3();
const camForward = () => { const f = new THREE.Vector3(); camera.getWorldDirection(f); return f; };
function newHeadFrame() { return { pos: camera.position.clone(), fwd: camForward(), dur: 0, objW: new Map(), envW: new Map() }; }
// VisibleFactor: 0 if a corner is behind the camera or off-screen; else
// 2 − dist(viewport-pt, centre). We gate on the SIGNED forward depth first —
// THREE's project() wraps behind-camera points into range, so an unsigned
// distance check would wrongly count objects behind the user.
function visibleFactor(px, py, pz, cf) {
  const fdist = (px - camera.position.x) * cf.x + (py - camera.position.y) * cf.y + (pz - camera.position.z) * cf.z;
  if (fdist <= 0) return 0;                                   // behind the camera → not visible
  const v = _gv.set(px, py, pz).project(camera);              // valid now the point is in front
  const vx = (v.x + 1) / 2, vy = (v.y + 1) / 2, vz = fdist / 20;
  if (vx < 0 || vx > 1 || vy < 0 || vy > 1 || vz > 1) return 0;
  const dx = vx - 0.5, dy = vy - 0.5, dz = vz - 0.5;
  return Math.max(0, 2 - Math.sqrt(dx * dx + dy * dy + dz * dz));
}
function boxWeight(min, max, dt, cf) {
  let s = 0;
  for (let i = 0; i < 8; i++) s += visibleFactor(i & 1 ? max.x : min.x, i & 2 ? max.y : min.y, i & 4 ? max.z : min.z, cf);
  return s * dt;
}
function updateGaze(dt) {
  if (!gaze.current) gaze.current = newHeadFrame();
  const f = gaze.current, cf = camForward();
  if (camera.position.distanceTo(f.pos) > HEAD_MOVE_THRESH || cf.angleTo(f.fwd) > HEAD_ROT_THRESH) {
    commitGazeFrame(); gaze.current = newHeadFrame(); return;
  }
  f.dur += dt;
  for (const o of state.objects) { o.group.updateWorldMatrix(true, true); _gbox.setFromObject(o.model); const w = boxWeight(_gbox.min, _gbox.max, dt, cf); if (w > 0) f.objW.set(o, (f.objW.get(o) || 0) + w); }
  for (const e of ENV) { const h = { x: e.size.x / 2, y: e.size.y / 2, z: e.size.z / 2 }; const w = boxWeight({ x: e.position.x - h.x, y: e.position.y - h.y, z: e.position.z - h.z }, { x: e.position.x + h.x, y: e.position.y + h.y, z: e.position.z + h.z }, dt, cf); if (w > 0) f.envW.set(e, (f.envW.get(e) || 0) + w); }
}
// Readout = the most-CENTRED in-view object, computed fresh each frame (NOT from the
// accumulating head-frame, which resets on every micro head-move → the flicker). A short
// "hold" keeps it from blinking off while you sweep past gaps. Runs from animate().
let _gazeTop = null, _gazeHoldUntil = 0;
function updateGazeReadout() {
  const el = $('gaze-readout'); if (!el) return;
  const cf = camForward();
  let best = null, bestW = 1.0;                 // require reasonably centred (factor>1.0)
  for (const o of state.objects) { const c = objCenter(o); const w = visibleFactor(c.x, c.y, c.z, cf); if (w > bestW) { bestW = w; best = o; } }
  const now = (typeof performance !== 'undefined' ? performance.now() : Date.now());
  let name = best ? best.prefabId : null;
  if (name) _gazeHoldUntil = now + 700;         // refresh the hold while something is centred
  else if (now < _gazeHoldUntil) name = _gazeTop;   // sticky: keep the last briefly to avoid blink
  if (name === _gazeTop) return;
  _gazeTop = name;
  if (name) { el.innerHTML = `👁 looking at <b>${name}</b>`; el.classList.add('show'); }
  else el.classList.remove('show');
}
function commitGazeFrame() {
  const f = gaze.current;
  if (f && f.dur >= HEAD_STAY_THRESH && (f.objW.size || f.envW.size)) { gaze.frames.push(f); if (gaze.frames.length > HEAD_MAX_FRAMES) gaze.frames.shift(); }
}
function frameJSON(f) {
  const rank = m => [...m.entries()].sort((a, b) => b[1] - a[1]);
  return {
    'Stay Duration': +f.dur.toFixed(2),
    'In Frustum Objects ID': rank(f.objW).map(([o, w]) => ({ Object: o.id, Weight: Math.max(1, Math.round(w)) })),
    'In Frustum Environment Objects ID': rank(f.envW).map(([e, w]) => ({ Object: e.name, Weight: Math.max(1, Math.round(w)) })),
  };
}
// Frames for the current round: committed frames + the in-progress one if it has dwelt a bit.
function headStayFrames() {
  const out = gaze.frames.map(frameJSON);
  const c = gaze.current;
  if (c && c.dur >= 0.5 && (c.objW.size || c.envW.size) && !gaze.frames.includes(c)) out.push(frameJSON(c));
  return out;
}
// We have no per-word timing (typed/voice-at-once), so tag the most-recent frame with the request.
function attachSpeakToFrames(frames, text) { if (frames.length) frames[frames.length - 1]['Speak words'] = text.replace(/\[<[^\]>]*>(?:start|end)?\]/g, ' ').replace(/\s+/g, ' ').trim(); }
function clearGaze() { gaze.frames = []; gaze.current = null; }

function executeLLMCall(fn, args) {
  switch (fn) {
    case 'CREATE': { const pf = prefab(args.id); if (!pf) return { ok: false, error: `Unknown prefab "${args.id}"` }; const sp = pf.wall ? wallSpawn() : spawnPos(); createObject(pf.name, sp.x, sp.z, pf.wall ? sp.angle : faceUserAngle(sp.x, sp.z)); return { ok: true }; }
    case 'MOVE': { const o = findObjectById(args.id); if (!o) return { ok: false, error: `No object "${args.id}"` }; const g = o.group; if (args.x !== undefined) g.position.x = args.x; if (args.z !== undefined) g.position.z = args.z; if (args.y !== undefined) g.position.y = args.y; settleInBounds(o, false); return { ok: true }; }
    case 'FORWARD': { const o = findObjectById(args.id); if (!o) return { ok: false, error: `No object "${args.id}"` }; o.group.rotation.set(0, Math.atan2(args.x ?? 0, args.z ?? 1), 0); settleInBounds(o, false); return { ok: true }; }
    case 'LOOKAT': { const o = findObjectById(args.id); if (!o) return { ok: false, error: `No object "${args.id}"` }; const dx = (args.x ?? o.group.position.x) - o.group.position.x, dz = (args.z ?? o.group.position.z) - o.group.position.z; if (dx || dz) o.group.rotation.set(0, Math.atan2(dx, dz), 0); settleInBounds(o, false); return { ok: true }; }
    case 'SCALE': { const o = findObjectById(args.id); if (!o) return { ok: false, error: `No object "${args.id}"` }; o.group.scale.set(args.x ?? 1, args.y ?? 1, args.z ?? 1); settleInBounds(o, false); return { ok: true }; }
    case 'DELETE': { const o = findObjectById(args.id); if (!o) return { ok: false, error: `No object "${args.id}"` }; removeObject(o); return { ok: true }; }
    case 'MESSAGE': toast(args.content ?? '', 'info'); return { ok: true };
    case 'EXPLAIN': return { ok: true };
    default: return { ok: false, error: `Unknown API "${fn}"` };
  }
}

// ============================================================
// Response panel (unchanged from v2)
// ============================================================
const respLog = $('resp-log');
let activeCard = null, recvContent = '', rowCounter = 0;
const BADGE_FN = new Set(['CREATE', 'MOVE', 'FORWARD', 'LOOKAT', 'SCALE', 'DELETE', 'MESSAGE', 'EXPLAIN']);
function startRespCard(n, requestText = '') {
  $('resp-placeholder')?.remove();
  const card = document.createElement('div'); card.className = 'resp-card';
  card.innerHTML = `<div class="resp-card-header"><span class="round-label">Round #${n}</span><span class="resp-card-time"></span></div>`
    + (requestText ? `<div class="resp-userreq"><span class="rr-tag">🗣 You</span><span class="rr-text"></span></div>` : '')
    + `<div class="recv-strip streaming" id="recv-${n}"></div><div class="call-rows" id="rows-${n}"></div><div class="resp-timing" id="timing-${n}"></div>`;
  if (requestText) card.querySelector('.rr-text').textContent = requestText;   // textContent → no HTML injection from user input
  respLog.appendChild(card); respLog.scrollTop = respLog.scrollHeight; recvContent = ''; activeCard = { n };
}
// Show only the API calls in the raw strip: drop ``` fences and any prose lines.
function cleanRecv(raw) {
  return raw.replace(/```[a-zA-Z]*/g, '')
    .split('\n').map(l => l.trim())
    .filter(l => /^[A-Z][A-Z0-9_]*\s*\(/.test(l))
    .join('\n');
}
function appendRecv(c) { if (!activeCard) return; recvContent += c; const el = $(`recv-${activeCard.n}`); if (el) { el.textContent = cleanRecv(recvContent); el.scrollTop = el.scrollHeight; } }
function splitArgs(raw) { const parts = []; let cur = '', q = false; for (const ch of raw ?? '') { if (ch === '"') { q = !q; cur += ch; continue; } if (ch === ',' && !q) { parts.push(cur); cur = ''; continue; } cur += ch; } parts.push(cur); return parts.map(s => s.trim().replace(/^"|"$/g, '')).filter(Boolean); }
function callRowEl(fn, rawArgs, status) {
  const row = document.createElement('div'); row.className = 'call-row';
  const st = document.createElement('span'); st.className = 'call-status ' + (status || 'pending'); st.textContent = status === 'ok' ? '✓' : status === 'err' ? '✗' : '…';
  const fnEl = document.createElement('span'); fnEl.className = 'call-fn'; const fb = document.createElement('span'); fb.className = `cbadge ${BADGE_FN.has(fn) ? 'cb-' + fn : 'cb-default'}`; fb.textContent = fn; fnEl.appendChild(fb);
  const argsEl = document.createElement('span'); argsEl.className = 'call-args'; argsEl.appendChild(Object.assign(document.createElement('span'), { className: 'call-paren', textContent: '( ' }));
  splitArgs(rawArgs).forEach((p, i, arr) => { const b = document.createElement('span'); b.className = 'cbadge cb-param'; b.textContent = p; b.title = p; argsEl.appendChild(b); if (i < arr.length - 1) argsEl.appendChild(Object.assign(document.createElement('span'), { className: 'call-paren', textContent: ' , ' })); });
  argsEl.appendChild(Object.assign(document.createElement('span'), { className: 'call-paren', textContent: ' )' }));
  row.append(st, fnEl, argsEl); return row;
}
function addCallRow(n, fn, rawArgs) { const rows = $(`rows-${n}`); if (!rows) return null; const row = callRowEl(fn, rawArgs, 'pending'); row.id = `crow-${++rowCounter}`; rows.appendChild(row); respLog.scrollTop = respLog.scrollHeight; return row.id; }
function setRowStatus(id, r) { const row = $(id); if (!row) return; const st = row.querySelector('.call-status'); st.classList.remove('pending'); st.classList.add(r.ok ? 'ok' : 'err'); st.textContent = r.ok ? '✓' : '✗'; if (!r.ok) { st.title = r.error || 'failed'; row.title = r.error || 'failed'; } }
function finaliseCard(report) { if (!activeCard) return; $(`recv-${activeCard.n}`)?.classList.remove('streaming'); if (report) { const t = $(`timing-${activeCard.n}`); if (t) t.innerHTML = `<span class="timing-badge">TTFT <span>${report.ttftMs ?? '–'} ms</span></span> <span class="timing-badge">total <span>${report.totalMs ?? '–'} ms</span></span>`; } activeCard = null; }

const editor = $('editor');
async function sendRound() {
  if (state.llmBusy) { toast('LLM is busy', 'info'); return; }
  const requestText = serializeEditor(); if (!requestText) { toast('Type a command first', 'info'); return; }
  if (!state.llm) { toast('API key not configured — open Settings', 'error'); openSettings(); return; }
  const cleanReq = requestText.replace(/\[<[^\]>]*>(?:start|end)?\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (state.round.empty) state.round.addText({ text: cleanReq });
  state.roundN++; const n = state.roundN; startRespCard(n, cleanReq);
  state.llmBusy = true; $('send-btn').disabled = true; setStatus('thinking', '🤔 processing…');
  const frames = headStayFrames();                                   // what the user was gazing at (cf. Unity head_stay_frames)
  if (frames.length) attachSpeakToFrames(frames, requestText);       // weave the spoken/typed words into the latest frame
  try {
    await state.llm.invokeChat(state.round, { sceneState: { player: playerState(), objects: sceneObjects(), headStayFrames: frames }, requestTextOverride: requestText, onChunk: appendRecv,
      onCall: (fn, args, rawArgs) => { const id = addCallRow(n, fn, rawArgs); const r = executeLLMCall(fn, args); setTimeout(() => setRowStatus(id, r), 150); },
      onDone: r => { finaliseCard(r); setStatus('idle', '● idle'); }, onError: err => { toast(err.message, 'error'); finaliseCard(null); setStatus('error', '⚠ error'); } });
  } finally { state.llmBusy = false; $('send-btn').disabled = false; resetRound(); clearGaze(); }
}
function setStatus(type, text) { const dot = $('status-dot'); dot.className = ''; if (type === 'active' || type === 'thinking') dot.classList.add('active'); $('status-text').textContent = text; }
function toast(msg, kind = 'info') { if (!msg) return; const t = document.createElement('div'); t.className = `toast toast-${kind}`; t.textContent = msg; $('toast-container').appendChild(t); setTimeout(() => { t.style.opacity = '0'; setTimeout(() => t.remove(), 300); }, 2200); }

function buildPalette() {
  const list = $('prefab-list'); list.innerHTML = '';
  for (const pf of CATALOG) {
    const item = document.createElement('div'); item.className = 'prefab-item'; item.title = `Add ${pf.name}`;
    const ic = pf.icon || (pf.prim ? SHAPE_ICON[pf.prim] : 'box');
    item.innerHTML = `<div class="prefab-icon" style="color:${pf.color};background:${pf.color}28;border-color:${pf.color}80">${ICONS[ic] ? iconSVG(ic, 18) : ''}</div><div class="prefab-info"><div class="prefab-name">${pf.name}${pf.user ? ' <span class="prefab-tag">custom</span>' : ''}</div><div class="prefab-dim">${pf.w}×${pf.h}×${pf.d} m</div></div>${pf.user ? `<button class="prefab-edit" title="Edit ${pf.name}">✎</button>` : ''}`;
    item.addEventListener('click', () => { const sp = pf.wall ? wallSpawn() : spawnPos(); createObject(pf.name, sp.x, sp.z, pf.wall ? sp.angle : faceUserAngle(sp.x, sp.z)); if (IS_TOUCH) document.documentElement.classList.remove('palette-open'); toast(`Added ${pf.name}${pf.wall ? ' on the wall' : ' in front of you'}`, 'success'); });
    item.querySelector('.prefab-edit')?.addEventListener('click', e => { e.stopPropagation(); openObjEditor(pf.name); });
    list.appendChild(item);
  }
  const add = document.createElement('button'); add.className = 'prefab-item prefab-add-item'; add.id = 'palette-add';
  add.innerHTML = `<div class="prefab-icon no-icon"><span>＋</span></div><div class="prefab-info"><div class="prefab-name">Add object</div><div class="prefab-dim">build one from a shape</div></div>`;
  add.addEventListener('click', () => openObjEditor(null));
  list.appendChild(add);
}
function catalogChanged() {
  saveUserCatalog();
  buildPalette();
  if (state.settings.apiKey) recreateLLM(state.settings);
}
function applyTheme(t) { document.documentElement.setAttribute('data-theme', t); localStorage.setItem('theme', t); $('theme-icon').textContent = t === 'dark' ? '☀️' : '🌙'; applySceneTheme(); }
const currentTheme = () => document.documentElement.getAttribute('data-theme') || localStorage.getItem('theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
function setupTheme() { applyTheme(currentTheme()); $('theme-toggle').addEventListener('click', () => applyTheme(currentTheme() === 'dark' ? 'light' : 'dark')); window.addEventListener('storage', e => { if (e.key === 'theme' && e.newValue) applyTheme(e.newValue); }); }

function clearScene() { clearSelection(); for (const o of [...state.objects]) removeObject(o); state.lastCreatedId = null; resetRound(); }
function seedScene() {
  const place = (n, x, z, a = 0) => createObject(n, x, z, a);
  place('Rug', 6.0, 6.2);
  place('TV Console', 6.0, 0.45, 0);          // media console against the north wall
  const tv = place('TV', 6.0, 0.45, 0);       // sits ON the console
  if (tv) tv.group.position.y = 0.45;
  place('Couch', 6.0, 8.4, Math.PI);          // faces -z toward the TV
  place('Table', 6.0, 6.2, 0);
  place('Chair', 3.4, 6.2, Math.PI / 2);      // faces +x (toward the other chair)
  place('Chair', 8.6, 6.2, -Math.PI / 2);
  place('Bookshelf', 11.6, 2.6, -Math.PI / 2);
  place('Plant', 11.0, 9.2);
  place('Lamp', 1.2, 1.5);
}
const EXAMPLE_FOLLOWUP = 'Turn the two chairs to face the couch, and lift the TV onto a wall mount at y = 1.2.';
const EXAMPLE_CALLS = [
  ['CREATE', '"TV"'], ['MOVE', '"crt", x=6.00, z=0.55'],
  ['CREATE', '"Rug"'], ['MOVE', '"crt", x=6.00, z=6.20'],
  ['CREATE', '"Couch"'], ['MOVE', '"crt", x=6.00, z=8.40'], ['LOOKAT', '"crt", x=6.00, y=0.38, z=0.55'],
  ['CREATE', '"Table"'], ['MOVE', '"crt", x=6.00, z=6.20'],
  ['CREATE', '"Chair"'], ['MOVE', '"crt", x=3.40, z=6.20'], ['LOOKAT', '"crt", x=8.60, y=0.47, z=6.20'],
  ['CREATE', '"Chair"'], ['MOVE', '"crt", x=8.60, z=6.20'], ['LOOKAT', '"crt", x=3.40, y=0.47, z=6.20'],
  ['CREATE', '"Bookshelf"'], ['MOVE', '"crt", x=11.60, z=2.60'], ['FORWARD', '"crt", x=-1.00, y=0.00, z=0.00'],
  ['CREATE', '"Plant"'], ['MOVE', '"crt", x=11.00, z=9.20'], ['CREATE', '"Lamp"'], ['MOVE', '"crt", x=1.20, z=1.50'],
];
function seedExampleResponse() {
  respLog.innerHTML = '';
  const card = document.createElement('div'); card.className = 'resp-card';
  card.innerHTML = `<div class="resp-card-header"><span class="round-label">Example round</span><span class="resp-card-time">how the scene was built</span></div><div class="resp-userreq"><span class="rr-tag">🗣 You</span><span>Set up a cozy living room — a couch facing a TV, a coffee table with two chairs, plus a bookshelf, plant and lamp.</span></div><div class="recv-strip"></div><div class="call-rows"></div><div class="resp-timing">${EXAMPLE_CALLS.length} API calls · example output (3D, with y) — send the pre-filled command to continue live.</div>`;
  card.querySelector('.recv-strip').textContent = EXAMPLE_CALLS.map(([f, a]) => `${f}(${a});`).join('\n');
  const rows = card.querySelector('.call-rows'); for (const [f, a] of EXAMPLE_CALLS) rows.appendChild(callRowEl(f, a, 'ok'));
  respLog.appendChild(card);
}
function loadExampleEverything() { clearScene(); seedScene(); seedExampleResponse(); editor.textContent = EXAMPLE_FOLLOWUP; }

// ============================================================
// Add-object editor — users build custom objects from a primitive base
// shape (cube / sphere / cylinder / cone) + name, size and colour.
// Mirrors the 2D demo's object editor; persisted to localStorage and
// fed to the LLM as extra prefabs. (cf. demo.js setupObjEditor)
// ============================================================
const NAME_MAX = 20, DESC_MAX = 120;
let editingName = null, editorShape = 'box';
let oePrev = null;   // { renderer, scene, camera, mesh, raf }

function openObjEditor(name) {
  editingName = name;
  const pf = name ? prefab(name) : null;
  $('oe-title').textContent = pf ? `Edit "${pf.name}"` : 'Add object';
  $('oe-name').value = pf?.name ?? '';
  $('oe-desc').value = pf?.desc ?? '';
  $('oe-w').value = pf?.w ?? 0.5;
  $('oe-h').value = pf?.h ?? 0.5;
  $('oe-d').value = pf?.d ?? 0.5;
  $('oe-color').value = pf?.color ?? '#58a6ff';
  editorShape = pf?.prim ?? 'box';
  buildShapePicker();
  updateCounters();
  const delBtn = $('oe-delete');
  const inUse = pf && state.objects.some(o => o.prefabId === pf.name);
  delBtn.style.display = pf ? '' : 'none';
  delBtn.disabled = !!inUse;
  delBtn.title = inUse ? 'Remove all instances from the scene first' : 'Delete this object type';
  $('editor-overlay').classList.add('open');
  ensurePreview();
  drawObjPreview();
}
function closeObjEditor() { $('editor-overlay').classList.remove('open'); stopPreview(); }

function buildShapePicker() {
  const grid = $('oe-shapes'); grid.innerHTML = '';
  for (const s of SHAPES) {
    const b = document.createElement('button'); b.type = 'button';
    b.className = 'oe-icon-btn' + (editorShape === s.prim ? ' active' : '');
    b.innerHTML = `${iconSVG(SHAPE_ICON[s.prim], 18)}<span>${s.label}</span>`;
    b.title = s.label;
    b.addEventListener('click', () => { editorShape = s.prim; buildShapePicker(); drawObjPreview(); });
    grid.appendChild(b);
  }
}
function updateCounters() {
  $('oe-name-count').textContent = `${$('oe-name').value.length}/${NAME_MAX}`;
  $('oe-desc-count').textContent = `${$('oe-desc').value.length}/${DESC_MAX}`;
}
function currentEditorPrefab() {
  return { prim: editorShape, color: $('oe-color').value,
    w: Math.max(0.05, Math.min(5, parseFloat($('oe-w').value) || 0.5)),
    h: Math.max(0.05, Math.min(5, parseFloat($('oe-h').value) || 0.5)),
    d: Math.max(0.05, Math.min(5, parseFloat($('oe-d').value) || 0.5)) };
}
// Live, spinning 3D preview built with the same primitiveMesh() as the scene.
function ensurePreview() {
  if (oePrev) return;
  const cv = $('oe-preview');
  const renderer = new THREE.WebGLRenderer({ canvas: cv, antialias: true, alpha: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setSize(cv.clientWidth || 240, cv.clientHeight || 200, false);
  const scene = new THREE.Scene();
  scene.add(new THREE.HemisphereLight(0xffffff, 0x33373d, 1.0));
  const dir = new THREE.DirectionalLight(0xffffff, 1.0); dir.position.set(2, 4, 3); scene.add(dir);
  const camera = new THREE.PerspectiveCamera(45, (cv.clientWidth || 240) / (cv.clientHeight || 200), 0.01, 100);
  oePrev = { renderer, scene, camera, mesh: null, raf: 0 };
}
function drawObjPreview() {
  if (!oePrev) return;
  if (oePrev.mesh) { oePrev.scene.remove(oePrev.mesh); }
  const pf = currentEditorPrefab();
  const g = primitiveMesh({ ...pf, name: 'preview' });   // group with mesh sitting on y=0
  oePrev.mesh = g; oePrev.scene.add(g);
  const r = Math.max(pf.w, pf.h, pf.d);
  oePrev.camera.position.set(r * 1.6, pf.h * 0.7 + r * 0.9, r * 2.2);
  oePrev.camera.lookAt(0, pf.h / 2, 0);
  startPreview();
}
function startPreview() {
  if (!oePrev || oePrev.raf) return;
  const loop = () => {
    if (!$('editor-overlay').classList.contains('open')) { oePrev.raf = 0; return; }
    if (oePrev.mesh) oePrev.mesh.rotation.y += 0.012;
    oePrev.renderer.render(oePrev.scene, oePrev.camera);
    oePrev.raf = requestAnimationFrame(loop);
  };
  oePrev.raf = requestAnimationFrame(loop);
}
function stopPreview() { if (oePrev?.raf) { cancelAnimationFrame(oePrev.raf); oePrev.raf = 0; } }

function setupObjEditor() {
  ['oe-name', 'oe-desc'].forEach(id => $(id).addEventListener('input', updateCounters));
  ['oe-w', 'oe-h', 'oe-d', 'oe-color'].forEach(id => $(id).addEventListener('input', drawObjPreview));
  $('oe-cancel').addEventListener('click', closeObjEditor);
  $('editor-overlay').addEventListener('click', e => { if (e.target === $('editor-overlay')) closeObjEditor(); });
  $('oe-save').addEventListener('click', () => {
    const name = $('oe-name').value.trim().slice(0, NAME_MAX);
    const desc = $('oe-desc').value.trim().slice(0, DESC_MAX);
    if (!name) { toast('Name is required', 'error'); return; }
    const p = currentEditorPrefab();
    const clash = CATALOG.find(x => x.name === name && x.name !== editingName);
    if (clash) { toast(`An object named "${name}" already exists`, 'error'); return; }
    if (editingName) {
      const pf = prefab(editingName); if (!pf || !pf.user) { toast('Only custom objects can be edited', 'error'); return; }
      const oldName = pf.name;
      Object.assign(pf, { name, desc, prim: p.prim, w: p.w, h: p.h, d: p.d, color: p.color });
      // Rebuild any live instances in place so they reflect the new shape/size.
      const live = state.objects.filter(o => o.prefabId === oldName)
        .map(o => ({ x: o.group.position.x, y: o.group.position.y, z: o.group.position.z, ry: o.group.rotation.y }));
      for (const o of [...state.objects]) if (o.prefabId === oldName) removeObject(o);
      for (const t of live) { const o = createObject(name, t.x, t.z, t.ry); if (o) o.group.position.y = t.y; }
    } else {
      CATALOG.push({ name, desc, remarks: `User-created ${p.prim} primitive. Bottom-centre anchor; no inherent front — orient with FORWARD only if the user specifies a direction.`, prim: p.prim, w: p.w, h: p.h, d: p.d, color: p.color, icon: SHAPE_ICON[p.prim], user: true });
    }
    closeObjEditor();
    catalogChanged();
    toast(editingName ? `Updated "${name}"` : `Added "${name}" to the catalog`, 'success');
  });
  $('oe-delete').addEventListener('click', () => {
    if (!editingName) return;
    if (state.objects.some(o => o.prefabId === editingName)) { toast('Remove all instances from the scene first', 'error'); return; }
    if (!confirm(`Delete object type "${editingName}" from the catalog?`)) return;
    CATALOG = CATALOG.filter(p => p.name !== editingName);
    closeObjEditor();
    catalogChanged();
    toast('Object type deleted', 'info');
  });
}

// ============================================================
// Welcome modal + step-by-step guided tour
// ============================================================
const SEEN_KEY = 'vrmover3d_seen_intro';
let tour = null;
function tourFocusObject(prefabId) {
  const o = state.objects.find(x => x.prefabId === prefabId) ?? state.objects[0] ?? null;
  clearSelection(); if (o) addSelect(o);
  return o;
}
function tourSteps() {
  const isTouch = matchMedia('(pointer: coarse)').matches;
  return [
    { target: ['#s-baseurl', '#s-apikey'], title: '1 · Set your API key',
      body: 'This demo calls an <strong>OpenAI-compatible</strong> LLM straight from your browser. Open the ' +
            '<strong>🔑 quick-start</strong> to pick a provider (some have a <strong>free tier</strong>) — it autofills ' +
            'the endpoint and links you to create a key. Paste it and press <strong>Save</strong>. It stays in your browser only.',
      before: () => { openSettings(); $('quickstart')?.classList.add('open'); },
      advanceOn: { event: 'vrmover:settings-saved', target: document } },
    { target: '#three-viewport', title: '2 · Walk around the room',
      body: isTouch
        ? 'You are standing <strong>inside</strong> the room. Use the <strong>left joystick</strong> to walk and ' +
          '<strong>drag anywhere</strong> to look around. Take a moment to get your bearings.'
        : 'You are standing <strong>inside</strong> the room. <strong>W A S D</strong> walks (while the mouse is over the room), ' +
          '<strong>right-drag</strong> looks around, and the <strong>scroll wheel</strong> steps you forward and back. ' +
          'The cursor stays free, so every panel is always clickable.',
      before: () => closeSettings() },
    { target: '#palette', title: '3 · Add objects',
      body: 'Click any object to drop it <strong>in front of you</strong>. Scroll to the bottom and hit ' +
            '<strong>＋ Add object</strong> to build your own from a cube, sphere, cylinder or cone — your custom ' +
            'objects become part of the LLM’s catalog instantly.',
      before: () => document.documentElement.classList.add('palette-open') },   // open the drawer so it's visible to spotlight
    { target: '#three-viewport', title: '4 · Select an object',
      body: (isTouch ? '<strong>Tap</strong>' : '<strong>Click</strong>') + ' an object to <strong>select</strong> it — ' +
            'a bright outline marks it (handy as the delete target). ' + (isTouch ? 'Tap' : 'Click') +
            ' empty floor or press <kbd>Esc</kbd> to deselect.',
      before: () => { document.documentElement.classList.remove('palette-open'); tourFocusObject('Couch'); } },   // close the drawer, back to the viewport
    { target: '#three-viewport', title: '5 · Move, rotate & scale',
      body: (isTouch ? '<strong>Hover/point at</strong>' : '<strong>Hover</strong>') + ' an object to reveal its ' +
            '<strong>gizmo</strong>, centred on it. Then drag a coloured <strong>arrow</strong> to move along that axis, ' +
            'a <strong>ring</strong> to rotate, an axis <strong>cube</strong> to stretch that side, or the ' +
            '<strong>white centre cube</strong> to scale uniformly. Objects always stay inside the room. ' +
            '<kbd>Del</kbd> removes the selected one.',
      before: () => tourFocusObject('Couch') },
    { target: '#three-viewport', title: '6 · Point while you talk',
      body: isTouch
        ? 'Switch the top-right mode to <strong>—</strong> or <strong>▭</strong>, then drag the floor to drop a ' +
          '<span class="ibadge ibadge-h">here</span> point, a line or an area. Each drops a token into your command.'
        : '<strong>Left-click</strong> the floor → <span class="ibadge ibadge-h">here</span> · ' +
          '<strong>left-drag</strong> → a line · <strong>Shift+left-drag</strong> → an area. ' +
          'Each gesture drops a token the LLM reads alongside your words.' },
    { target: '#editor', title: '7 · Send a command',
      body: 'Type what you want — e.g. <em>“bring the chair next to me and turn the TV toward the couch”</em> — then ' +
            'press <strong>Send</strong>. The LLM streams back 3D API calls (x / y / z) that rearrange the room live.',
      before: () => { editor.textContent = 'Move the couch closer to the TV and put a lamp in the empty corner'; } },
    { target: '#resp-panel', title: '8 · Watch the LLM work',
      body: 'Each round streams the raw tokens, then one row per recognised API call — ' +
            '<strong style="color:#3fb950">✓</strong> executed, <strong style="color:#f85149">✗</strong> failed — ' +
            'plus timing. That’s the whole loop. Have fun rearranging the room!',
      before: () => { if (matchMedia('(max-width: 960px)').matches) $('mtab-resp')?.click(); } },
  ];
}
function startTour() {
  tour?.end();
  tour = new Tour(tourSteps(), { onEnd: () => { closeSettings(); if (matchMedia('(max-width: 960px)').matches) $('mtab-scene')?.click(); } });
  tour.start();
}
function openWelcome() { $('welcome-overlay').classList.add('open'); }
function closeWelcome() { $('welcome-overlay').classList.remove('open'); localStorage.setItem(SEEN_KEY, '1'); }
function setupWelcome() {
  $('welcome-tour')?.addEventListener('click', () => { closeWelcome(); startTour(); });
  $('welcome-skip')?.addEventListener('click', closeWelcome);
  $('btn-help')?.addEventListener('click', openWelcome);
  if (!localStorage.getItem(SEEN_KEY)) openWelcome();
}

// ============================================================
// Voice input — shared module (demo-shared.js) over the vr-mover.js engine.
// ============================================================
const voice = createVoiceInput({
  SpeechController,
  editor,
  sttBtn: $('stt-btn'),
  getLang: () => state.settings.lang ?? 'en-US',
  getConfirmDelay: () => state.confirmDelay,
  serialize: serializeEditor,
  canSend: () => !state.llmBusy,
  send: sendRound,
  addRoundText: (t) => state.round.addText(t),
  setStatus, toast,
  proposalStatusType: 'thinking',
});

async function init() {
  state.settings = loadSettings();
  setupTheme(); buildPalette(); setupSettings(); setupThree(); setupTouch(); setupObjEditor(); setupWelcome(); setupEditorSync(); setupFullscreen(); voice.setupVoice();
  $('tool-reset').addEventListener('click', resetView);
  $('tool-delete').addEventListener('click', deleteSelectionOrHovered);
  $('clear-scene').addEventListener('click', () => { clearScene(); toast('Scene cleared', 'info'); });
  $('load-example').addEventListener('click', () => { loadExampleEverything(); toast('Loaded the example room', 'success'); });
  $('send-btn').addEventListener('click', sendRound);
  $('clear-input')?.addEventListener('click', () => { if (voice.isActive()) voice.stopSTT(); resetRound(); voice.clearInterim(); clearGaze(); setStatus('idle', '● idle'); });
  editor.addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendRound(); } });
  $('resp-clear').addEventListener('click', () => { respLog.innerHTML = ''; });
  $('instructions-toggle').addEventListener('click', () => $('instructions').classList.toggle('open'));
  $('btn-menu')?.addEventListener('click', e => { e.stopPropagation(); const open = $('header-actions').classList.toggle('open'); $('btn-menu').setAttribute('aria-expanded', String(open)); });
  document.addEventListener('click', e => { const ha = $('header-actions'); if (ha?.classList.contains('open') && !ha.contains(e.target) && e.target !== $('btn-menu')) { ha.classList.remove('open'); $('btn-menu')?.setAttribute('aria-expanded', 'false'); } });
  $('palette-toggle')?.addEventListener('click', () => document.documentElement.classList.toggle('palette-open'));
  $('mtab-scene')?.addEventListener('click', () => { $('resp-panel').classList.remove('open'); $('mtab-scene').classList.add('active'); $('mtab-resp').classList.remove('active'); });
  $('mtab-resp')?.addEventListener('click', () => { $('resp-panel').classList.add('open'); $('mtab-resp').classList.add('active'); $('mtab-scene').classList.remove('active'); });
  await loadFewshot3D();
  if (state.settings.apiKey) recreateLLM(state.settings);
  await preloadModels();
  loadExampleEverything();
  setStatus('idle', '● idle');
  console.log('[VR Mover 3D] Initialised (free-cursor FPS)');
}
init();
