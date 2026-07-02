/**
 * vr-mover.js
 *
 * A self-contained JavaScript port of the critical VR Mover pipeline from the
 * Unity C# project "ObjectManipulationLLM".  It reproduces the same data-flow
 * that runs in the headset but works in any modern browser or Node environment:
 *
 *   speech → OperatingRound → LLMCore (streaming SSE) → StreamingAPIExtractor
 *           → per-call callbacks (CREATE / MOVE / … )
 *
 * Source files this was ported from:
 *   Assets/LLM/Scripts/LLMCore.cs
 *   Assets/LLM/Scripts/ContextManager.cs
 *   Assets/Scripts/StringAPIExtractorStreaming.cs
 *   Assets/Scripts/SpeechManager.cs
 *   Assets/Scripts/TimingCore.cs
 *   Assets/Scripts/VoiceCommandCore.cs (ProcessString helper)
 *
 * All classes are exported as named ES-module exports so they can be used with
 * `import { LLMCore, ContextManager, … } from './vr-mover.js'`.
 *
 * @module vr-mover
 */

// ---------------------------------------------------------------------------
// TimingCore
// ---------------------------------------------------------------------------

/**
 * Monotonic clock anchored to the moment this module was first imported.
 * Mirrors `TimingCore.cs` (STOPWATCH method) via `performance.now()`.
 *
 * All values are relative to the anchor point, not to the Unix epoch.
 */
export class TimingCore {
  /** @type {number} performance.now() at construction time */
  #origin;

  constructor() {
    this.#origin = performance.now();
  }

  /**
   * Elapsed milliseconds since construction (floating-point, sub-ms resolution).
   * @returns {number}
   */
  nowMs() {
    return performance.now() - this.#origin;
  }

  /**
   * Elapsed seconds since construction.
   * @returns {number}
   */
  nowSec() {
    return this.nowMs() / 1000;
  }

  /**
   * Elapsed time in 100-nanosecond ticks (matches C# `TimeSinceStart100Nanoseconds`).
   * @returns {bigint}
   */
  now100ns() {
    return BigInt(Math.round(this.nowMs() * 1e4));
  }

  /**
   * Current wall-clock `Date` computed from the anchor + elapsed time.
   * @returns {Date}
   */
  get now() {
    return new Date(Date.now());
  }
}

// Singleton shared across the library (mirrors Unity's singleton pattern)
export const timing = new TimingCore();

// ---------------------------------------------------------------------------
// ContextManager
// ---------------------------------------------------------------------------

/**
 * Manages the rolling conversation context sent to the LLM.
 *
 * Mirrors `ContextManager.cs`:
 * - The system prompt is always the first message and is never rolled off.
 * - An optional (userFewshot, assistantFewshot) pair is pinned after the
 *   system prompt to provide stable few-shot examples.
 * - Subsequent user/assistant exchanges are kept as pairs; only the most-recent
 *   `maxLen` pairs are included in `messages()`.
 */
export class ContextManager {
  /** @type {{role:string, content:string}} */
  #systemMsg;
  /** @type {{role:string, content:string}|null} */
  #firstUser;
  /** @type {{role:string, content:string}|null} */
  #firstAssistant;
  /** @type {Array<{user:{role:string,content:string}|null, assistant:{role:string,content:string}|null}>} */
  #pairs;
  /** @type {number} */
  #maxLen;
  /** @type {boolean} */
  #dirty;
  /** @type {Array<{role:string,content:string}>} */
  #cache;

  /**
   * @param {string} systemPrompt  - System message content
   * @param {number} maxLen        - Max number of user/assistant pairs to keep
   *                                 (excluding pinned few-shot pair)
   * @param {string|null} [userFewshot]      - Pinned user few-shot example
   * @param {string|null} [assistantFewshot] - Pinned assistant few-shot example
   */
  constructor(systemPrompt, maxLen = 5, userFewshot = null, assistantFewshot = null) {
    this.#systemMsg = { role: 'system', content: systemPrompt };
    this.#maxLen = maxLen;
    this.#pairs = [];
    this.#dirty = true;
    this.#cache = [];

    if (userFewshot && assistantFewshot) {
      this.#firstUser = { role: 'user', content: userFewshot };
      this.#firstAssistant = { role: 'assistant', content: assistantFewshot };
    } else {
      this.#firstUser = null;
      this.#firstAssistant = null;
    }
  }

  /**
   * Append a user turn.  Creates a new pair slot with no assistant reply yet.
   * @param {string} prompt
   */
  insertUser(prompt) {
    this.#pairs.push({ user: { role: 'user', content: prompt }, assistant: null });
    this.#dirty = true;
  }

  /**
   * Fill (or append to) the assistant side of the latest pair.
   * @param {string}  prompt
   * @param {boolean} [append=false] - If true, concatenate to the existing
   *                                   assistant content (mirrors the streaming
   *                                   accumulation path in LLMCore.cs).
   */
  insertAssistant(prompt, append = false) {
    if (this.#pairs.length === 0) return;
    const last = this.#pairs[this.#pairs.length - 1];
    if (last.assistant === null || !append) {
      last.assistant = { role: 'assistant', content: prompt };
    } else {
      last.assistant = { role: 'assistant', content: last.assistant.content + '\n' + prompt };
    }
    this.#dirty = true;
  }

  /**
   * Returns the message array to send to the LLM.
   *
   * Structure (mirrors `ContextManager.cs → PromptsContext`):
   *   [system, ?userFewshot, ?assistantFewshot, ...last-N pairs]
   *
   * @returns {Array<{role:string, content:string}>}
   */
  messages() {
    if (!this.#dirty) return this.#cache;

    const out = [this.#systemMsg];
    if (this.#firstUser && this.#firstAssistant) {
      out.push(this.#firstUser, this.#firstAssistant);
    }

    const start = Math.max(0, this.#pairs.length - this.#maxLen);
    for (let i = start; i < this.#pairs.length; i++) {
      const p = this.#pairs[i];
      if (!p.user) continue;
      out.push(p.user);
      if (p.assistant) out.push(p.assistant);
    }

    this.#cache = out;
    this.#dirty = false;
    return out;
  }

  /**
   * Full conversation log (all pairs, not rolling-windowed).
   * Useful for logging and saving.
   * @returns {Array<{role:string, content:string}>}
   */
  fullLog() {
    const out = [this.#systemMsg];
    if (this.#firstUser) out.push(this.#firstUser);
    if (this.#firstAssistant) out.push(this.#firstAssistant);
    for (const p of this.#pairs) {
      if (p.user) out.push(p.user);
      if (p.assistant) out.push(p.assistant);
    }
    return out;
  }

  /** Number of user/assistant pairs accumulated so far. */
  get pairCount() {
    return this.#pairs.length;
  }
}

// ---------------------------------------------------------------------------
// StreamingAPIExtractor
// ---------------------------------------------------------------------------

/**
 * Incrementally parses API-call tokens streamed from the LLM.
 *
 * Ports `StringAPIExtractorStreaming.cs`.
 *
 * The LLM is instructed to reply only with `FUNCTION(args);` lines.  Because
 * the response arrives in small SSE chunks, a call may be split across several
 * chunks.  This class accumulates chunks and emits complete calls as soon as a
 * closing `);` is seen.
 *
 * Pattern (same as C# source): `\b(\w+)\s*\(([^)]*)\);`
 *
 * @example
 * const ex = new StreamingAPIExtractor();
 * ex.receiveChunk('CRE');          // → { calls: [] }
 * ex.receiveChunk('ATE("Chair");'); // → { calls: [['CREATE', '"Chair"']] }
 */
export class StreamingAPIExtractor {
  /** @type {string} Full accumulated text (never cleared — for logging) */
  #recorded = '';
  /** @type {string} Pending unparsed text (cleared up to last complete call) */
  #pending = '';
  /**
   * Per-instance regex: a `g`-flag regex carries `lastIndex` state, so it must
   * never be shared between instances (a static would leak scan position when
   * two extractors interleave).
   * @type {RegExp}
   */
  #pattern = /\b(\w+)\s*\(([^)]*)\);/g;

  /**
   * Feed the next SSE chunk.
   * @param {string} chunk
   * @returns {{ calls: Array<[string, string]> }}
   *   `calls` is an array of `[functionName, rawArgsString]` pairs for every
   *   complete API call that was completed by this chunk.
   */
  receiveChunk(chunk) {
    this.#recorded += chunk;
    this.#pending += chunk;

    const calls = [];
    let lastIndex = 0;

    // Reset lastIndex so each call to receiveChunk scans from the start of pending
    this.#pattern.lastIndex = 0;

    let match;
    while ((match = this.#pattern.exec(this.#pending)) !== null) {
      calls.push([match[1], match[2]]);
      lastIndex = match.index + match[0].length;
    }

    if (lastIndex > 0) {
      this.#pending = this.#pending.slice(lastIndex);
    }

    return { calls };
  }

  /** Reset pending buffer and full record (call between rounds). */
  reset() {
    this.#recorded = '';
    this.#pending = '';
  }

  /**
   * Full text received since last reset (for logging/context insertion).
   * @returns {string}
   */
  fullRecord() {
    return this.#recorded;
  }
}

// ---------------------------------------------------------------------------
// Argument parser for API calls
// ---------------------------------------------------------------------------

/**
 * Parse the raw argument string from a streamed API call into a structured object.
 *
 * Handles the formats the LLM uses:
 *   - Positional:   `"Chair"`  or  `"id", 1.5, 1.5, 1.5`
 *   - Named:        `"crt", x=10, y=0, z=3`  or  `"crt", x=1`
 *   - Unquoted id:  `crt, x=1`  (some models drop the quotes — tolerated)
 *
 * Every manipulation API takes the object id as its first argument, so the
 * first comma-separated token (quoted or not, as long as it is not `k=v`) is
 * mapped to `id`.
 *
 * @param {string} raw - Raw argument string from extractor, e.g. `"crt", x=10, y=0, z=3`
 * @returns {Object}
 */
export function parseArgs(raw) {
  const result = {};
  if (!raw || !raw.trim()) return result;

  let rest = raw.trim();

  // Extract leading id token: a quoted string, or a bare token before the
  // first comma (provided it is not a named `k=v` argument).
  const quoted = rest.match(/^"([^"]*)"\s*(?:,\s*)?/);
  if (quoted) {
    result.id = quoted[1];
    rest = rest.slice(quoted[0].length);
  } else {
    const comma = rest.indexOf(',');
    const first = (comma === -1 ? rest : rest.slice(0, comma)).trim();
    if (first && !first.includes('=')) {
      result.id = first.replace(/^['"]+|['"]+$/g, '');
      rest = comma === -1 ? '' : rest.slice(comma + 1);
    }
  }

  if (!rest.trim()) return result;

  // Named args:  x=1.5, y=0, z=-3
  const namedPattern = /(\w+)\s*=\s*(-?\d*\.?\d+)/g;
  let namedMatch;
  let hasNamed = false;
  while ((namedMatch = namedPattern.exec(rest)) !== null) {
    result[namedMatch[1]] = parseFloat(namedMatch[2]);
    hasNamed = true;
  }

  if (!hasNamed) {
    // Positional floats:  1.5, 1.5, 1.5
    const positional = ['x', 'y', 'z', 'w'];
    const nums = rest.match(/-?\d*\.?\d+/g) || [];
    nums.forEach((n, i) => {
      if (i < positional.length) result[positional[i]] = parseFloat(n);
    });
  }

  return result;
}

/**
 * Named API call handlers.
 *
 * Each entry documents the expected argument shape.  Callers pass the raw
 * arg string from `StreamingAPIExtractor`; these helpers parse it and return
 * a normalised object.
 *
 * Usage:
 * ```js
 * const { calls } = extractor.receiveChunk(chunk);
 * for (const [fn, raw] of calls) {
 *   const args = Apis[fn]?.(raw) ?? parseArgs(raw);
 * }
 * ```
 */
export const Apis = {
  /**
   * CREATE("prefab_id")
   * @param {string} raw
   * @returns {{ id: string }}
   */
  CREATE(raw) {
    const m = raw.match(/"([^"]*)"/);
    return { id: m ? m[1] : raw.trim() };
  },

  /**
   * MOVE("object_id", x?, y?, z?)  or  MOVE("object_id", float?, float?, float?)
   * @param {string} raw
   * @returns {{ id: string, x?: number, y?: number, z?: number }}
   */
  MOVE: parseArgs,

  /**
   * FORWARD("object_id", x?, y?, z?)
   * @param {string} raw
   * @returns {{ id: string, x?: number, y?: number, z?: number }}
   */
  FORWARD: parseArgs,

  /**
   * LOOKAT("object_id", x?, y?, z?)
   * @param {string} raw
   * @returns {{ id: string, x?: number, y?: number, z?: number }}
   */
  LOOKAT: parseArgs,

  /**
   * SCALE("object_id", x?, y?, z?)
   * @param {string} raw
   * @returns {{ id: string, x?: number, y?: number, z?: number }}
   */
  SCALE: parseArgs,

  /**
   * DELETE("object_id")
   * @param {string} raw
   * @returns {{ id: string }}
   */
  DELETE(raw) {
    const m = raw.match(/"([^"]*)"/);
    return { id: m ? m[1] : raw.trim() };
  },

  /**
   * MESSAGE("content")
   * @param {string} raw
   * @returns {{ content: string }}
   */
  MESSAGE(raw) {
    const m = raw.match(/"((?:[^"\\]|\\.)*)"/);
    return { content: m ? m[1] : raw.trim() };
  },

  /**
   * EXPLAIN("reason")  — debug mode only
   * @param {string} raw
   * @returns {{ reason: string }}
   */
  EXPLAIN(raw) {
    const m = raw.match(/"((?:[^"\\]|\\.)*)"/);
    return { reason: m ? m[1] : raw.trim() };
  },
};

// ---------------------------------------------------------------------------
// OperatingRound
// ---------------------------------------------------------------------------

/**
 * Represents one complete user interaction round — the unit passed to the LLM.
 *
 * Mirrors `OperatingRound` in `SpeechManager.cs` and `ManipulatableCore.cs`.
 *
 * A round accumulates:
 *   - One or more speech recognition results (`addText`)
 *   - Zero or more spatial hit-points (`addHit`)  — alt-click in the 2D demo
 *   - Zero or more drawing lines (`addDrawing`)   — shift-drag in the 2D demo
 *
 * `serialize()` produces a JSON string matching the `RequestMessageBody` schema
 * consumed by the LLM's system prompt.
 */
export class OperatingRound {
  /** @type {Array<{text:string, startMs:number, endMs:number}>} */
  #texts = [];
  /** @type {Array<{id:string, object:string|null, position:{x:number,y:number,z:number}, normal:{x:number,y:number,z:number}, timeMs:number}>} */
  #hits = [];
  /** @type {Array<{id:string, startMs:number, durationMs:number, points:Array<{x:number,z:number}>}>} */
  #drawings = [];
  /** @type {number} */
  #hitCounter = 0;
  /** @type {number} */
  #drawCounter = 0;

  /** Whether this round has any speech text. */
  get empty() {
    return this.#texts.length === 0;
  }

  /** The concatenated spoken text across all recognition results. */
  get confirmedText() {
    return this.#texts.map(t => t.text).join(' ').trim();
  }

  /**
   * Add a speech recognition result.
   * @param {{ text: string, startMs?: number, endMs?: number }} result
   */
  addText(result) {
    this.#texts.push({
      text: result.text,
      startMs: result.startMs ?? timing.nowMs(),
      endMs: result.endMs ?? timing.nowMs(),
    });
  }

  /**
   * Add a spatial hit-point (e.g. user clicked a position on the canvas).
   * @param {{ object?: string|null, position: {x:number, z:number, y?:number},
   *            normal?: {x?:number, y?:number, z?:number}, timeMs?: number }} hit
   *   Supports both 2D (x,z) and 3D (x,y,z) hit data.
   *   `timeMs` defaults to "now"; pass it explicitly when replaying recorded
   *   input or in tests.
   * @returns {string} The generated hit ID (e.g. "h-1")
   */
  addHit(hit) {
    const id = `h-${++this.#hitCounter}`;
    this.#hits.push({
      id,
      object: hit.object ?? null,
      position: hit.position,
      normal: hit.normal ?? null,
      timeMs: hit.timeMs ?? timing.nowMs(),
    });
    return id;
  }

  /**
   * Withdraw a previously added hit-point (mirrors `WithDrawHitPoint`).
   * @param {string} id
   */
  removeHit(id) {
    const idx = this.#hits.findIndex(h => h.id === id);
    if (idx !== -1) this.#hits.splice(idx, 1);
  }

  /**
   * Withdraw a previously added drawing (parallel of `removeHit`).
   * @param {string} id
   */
  removeDrawing(id) {
    const idx = this.#drawings.findIndex(d => d.id === id);
    if (idx !== -1) this.#drawings.splice(idx, 1);
  }

  /**
   * Add a drawing line (e.g. user shift-dragged on the canvas).
   * @param {{ points: Array<{x:number,z:number}>, durationMs?: number,
   *            startMs?: number }} drawing
   *   `startMs` defaults to "now"; pass it explicitly for replay or tests.
   * @returns {string} The generated line ID (e.g. "l-1")
   */
  addDrawing(drawing) {
    const id = `l-${++this.#drawCounter}`;
    this.#drawings.push({
      id,
      startMs: drawing.startMs ?? timing.nowMs(),
      durationMs: drawing.durationMs ?? 0,
      points: drawing.points,
    });
    return id;
  }

  /**
   * Produce the `user_request_with_actions_inserted` string by interleaving
   * hit / drawing markers at the appropriate positions in the transcribed text.
   *
   * Best-effort: if word-level timing is available on the recognition results,
   * markers are inserted at the closest word boundary; otherwise they are
   * appended at the end (Web Speech API does not expose reliable word offsets).
   *
   * Mirrors `ManipulatableCore.cs → InsertActionIntoPrompt`.
   *
   * @returns {{ userRequest: string, userRequestWithActions: string }}
   */
  buildRequestText() {
    // Flatten all speech segments into a single word list, estimating each
    // word's end-time by linear interpolation over its segment's duration
    // (Web Speech does not expose per-word offsets, so this is best-effort).
    const words = [];
    for (const t of this.#texts) {
      const ws = t.text.split(/\s+/).filter(Boolean);
      const dur = Math.max(t.endMs - t.startMs, 1);
      ws.forEach((w, i) => {
        words.push({ word: w, endTime: t.startMs + dur * ((i + 1) / ws.length) });
      });
    }
    const userRequest = words.map(w => w.word).join(' ');

    // Build a sorted list of timed markers
    const markers = [];
    for (const h of this.#hits) {
      markers.push({ timeMs: h.timeMs, tag: `[<${h.id}>]` });
    }
    for (const d of this.#drawings) {
      markers.push({ timeMs: d.startMs, tag: `[<${d.id}>start]` });
      markers.push({ timeMs: d.startMs + d.durationMs, tag: `[<${d.id}>end]` });
    }
    markers.sort((a, b) => a.timeMs - b.timeMs);

    if (markers.length === 0) {
      return { userRequest, userRequestWithActions: userRequest };
    }

    // Without usable timing (or no words at all), append all markers at end
    const hasTiming = words.length > 0 && this.#texts.some(t => t.startMs > 0);
    if (!hasTiming) {
      const tags = markers.map(m => m.tag).join(' ');
      return {
        userRequest,
        userRequestWithActions: (userRequest + ' ' + tags).trim(),
      };
    }

    // Each marker is inserted after the word that was being spoken when the
    // action happened — i.e. the first word whose estimated end-time is at or
    // after the marker time (mirrors InsertActionIntoPrompt in C#).
    const insertAfter = new Map(); // word index -> [tags]
    for (const m of markers) {
      let idx = words.findIndex(w => m.timeMs <= w.endTime);
      if (idx === -1) idx = words.length - 1; // action after speech → after last word
      const list = insertAfter.get(idx) ?? [];
      list.push(m.tag);
      insertAfter.set(idx, list);
    }

    const parts = [];
    words.forEach((w, i) => {
      parts.push(w.word);
      const tags = insertAfter.get(i);
      if (tags) parts.push(...tags);
    });

    return { userRequest, userRequestWithActions: parts.join(' ') };
  }

  /**
   * Serialise the round as the JSON `user` message content that goes into the
   * LLM context.  Matches the `RequestMessageBody` schema from `ManipulatableCore.cs`.
   *
   * @param {object} opts
   * @param {object}   [opts.player]      - Camera/player state `{position, forward, right}`
   * @param {object[]} [opts.objects]     - Manipulatable object list
   * @param {object[]} [opts.envObjects]  - Environment objects
   * @param {object[]} [opts.headStayFrames] - Gaze "head stay" frames (cf. ManipulatableCore
   *   `HeadKeyFrame`): each `{ "Stay Duration", "In Frustum Objects ID":[{Object,Weight}],
   *   "In Frustum Environment Objects ID":[...], "Speak words" }`. Used by the LLM to resolve
   *   deictic references ("this/that/here") from what the user was looking at.
   * @param {boolean}  [opts.debug]       - If true, enables step-explain instruction
   * @param {string}   [opts.requestTextOverride] - If provided, used verbatim as
   *   `user_request_with_actions_inserted` (e.g. when the caller maintains its own
   *   badge/token editor whose visual order IS the timeline).  `user_request` is
   *   derived from it by stripping `[<…>]` tokens.  When omitted, the word-timing
   *   estimation of `buildRequestText()` is used.
   * @returns {string} JSON string
   */
  serialize({ player = null, objects = [], envObjects = [], headStayFrames = [], debug = false, requestTextOverride = null } = {}) {
    let { userRequest, userRequestWithActions } = this.buildRequestText();
    if (requestTextOverride !== null) {
      userRequestWithActions = requestTextOverride.trim();
      userRequest = userRequestWithActions
        .replace(/\[<[^\]>]*>(?:start|end)?\]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    }

    const body = {
      ...(player ? { player } : {}),
      objects,
      ...(headStayFrames.length ? { head_stay_frames: headStayFrames } : {}),
      hit_points: this.#hits.length > 0 ? {
        points: this.#hits.map(h => {
          const pt = { hit_id: h.id, object: h.object };
          const pos = h.position ?? {};
          pt.position = {};
          if (pos.x != null) pt.position.x = Number(pos.x).toFixed(2);
          if (pos.y != null) pt.position.y = Number(pos.y).toFixed(2);
          if (pos.z != null) pt.position.z = Number(pos.z).toFixed(2);
          if (h.normal) {
            const n = h.normal;
            pt.normal = {};
            if (n.x != null) pt.normal.x = Number(n.x).toFixed(2);
            if (n.y != null) pt.normal.y = Number(n.y).toFixed(2);
            if (n.z != null) pt.normal.z = Number(n.z).toFixed(2);
          }
          return pt;
        }),
      } : { points: [] },
      drawing_lines: this.#drawings.map(d => ({
        line_id: d.id,
        points: d.points.map(p => {
          const pt = { x: Number(p.x).toFixed(2), z: Number(p.z).toFixed(2) };
          if (p.y != null) pt.y = Number(p.y).toFixed(2);          // 3D (walls/ceiling/objects)
          if (p.object != null) pt.object = p.object;              // surface/object the point sits on
          if (p.normal) pt.normal = { x: Number(p.normal.x).toFixed(2), y: Number(p.normal.y).toFixed(2), z: Number(p.normal.z).toFixed(2) };
          return pt;
        }),
        duration_ms: Math.round(d.durationMs),
      })),
      user_request: userRequest,
      user_request_with_actions_inserted: userRequestWithActions,
      enabled_actions: 'All the APIs are available',
      step_explain: debug
        ? 'Debugging enabled, call EXPLAIN(string message); before each API call!'
        : 'Debugging disabled, do not call EXPLAIN(string message);',
    };

    return JSON.stringify(body, null, 2);
  }

  /** Return raw arrays for direct inspection / testing. */
  get _texts() { return [...this.#texts]; }
  get _hits() { return [...this.#hits]; }
  get _drawings() { return [...this.#drawings]; }
}

// ---------------------------------------------------------------------------
// SpeechController
// ---------------------------------------------------------------------------

/**
 * Thin wrapper around the browser's Web Speech API (`SpeechRecognition`).
 *
 * Corresponds to `SpeechManager.cs` + `AzureSpeechCore`, but uses the
 * built-in browser engine instead — no subscription required.
 *
 * **Word-level timing**: The Web Speech API does not reliably expose per-word
 * timestamps across browsers.  `onConfirmed` therefore provides
 * `startMs`/`endMs` for the whole utterance (from `recognition.start` to the
 * final result), but not per-word offsets.  This is documented here so
 * downstream consumers don't rely on absent data.
 *
 * @example
 * const stt = new SpeechController({
 *   lang: 'en-US',
 *   onProposal: text => console.log('interim:', text),
 *   onConfirmed: ({ text, startMs, endMs }) => round.addText({ text, startMs, endMs }),
 * });
 * stt.start();
 */
export class SpeechController {
  #recognition = null;
  #started = false;
  #startMs = 0;
  #opts;

  /**
   * @param {object}   opts
   * @param {string}   [opts.lang='en-US']          - BCP-47 language tag
   * @param {boolean}  [opts.interimResults=true]   - Emit interim proposals
   * @param {boolean}  [opts.continuous=true]        - Keep recognising after pauses
   * @param {function} [opts.onProposal]             - (partialText: string) => void
   * @param {function} [opts.onConfirmed]            - ({ text, startMs, endMs }) => void
   * @param {function} [opts.onSpeechStart]          - () => void
   * @param {function} [opts.onSpeechEnd]            - () => void
   * @param {function} [opts.onError]               - (event) => void
   */
  constructor(opts = {}) {
    this.#opts = {
      lang: 'en-US',
      interimResults: true,
      continuous: true,
      onProposal: null,
      onConfirmed: null,
      onSpeechStart: null,
      onSpeechEnd: null,
      onError: null,
      ...opts,
    };
  }

  /** Whether speech recognition is currently active. */
  get active() { return this.#started; }

  /**
   * Start continuous speech recognition.
   * Safe to call when already started (no-op).
   */
  start() {
    if (this.#started) return;

    const SpeechRecognition =
      window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRecognition) {
      console.warn('[SpeechController] Web Speech API not available in this browser.');
      this.#opts.onError?.({ message: 'Web Speech API not supported' });
      return;
    }

    const r = new SpeechRecognition();
    r.lang = this.#opts.lang;
    r.interimResults = this.#opts.interimResults;
    r.continuous = this.#opts.continuous;
    r.maxAlternatives = 1;

    r.onspeechstart = () => {
      this.#startMs = timing.nowMs();
      this.#opts.onSpeechStart?.();
    };

    r.onspeechend = () => {
      this.#opts.onSpeechEnd?.();
    };

    r.onresult = (event) => {
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const res = event.results[i];
        if (res.isFinal) {
          const endMs = timing.nowMs();
          this.#opts.onConfirmed?.({
            text: res[0].transcript.trim(),
            confidence: res[0].confidence,
            startMs: this.#startMs,
            endMs,
          });
          this.#startMs = endMs;
        } else {
          interim += res[0].transcript;
        }
      }
      if (interim) this.#opts.onProposal?.(interim);
    };

    r.onerror = (event) => {
      this.#opts.onError?.(event);
      if (event.error !== 'no-speech') {
        this.#started = false;
      }
    };

    r.onend = () => {
      // Auto-restart to keep continuous recognition alive (mirrors AzureSpeechCore)
      if (this.#started) {
        try { r.start(); } catch (_) { /* ignore if already started */ }
      }
    };

    this.#recognition = r;
    this.#started = true;
    r.start();
  }

  /**
   * Stop speech recognition.
   */
  stop() {
    this.#started = false;
    try { this.#recognition?.stop(); } catch (_) { /* ignore */ }
    this.#recognition = null;
  }
}

// ---------------------------------------------------------------------------
// LLMCore
// ---------------------------------------------------------------------------

/**
 * Sends an `OperatingRound` (or plain text) to an OpenAI-compatible chat
 * completions endpoint and fires callbacks as the streamed response arrives.
 *
 * Mirrors `LLMCore.cs` — specifically:
 * - Builds `messages` via `ContextManager` (system + fewshot + rolling pairs)
 * - Serialises `OperatingRound.serialize()` as the user message
 * - Sends a POST to `{baseUrl}/chat/completions` with SSE streaming
 * - Pipes chunks through `StreamingAPIExtractor` and fires `onCall` per match
 * - On completion, saves assistant reply to context and returns a timing report
 *
 * Auth styles (matches C# `RequestSendReceiver`):
 * - `'bearer'`  → `Authorization: Bearer {apiKey}`
 * - `'api-key'` → `api-key: {apiKey}`
 *
 * @example
 * const llm = new LLMCore({ baseUrl: 'https://api.openai.com/v1',
 *                            apiKey: 'sk-…', model: 'gpt-4o' });
 * await llm.invokeChat(round, {
 *   onCall: (fn, args, raw) => canvas.execute(fn, args),
 *   onDone: (report) => hud.update(report),
 * });
 */
export class LLMCore {
  /** @type {string} */
  #baseUrl;
  /** @type {string} */
  #apiKey;
  /** @type {string} */
  #model;
  /** @type {string} 'bearer' | 'api-key' */
  #authStyle;
  /** @type {number} */
  #maxTokens;
  /** @type {number} */
  #temperature;
  /** @type {boolean} */
  #streaming;
  /** @type {number} Deterministic seed (-1 = random) */
  #seed;
  /** @type {string} */
  #systemPrompt;
  /** @type {string|null} */
  #userFewshot;
  /** @type {string|null} */
  #assistantFewshot;
  /** @type {number} */
  #contextLength;
  /** @type {ContextManager} */
  #context;
  /** @type {StreamingAPIExtractor} */
  #extractor;
  /** @type {boolean} */
  #busy = false;

  /**
   * @param {object} opts
   * @param {string}  opts.baseUrl            - Base URL e.g. `https://api.openai.com/v1`
   * @param {string}  opts.apiKey             - API key
   * @param {string}  [opts.model='gpt-4o']
   * @param {string}  [opts.authStyle='bearer']
   * @param {number}  [opts.maxTokens=4096]
   * @param {number}  [opts.temperature=0.3]
   * @param {boolean} [opts.streaming=true]
   * @param {number}  [opts.contextLength=5]  - Rolling pair window size
   * @param {number}  [opts.seed=-1]          - -1 for random
   * @param {string}  opts.systemPrompt       - Fully resolved system prompt text
   * @param {string}  [opts.userFewshot]      - Pinned user few-shot message
   * @param {string}  [opts.assistantFewshot] - Pinned assistant few-shot message
   */
  constructor(opts) {
    const {
      baseUrl,
      apiKey,
      model = 'gpt-4o',
      authStyle = 'bearer',
      maxTokens = 4096,
      temperature = 0.3,
      streaming = true,
      contextLength = 5,
      seed = -1,
      systemPrompt,
      userFewshot = null,
      assistantFewshot = null,
    } = opts;

    if (!baseUrl) throw new Error('LLMCore: baseUrl is required');
    if (!apiKey) throw new Error('LLMCore: apiKey is required');
    if (!systemPrompt) throw new Error('LLMCore: systemPrompt is required');

    this.#baseUrl = baseUrl.replace(/\/$/, '');
    this.#apiKey = apiKey;
    this.#model = model;
    this.#authStyle = authStyle;
    this.#maxTokens = maxTokens;
    this.#temperature = temperature;
    this.#streaming = streaming;
    this.#seed = seed < 0 ? Math.floor(Math.random() * 2 ** 31) : seed;
    this.#systemPrompt = systemPrompt;
    this.#userFewshot = userFewshot;
    this.#assistantFewshot = assistantFewshot;
    this.#contextLength = contextLength;
    this.#context = new ContextManager(systemPrompt, contextLength, userFewshot, assistantFewshot);
    this.#extractor = new StreamingAPIExtractor();
  }

  /** The `ContextManager` for inspection / export. */
  get context() { return this.#context; }

  /** Whether a request is currently in-flight. */
  get busy() { return this.#busy; }

  /**
   * Build the request body matching `RequestBody` in `ContextManager.cs`.
   * @param {Array<{role:string,content:string}>} messages
   * @returns {object}
   */
  #buildBody(messages) {
    const body = {
      model: this.#model,
      messages,
      max_tokens: this.#maxTokens,
      temperature: this.#temperature,
      stream: this.#streaming,
      seed: this.#seed,
    };
    if (this.#streaming) {
      body.stream_options = { include_usage: true };
    }
    return body;
  }

  /**
   * Build HTTP headers (mirrors `RequestSendReceiver` in `LLMCore.cs`).
   * @returns {object}
   */
  #headers() {
    const h = { 'Content-Type': 'application/json' };
    if (this.#authStyle === 'bearer') {
      h['Authorization'] = `Bearer ${this.#apiKey}`;
    } else {
      h['api-key'] = this.#apiKey;
    }
    // Anthropic's API requires this opt-in header for direct browser (CORS) calls.
    if (this.#baseUrl.includes('api.anthropic.com')) {
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    }
    return h;
  }

  /**
   * Send a complete `OperatingRound` to the LLM.
   *
   * @param {OperatingRound} round
   * @param {object}   [handlers]
   * @param {object}   [handlers.sceneState]    - `{player, objects, envObjects, headStayFrames}` for serialisation
   * @param {boolean}  [handlers.debug]         - Enable EXPLAIN calls in prompt
   * @param {string}   [handlers.requestTextOverride] - Verbatim
   *   `user_request_with_actions_inserted` (see `OperatingRound.serialize`)
   * @param {function} [handlers.onChunk]       - (rawChunk: string) => void — raw SSE text
   * @param {function} [handlers.onCall]        - (fn:string, args:object, rawArgs:string) => void
   * @param {function} [handlers.onMessage]     - (content: string) => void — MESSAGE() calls
   * @param {function} [handlers.onDone]        - (timingReport: object) => void
   * @param {function} [handlers.onError]       - (err: Error) => void
   * @returns {Promise<object>} Resolves with the timing report
   */
  async invokeChat(round, handlers = {}) {
    const { sceneState = {}, debug = false, requestTextOverride = null,
            onChunk, onCall, onMessage, onDone, onError } = handlers;

    const userContent = round.serialize({
      player: sceneState.player,
      objects: sceneState.objects ?? [],
      envObjects: sceneState.envObjects ?? [],
      headStayFrames: sceneState.headStayFrames ?? [],
      debug,
      requestTextOverride,
    });

    this.#context.insertUser(userContent);
    return this.#dispatch(onChunk, onCall, onMessage, onDone, onError);
  }

  /**
   * Simple text-only chat (no round serialisation).
   *
   * @param {string} text
   * @param {object} [handlers]  Same as `invokeChat` handlers
   * @returns {Promise<object>}
   */
  async invokeChatText(text, handlers = {}) {
    const { onChunk, onCall, onMessage, onDone, onError } = handlers;
    this.#context.insertUser(text);
    return this.#dispatch(onChunk, onCall, onMessage, onDone, onError);
  }

  /**
   * Internal: POST the current context and stream the response.
   */
  async #dispatch(onChunk, onCall, onMessage, onDone, onError) {
    if (this.#busy) {
      const err = new Error('LLMCore: a request is already in-flight');
      onError?.(err);
      return Promise.reject(err);
    }
    this.#busy = true;
    this.#extractor.reset();

    const report = {
      requestSentAt: timing.nowMs(),
      firstChunkAt: null,
      firstCallAt: null,
      doneAt: null,
      ttftMs: null,
      totalMs: null,
      usage: null,
    };

    const messages = this.#context.messages();
    const body = this.#buildBody(messages);
    const url = `${this.#baseUrl}/chat/completions`;

    try {
      const resp = await fetch(url, {
        method: 'POST',
        headers: this.#headers(),
        body: JSON.stringify(body),
      });

      if (!resp.ok) {
        const errText = await resp.text();
        throw new Error(`HTTP ${resp.status}: ${errText}`);
      }

      if (this.#streaming) {
        await this.#readStream(resp, report, onChunk, onCall, onMessage);
      } else {
        await this.#readComplete(resp, report, onCall, onMessage);
      }

      // Flush any collected assistant text into context
      const fullReply = this.#extractor.fullRecord();
      this.#context.insertAssistant(fullReply.trim() || 'Empty');

    } catch (err) {
      this.#context.insertAssistant('Empty');
      onError?.(err);
      report.doneAt = timing.nowMs();
      report.totalMs = report.doneAt - report.requestSentAt;
      this.#busy = false;
      return report;
    }

    report.doneAt = timing.nowMs();
    report.totalMs = report.doneAt - report.requestSentAt;
    this.#busy = false;
    onDone?.(report);
    return report;
  }

  /**
   * Read and process a streaming SSE response.
   */
  async #readStream(resp, report, onChunk, onCall, onMessage) {
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    const processLine = (line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed === 'data: [DONE]') return;
      if (!trimmed.startsWith('data: ')) return;

      const jsonStr = trimmed.slice(6);
      let chunk;
      try {
        chunk = JSON.parse(jsonStr);
      } catch {
        return;
      }

      // Extract usage from final chunk (stream_options.include_usage)
      if (chunk.usage) {
        report.usage = chunk.usage;
      }

      const delta = chunk.choices?.[0]?.delta?.content;
      if (!delta) return;

      onChunk?.(delta);

      const { calls } = this.#extractor.receiveChunk(delta);
      for (const [fn, rawArgs] of calls) {
        if (report.firstCallAt === null) {
          report.firstCallAt = timing.nowMs();
        }
        const args = Apis[fn] ? Apis[fn](rawArgs) : parseArgs(rawArgs);
        if (fn === 'MESSAGE') {
          onMessage?.(args.content ?? rawArgs);
        }
        onCall?.(fn, args, rawArgs);
      }
    };

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });

      if (report.firstChunkAt === null) {
        report.firstChunkAt = timing.nowMs();
        report.ttftMs = report.firstChunkAt - report.requestSentAt;
      }

      buffer += text;

      // Process complete SSE lines, keep the incomplete last line buffered
      const lines = buffer.split('\n');
      buffer = lines.pop();
      for (const line of lines) processLine(line);
    }

    // Flush whatever remains: decoder tail + a final line without trailing \n
    buffer += decoder.decode();
    if (buffer) {
      for (const line of buffer.split('\n')) processLine(line);
    }
  }

  /**
   * Read a non-streaming response (complete JSON body).
   */
  async #readComplete(resp, report, onCall, onMessage) {
    const json = await resp.json();
    report.firstChunkAt = timing.nowMs();
    report.ttftMs = report.firstChunkAt - report.requestSentAt;
    report.usage = json.usage ?? null;

    const content = json.choices?.[0]?.message?.content ?? '';
    if (!content) return;

    // Feed entire content to extractor (no streaming)
    const { calls } = this.#extractor.receiveChunk(content);
    for (const [fn, rawArgs] of calls) {
      if (report.firstCallAt === null) {
        report.firstCallAt = timing.nowMs();
      }
      const args = Apis[fn] ? Apis[fn](rawArgs) : parseArgs(rawArgs);
      if (fn === 'MESSAGE') {
        onMessage?.(args.content ?? rawArgs);
      }
      onCall?.(fn, args, rawArgs);
    }
  }

  /**
   * Update the LLM configuration at runtime (e.g. from settings drawer).
   *
   * Most fields are applied in place.  Changing `contextLength` or
   * `systemPrompt` rebuilds the `ContextManager` with the pinned few-shot
   * pair — accumulated conversation pairs are discarded (fresh conversation).
   *
   * @param {Partial<{baseUrl:string, apiKey:string, model:string,
   *                  authStyle:string, maxTokens:number, temperature:number,
   *                  streaming:boolean, contextLength:number,
   *                  systemPrompt:string}>} opts
   */
  updateConfig(opts) {
    if (opts.baseUrl !== undefined) this.#baseUrl = opts.baseUrl.replace(/\/$/, '');
    if (opts.apiKey !== undefined) this.#apiKey = opts.apiKey;
    if (opts.model !== undefined) this.#model = opts.model;
    if (opts.authStyle !== undefined) this.#authStyle = opts.authStyle;
    if (opts.maxTokens !== undefined) this.#maxTokens = opts.maxTokens;
    if (opts.temperature !== undefined) this.#temperature = opts.temperature;
    if (opts.streaming !== undefined) this.#streaming = opts.streaming;
    if (opts.contextLength !== undefined || opts.systemPrompt !== undefined) {
      if (opts.contextLength !== undefined) this.#contextLength = opts.contextLength;
      if (opts.systemPrompt !== undefined) this.#systemPrompt = opts.systemPrompt;
      this.#context = new ContextManager(
        this.#systemPrompt, this.#contextLength,
        this.#userFewshot, this.#assistantFewshot);
    }
  }
}

// ---------------------------------------------------------------------------
// loadPromptPack
// ---------------------------------------------------------------------------

/**
 * Fetch the three prompt text files and return them as strings.
 *
 * The files are plain `.txt` files that are `GET`-able from the same origin.
 * On failure a clear error is thrown so the demo can fall back to inline defaults.
 *
 * @param {string} [baseDir='./prompts'] - Directory URL containing the prompt files
 * @returns {Promise<{systemPrompt:string, userFewshot:string, assistantFewshot:string}>}
 */
export async function loadPromptPack(baseDir = './prompts') {
  const base = baseDir.replace(/\/$/, '');
  const [sys, usr, ast] = await Promise.all([
    fetch(`${base}/system_api.txt`).then(r => {
      if (!r.ok) throw new Error(`Failed to load system_api.txt: ${r.status}`);
      return r.text();
    }),
    fetch(`${base}/user_fewshot.txt`).then(r => {
      if (!r.ok) throw new Error(`Failed to load user_fewshot.txt: ${r.status}`);
      return r.text();
    }),
    fetch(`${base}/assistant_fewshot.txt`).then(r => {
      if (!r.ok) throw new Error(`Failed to load assistant_fewshot.txt: ${r.status}`);
      return r.text();
    }),
  ]);
  return { systemPrompt: sys, userFewshot: usr, assistantFewshot: ast };
}

/**
 * Apply the three placeholder substitutions the system prompt expects.
 *
 * Mirrors `LLMCore.cs` Start() lines 114–118.
 *
 * @param {string} systemPromptTemplate - Raw template with `<prefabs_info>` etc.
 * @param {{ prefabsInfo: string, roomInfo: string, envObjects: string }} substitutions
 * @returns {string}
 */
export function applyPromptSubstitutions(systemPromptTemplate, { prefabsInfo, roomInfo, envObjects }) {
  return systemPromptTemplate
    .replace('<prefabs_info>', prefabsInfo ?? '')
    .replace('<room_info>', roomInfo ?? '')
    .replace('<env_objects>', envObjects ?? '');
}
