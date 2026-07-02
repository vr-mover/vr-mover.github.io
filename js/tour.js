/**
 * tour.js — minimal hand-rolled guided-tour engine for the VR Mover demo.
 *
 * Shows a dimmed overlay with a spotlight cutout over a target element
 * (box-shadow trick) plus a positioned tooltip with Back / Next / Skip.
 *
 * Step shape:
 *   {
 *     target:    string | string[], // CSS selector(s); multiple → union spotlight
 *     title:     string,
 *     body:      string,            // HTML
 *     before:    () => void,        // optional — run before showing (e.g. open a drawer)
 *     advanceOn: { event: string, target?: EventTarget },  // optional auto-advance
 *   }
 *
 * The page stays interactive while the tour runs (the spotlight is
 * pointer-events: none), so steps like "enter your API key" actually work.
 */

export class Tour {
  #steps;
  #idx = -1;
  #spot = null;
  #tip = null;
  #onEnd;
  #advanceCleanup = null;
  #reposition = () => this.#position();

  /**
   * @param {Array<object>} steps
   * @param {{ onEnd?: () => void }} [opts]
   */
  constructor(steps, opts = {}) {
    this.#steps = steps;
    this.#onEnd = opts.onEnd ?? null;
  }

  get active() { return this.#idx >= 0; }

  start() {
    if (this.active) return;
    this.#buildDom();
    window.addEventListener('resize', this.#reposition);
    window.addEventListener('scroll', this.#reposition, true);
    this.#show(0);
  }

  end() {
    if (!this.active) return;
    this.#idx = -1;
    this.#advanceCleanup?.();
    this.#advanceCleanup = null;
    this.#spot?.remove();
    this.#tip?.remove();
    this.#spot = this.#tip = null;
    window.removeEventListener('resize', this.#reposition);
    window.removeEventListener('scroll', this.#reposition, true);
    this.#onEnd?.();
  }

  next() {
    if (this.#idx + 1 >= this.#steps.length) { this.end(); return; }
    this.#show(this.#idx + 1);
  }

  back() {
    if (this.#idx > 0) this.#show(this.#idx - 1);
  }

  #buildDom() {
    this.#spot = document.createElement('div');
    this.#spot.className = 'tour-spotlight';
    this.#tip = document.createElement('div');
    this.#tip.className = 'tour-tip';
    document.body.append(this.#spot, this.#tip);
  }

  #show(i) {
    this.#advanceCleanup?.();
    this.#advanceCleanup = null;

    this.#idx = i;
    const step = this.#steps[i];
    step.before?.();
    // Scroll the (first) target into view within any scrollable ancestor, so it's
    // actually visible before we spotlight it (e.g. fields inside the settings modal).
    const first = this.#targetEls()[0];
    if (first) { try { first.scrollIntoView({ block: 'center', inline: 'nearest' }); } catch {} }

    const last = i === this.#steps.length - 1;
    this.#tip.innerHTML = `
      <div class="tour-tip-title">${step.title}</div>
      <div class="tour-tip-body">${step.body}</div>
      <div class="tour-tip-footer">
        <span class="tour-dots">${this.#steps.map((_, k) =>
          `<i class="${k === i ? 'on' : ''}"></i>`).join('')}</span>
        <span class="tour-btns">
          <button class="tour-btn" data-act="skip">Skip</button>
          ${i > 0 ? '<button class="tour-btn" data-act="back">Back</button>' : ''}
          <button class="tour-btn tour-btn-primary" data-act="next">${last ? 'Done' : 'Next'}</button>
        </span>
      </div>`;
    this.#tip.querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const act = btn.dataset.act;
        if (act === 'skip') this.end();
        else if (act === 'back') this.back();
        else this.next();
      });
    });

    if (step.advanceOn) {
      const tgt = step.advanceOn.target ?? document;
      const handler = () => { if (this.#idx === i) this.next(); };
      tgt.addEventListener(step.advanceOn.event, handler);
      this.#advanceCleanup = () => tgt.removeEventListener(step.advanceOn.event, handler);
    }

    // Let any `before()` DOM changes (drawer transitions etc.) settle first,
    // then position once more after CSS transitions (~250ms) have finished.
    requestAnimationFrame(() => requestAnimationFrame(() => this.#position()));
    setTimeout(() => { if (this.#idx === i) this.#position(); }, 350);
  }

  // Resolve the step's target(s) to elements (supports a selector or an array).
  #targetEls() {
    const t = this.#steps[this.#idx]?.target;
    const sels = Array.isArray(t) ? t : (t ? [t] : []);
    return sels.map(s => document.querySelector(s)).filter(Boolean);
  }

  #position() {
    if (!this.active) return;
    const els = this.#targetEls();
    const pad = 6;

    // Union of all target rects (so we can highlight several inputs at once).
    let r;
    if (els.length) {
      let l = Infinity, t = Infinity, rt = -Infinity, b = -Infinity;
      for (const el of els) { const k = el.getBoundingClientRect(); l = Math.min(l, k.left); t = Math.min(t, k.top); rt = Math.max(rt, k.right); b = Math.max(b, k.bottom); }
      r = { left: l, top: t, width: rt - l, height: b - t };
    } else {
      r = { left: innerWidth / 2 - 1, top: innerHeight / 2 - 1, width: 2, height: 2 };
    }

    Object.assign(this.#spot.style, {
      left:   (r.left - pad) + 'px',
      top:    (r.top - pad) + 'px',
      width:  (r.width + pad * 2) + 'px',
      height: (r.height + pad * 2) + 'px',
    });

    // Viewport bounds inset by the safe area (Dynamic Island / rounded corners),
    // read from CSS vars set on :root.
    const sa = s => parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--sa-' + s)) || 0;
    const vL = sa('l') + 8, vR = innerWidth - sa('r') - 8, vT = sa('t') + 8, vB = innerHeight - sa('b') - 8;

    // Place the tooltip on the side with ENOUGH room so it never covers the spotlight.
    const tw = this.#tip.offsetWidth, th = this.#tip.offsetHeight, m = 12;
    const below = vB - (r.top + r.height), above = r.top - vT, right = vR - (r.left + r.width), left = r.left - vL;
    let tx, ty;
    if (below >= th + m) { ty = r.top + r.height + m; tx = r.left + r.width / 2 - tw / 2; }
    else if (above >= th + m) { ty = r.top - m - th; tx = r.left + r.width / 2 - tw / 2; }
    else if (right >= tw + m) { tx = r.left + r.width + m; ty = r.top + r.height / 2 - th / 2; }
    else if (left >= tw + m) { tx = r.left - m - tw; ty = r.top + r.height / 2 - th / 2; }
    else { ty = below >= above ? r.top + r.height + m : vT; tx = r.left + r.width / 2 - tw / 2; }   // tight screen: best effort
    tx = Math.max(vL, Math.min(vR - tw, tx));
    ty = Math.max(vT, Math.min(vB - th, ty));
    this.#tip.style.left = tx + 'px';
    this.#tip.style.top = ty + 'px';
  }
}
