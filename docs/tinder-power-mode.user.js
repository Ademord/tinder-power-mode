// ==UserScript==
// @name         Tinder Power Mode
// @namespace    tinder-power-mode
// @version      1.1.2
// @description  Gamer-style controls for Tinder web: A/D = nope/like, S = Super Like, R = rewind, arrows = photos, 1-9 = jump to photo, W = open/close profile, F = focus mode, +/- = card zoom. Live HUD with photo counter, action stamps, remappable keys, controller support.
// @author       Francisco & Claude
// @match        https://tinder.com/*
// @match        https://www.tinder.com/*
// @license      MIT
// @homepageURL  https://Ademord.github.io/tinder-power-mode/
// @supportURL   https://github.com/Ademord/tinder-power-mode/issues
// @downloadURL  https://Ademord.github.io/tinder-power-mode/tinder-power-mode.user.js
// @updateURL    https://Ademord.github.io/tinder-power-mode/tinder-power-mode.user.js
// @run-at       document-start
// @grant        none
// ==/UserScript==

/*
 * DOM hooks this script relies on (all taken from the live Tinder DOM, Sept 2026):
 *   card stack ........ [role="region"][aria-label="Card stack"]  (carries the Maw(--recs-card-width)/H(--recs-card-height) classes)
 *   active card ....... [data-keyboard-gamepad="true"][aria-hidden="false"]   (others are aria-hidden="true" + inert)
 *   photo tabs ........ [role="tablist"] > button[role="tab"][aria-label="Photo N"][aria-selected]
 *   photo prev/next ... button[aria-label="Previous Photo"], button[aria-label="Next Photo"]  (disabled at the ends)
 *   gamepad buttons ... button.gamepad-button > ... > span.Hidden = "Rewind" | "Nope" | "Super Like" | "Like" | "Boost"
 *   open profile ...... button[role="button"] containing span.Hidden = "Open Profile"
 *   super likes left .. [aria-label="N remaining"][role="img"] next to the Super Like button (Boost has one too)
 *   greyed-out ........ Rewind carries disabled="" + aria-disabled="true" when there is nothing to rewind — reported, never clicked
 *   native keys ....... ← Nope, → Like, ↑ Open Profile, ↓ Close Profile, Enter Super Like, Space Next Photo (.recsToolbar tips)
 *   open profile view . a different container: div.Mt(a).Expand.H(--recs-card-height)--ml.Maw(--recs-card-width)--ml > .profileContent
 *                       (no role/aria-label!) with h1[aria-label="Name 32 years"], its own carousel + tablist, its own Nope/Super Like/Like
 *                       gamepad, and the close control div[role="button"][data-testid="profileBackButton"] > span.Hidden "Back".
 *   telemetry ......... Tinder runs Sentry (errors + session replay; photos carry class "sentry-block"). Every handler here is
 *                       wrapped so nothing bubbles to window.onerror, and the overlay root is marked data-sentry-block.
 * Press P to probe: exports only structural counts, known action availability, numeric layout,
 * and fixed diagnostic reasons. No names, ages, URLs, arbitrary page text, or DOM nodes.
 */

(() => {
  'use strict';

  /* ═══════════════════════════════ 1. SETTINGS ═══════════════════════════════ */

  const STORE_KEY = 'tpm.settings.v1';
  const VERSION = '1.1.2';

  const DEFAULTS = Object.freeze({
    keys: {
      nope:          ['a'],
      like:          ['d'],
      superlike:     ['s'],
      rewind:        ['r'],
      boost:         [],                          // deliberately unbound: Boost can open a purchase flow
      prevPhoto:     ['arrowleft', 'shift+space'],
      nextPhoto:     ['arrowright'],
      toggleProfile: ['w'],
      openProfile:   [],                          // ↑ stays native
      closeProfile:  ['escape'],                  // ↓ stays native; Esc also closes our panels first
      focus:         ['f'],
      zoomIn:        ['+', '='],
      zoomOut:       ['-'],
      zoomReset:     ['0'],
      cardFit:       ['x'],
      cardWider:     ['shift+arrowright'],
      cardNarrower:  ['shift+arrowleft'],
      cardTaller:    ['shift+arrowup'],
      cardShorter:   ['shift+arrowdown'],
      hud:           ['h', '?'],
      settings:      ['o'],
      probe:         ['p'],
    },
    hideNativeTips: true,      // Tinder's own "← Nope → Like" bar becomes wrong once remapped
    flash: true,               // big stamp over the card on Like / Nope / Super Like / Rewind
    controller: true,          // Gamepad API support
    photoRepeat: true,         // holding ←/→ keeps flipping photos
    hudMode: 'full',           // full | mini | off
    hudPos: 'bottom-right',    // bottom-right | bottom-left | top-right | top-left
    decisionCooldownMs: 450,   // ignore a 2nd Like/Nope/Super Like inside this window
    zoom: 1,                   // multiplier on top of stock/custom size, persisted
    card: { mode: 'fit', w: 800, h: 1280 }, // fit = fill the window's column · custom = w×h px · stock = Tinder's own
    focus: false,              // focus mode, persisted
  });

  const ACTIONS = {
    nope:          { label: 'Nope',                 group: 'decide',  icon: '✕', color: 'nope',   decision: true },
    like:          { label: 'Like',                 group: 'decide',  icon: '♥', color: 'like',   decision: true },
    superlike:     { label: 'Super Like',           group: 'decide',  icon: '★', color: 'super',  decision: true },
    rewind:        { label: 'Rewind',               group: 'decide',  icon: '↶', color: 'rewind', decision: true },
    boost:         { label: 'Boost',                group: 'decide',  icon: '⚡', color: 'boost',  decision: true },
    prevPhoto:     { label: 'Prev photo',           group: 'photos',  icon: '←', color: 'nav',    repeat: true },
    nextPhoto:     { label: 'Next photo',           group: 'photos',  icon: '→', color: 'nav',    repeat: true },
    toggleProfile: { label: 'Profile open/close',   group: 'profile', icon: '⇅', color: 'nav' },
    openProfile:   { label: 'Open profile',         group: 'profile', icon: '↑', color: 'nav' },
    closeProfile:  { label: 'Close profile',        group: 'profile', icon: '↓', color: 'nav' },
    focus:         { label: 'Focus mode',           group: 'view',    icon: '◱', color: 'view' },
    zoomIn:        { label: 'Card bigger',          group: 'view',    icon: '+', color: 'view',   repeat: true },
    zoomOut:       { label: 'Card smaller',         group: 'view',    icon: '−', color: 'view',   repeat: true },
    zoomReset:     { label: 'Card: Tinder’s own size', group: 'view', icon: '0', color: 'view' },
    cardFit:       { label: 'Fit card to window',   group: 'view',    icon: '⤢', color: 'view' },
    cardWider:     { label: 'Card wider (+32px)',   group: 'view',    icon: '→', color: 'view',   repeat: true },
    cardNarrower:  { label: 'Card narrower',        group: 'view',    icon: '←', color: 'view',   repeat: true },
    cardTaller:    { label: 'Card taller (+32px)',  group: 'view',    icon: '↑', color: 'view',   repeat: true },
    cardShorter:   { label: 'Card shorter',         group: 'view',    icon: '↓', color: 'view',   repeat: true },
    hud:           { label: 'HUD full/mini/off',    group: 'view',    icon: '▦', color: 'view' },
    settings:      { label: 'Options',              group: 'view',    icon: '⚙', color: 'view' },
    probe:         { label: 'Probe DOM → console',  group: 'view',    icon: '⌕', color: 'view' },
  };

  const KEY_LABELS = {
    arrowleft: '←', arrowright: '→', arrowup: '↑', arrowdown: '↓',
    space: 'Space', escape: 'Esc', enter: 'Enter', backspace: '⌫', delete: 'Del', tab: 'Tab',
    shift: 'Shift', ctrl: 'Ctrl', alt: 'Alt', meta: 'Meta',
  };

  function load() {
    let saved = {};
    try { saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}') || {}; } catch (_) { /* ignore */ }
    const s = Object.assign({}, DEFAULTS, saved, { keys: {} });
    for (const a of Object.keys(DEFAULTS.keys)) {
      const v = saved.keys && Array.isArray(saved.keys[a]) ? saved.keys[a] : DEFAULTS.keys[a];
      s.keys[a] = v.map(String);
    }
    s.card = Object.assign({}, DEFAULTS.card, saved.card && typeof saved.card === 'object' ? saved.card : {});
    if (!['fit', 'custom', 'stock'].includes(s.card.mode)) s.card.mode = DEFAULTS.card.mode;
    return s;
  }
  const settings = load();
  const save = () => { try { localStorage.setItem(STORE_KEY, JSON.stringify(settings)); } catch (_) { /* ignore */ } };

  /* ═══════════════════════════════ 2. DOM HELPERS ═══════════════════════════════ */

  const $  = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase().replace(/^press .+? to /, '');

  // Accessible name of a control, the way Tinder writes them: aria-label, else a visually hidden span, else title, else short text.
  function labelOf(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return norm(aria);
    const hidden = el.querySelector('.Hidden');
    if (hidden && hidden.textContent.trim()) return norm(hidden.textContent);
    if (el.title) return norm(el.title);
    const t = el.textContent || '';
    return t.length <= 40 ? norm(t) : '';
  }

  function isUsable(el) {
    if (!el || el.closest('[inert]')) return false;
    if (el.closest('[data-keyboard-gamepad][aria-hidden="true"]')) return false;
    return el.getClientRects().length > 0; // rendered (opacity:0 is fine — Tinder's prev/next buttons are Op(0) until hover)
  }

  const mainEl     = () => document.getElementById('main-content') || $('main') || document.body;
  // Expanded profile view: a different container that carries the same size classes but no role/aria-label,
  // closed by <div role="button" data-testid="profileBackButton"><span class="Hidden">Back</span>
  const profileRoot = () => {
    const back = $('[data-testid="profileBackButton"]');
    return (back && (back.closest('.profileContent') || back.closest('[class~="H(--recs-card-height)--ml"]') || back.parentElement)) || $('.profileContent') || null;
  };
  const cardRegion = () => {                                                 // the visible one: card stack, or the open profile's container
    const cands = [$('[role="region"][aria-label="Card stack"]'), ...$$('main [class~="H(--recs-card-height)--ml"]'), ($('.recsCardboard__cardsContainer') || {}).parentElement].filter(Boolean);
    return cands.find(el => el.getClientRects().length > 0) || cands[0] || null;
  };
  const activeCard = () => $('[data-keyboard-gamepad="true"][aria-hidden="false"]')
    || $$('[data-keyboard-gamepad="true"]').find(c => !c.hasAttribute('inert') && c.getAttribute('aria-hidden') !== 'true')
    || null;
  const onRecs = () => /\/app\/(recs|explore)/.test(location.pathname) || !!cardRegion();
  // Tinder's "We've run out of potential matches" screen: no card, a pulsing <output class="beacon"> with your own photo instead
  const emptyState = () => !activeCard() && !!$('.recsCardboard__cards .beacon, .recsCardboard__cards output[aria-busy="true"]');

  function findControl(label, opts = {}) {
    const want = norm(label);
    const scopes = [];
    const prof = profileRoot();          // an open profile wins: its photos, its gamepad
    if (prof) scopes.push(prof);
    const card = activeCard();
    if (card) scopes.push(card);
    scopes.push(mainEl(), document.body);
    const seen = new Set();
    for (const scope of scopes) {
      if (!scope || seen.has(scope)) continue;
      seen.add(scope);
      for (const el of scope.querySelectorAll('button, [role="button"]')) {
        if (labelOf(el) !== want) continue;
        if (el.disabled && !opts.allowDisabled) continue;
        if (!isUsable(el)) continue;
        return el;
      }
    }
    return null;
  }

  function photoTabs(scope = profileRoot() || activeCard() || mainEl()) {
    let tabs = $$('[role="tablist"] [role="tab"]', scope).filter(isUsable);
    if (!tabs.length) tabs = $$('.bullet, [class^="bullet"]', scope).filter(isUsable); // older profile slider fallback
    return tabs;
  }
  function photoState(scope) {
    const tabs = photoTabs(scope);
    const index = tabs.findIndex(t =>
      t.getAttribute('aria-selected') === 'true' || t.getAttribute('aria-current') === 'true' || /active|selected/i.test(t.className));
    return { tabs, count: tabs.length, index };
  }
  // the control that closes an open profile: Tinder's "Back" button (data-testid="profileBackButton"), or any "Close Profile"
  function closeProfileControl() {
    const back = $('[data-testid="profileBackButton"]');
    if (back && isUsable(back)) return back;
    const prof = profileRoot();
    if (prof) {
      const el = Array.from(prof.querySelectorAll('button, [role="button"]')).find(b => ['back', 'close profile', 'close'].includes(labelOf(b)) && isUsable(b));
      if (el) return el;
    }
    return findControl('close profile');
  }
  const profileIsOpen = () => !!closeProfileControl();

  function superLikesLeft() {
    const n = remainingFor(findControl('super like', { allowDisabled: true }));
    return n === null ? '' : String(n);
  }
  // which decision buttons Tinder currently has greyed out or at zero — the HUD dims those chips
  function decisionAvailability() {
    const off = {};
    for (const [action, label] of [['rewind', 'rewind'], ['superlike', 'super like'], ['boost', 'boost'], ['like', 'like'], ['nope', 'nope']]) {
      const b = findControl(label, { allowDisabled: true });
      off[action] = !b || isDisabled(b) || ((action === 'superlike' || action === 'boost') && remainingFor(b) === 0);
    }
    return off;
  }

  /* ═══════════════════════════════ 3. ACTIONS ═══════════════════════════════ */

  let lastDecision = 0;

  // "N remaining" badge that sits next to Super Like / Boost; null when there is none
  function remainingFor(btn) {
    const wrap = btn && (btn.closest('.gamepad-button-wrapper') || btn.parentElement);
    const r = wrap && wrap.querySelector('[aria-label$="remaining"]');
    if (!r) return null;
    const n = parseInt(r.textContent, 10);
    return Number.isFinite(n) ? n : null;
  }
  const isDisabled = btn => !!btn && (btn.disabled || btn.getAttribute('aria-disabled') === 'true');

  function decide(action, label) {
    const now = Date.now();
    if (now - lastDecision < settings.decisionCooldownMs) return true;
    const btn = findControl(label, { allowDisabled: true });
    const name = ACTIONS[action].label;
    if (!btn) { toast(`${name}: button not found (press P to probe)`); return true; }
    if (isDisabled(btn)) { toast(`${name} isn't available right now — Tinder has the button disabled`); return true; }
    if ((action === 'superlike' || action === 'boost') && remainingFor(btn) === 0) {
      toast(`No ${name}s left — not clicking, that would open Tinder's purchase flow`);
      return true;
    }
    lastDecision = now;
    btn.click();
    stamp(action);
    return true;
  }

  function stepPhoto(dir) {
    const btn = findControl(dir > 0 ? 'next photo' : 'previous photo', { allowDisabled: true });
    const { tabs } = photoState();
    if (btn && !btn.disabled) btn.click();
    else if (tabs.length > 1) (dir > 0 ? tabs[0] : tabs[tabs.length - 1]).click(); // wrap around at the ends
    else if (!btn) toast('No photo carousel found (press P to probe)');
    return true;
  }

  function jumpPhoto(n) {
    const { tabs } = photoState();
    if (!tabs.length) { toast('No photo tabs found (press P to probe)'); return true; }
    if (n > tabs.length) { pill(`only ${tabs.length} photo${tabs.length === 1 ? '' : 's'}`); return true; }
    tabs[n - 1].click();
    return true;
  }

  function openProfile() {
    const b = findControl('open profile');
    if (!b) { toast('"Open Profile" not found (press P to probe)'); return true; }
    b.click();
    return true;
  }
  function closeProfile() {
    const b = closeProfileControl();
    if (!b) { toast('Profile is not open'); return true; }
    b.click();
    return true;
  }

  function setFocus(on, silent) {
    settings.focus = !!on; save();
    document.documentElement.classList.toggle('tpm-focus', settings.focus);
    if (!silent) toast(settings.focus ? 'Focus mode ON — press F to exit' : 'Focus mode OFF');
    updateHUD(true);
    return true;
  }

  /* ── Card size ──────────────────────────────────────────────────────────────────────────────
   * Tinder's card-stack region has margin-top:auto inside a full-height column and a capped stock
   * height, so on a tall window it sits at the bottom with a big empty band above it. The script
   * sizes that region itself with one higher-specificity !important rule (it outranks a Stylish
   * sheet too). Modes: fit = fill the column (default), custom = exact pixels, stock = Tinder's own;
   * a zoom multiplier sits on top of stock/custom. The expanded-profile slider gets width/height
   * 100% whenever an override is active (Tinder sizes it for the stock card only).            */
  let zoomBase = null;   // Tinder's stock size, measured with the override switched off
  let lastSize = null;   // what is currently applied — read by the HUD, so no re-measuring on every DOM tick
  function zoomStyleEl() {
    let s = document.getElementById('tpm-zoom');
    if (!s) { s = document.createElement('style'); s.id = 'tpm-zoom'; (document.head || document.documentElement).appendChild(s); }
    return s;
  }
  function withoutOverride(fn) {
    const st = zoomStyleEl();
    const prev = st.textContent;
    st.textContent = '';
    const region = cardRegion();
    if (region) void region.offsetWidth; // reflow without our rule
    try { return fn(region); } finally { st.textContent = prev; }
  }
  const stockOf = region => {
    const cs = getComputedStyle(region), r = region.getBoundingClientRect();
    const w = parseFloat(cs.maxWidth) || r.width, h = parseFloat(cs.height) || r.height;
    return (w > 50 && h > 50) ? { w, h } : null;
  };
  function measureBase() { return withoutOverride(region => (region ? stockOf(region) : null)); }

  // {w,h,mode} to apply, or null for "leave Tinder's own size alone"
  function computeSize() {
    const z = +settings.zoom || 1;
    const c = settings.card || {};
    if (c.mode === 'custom' && c.w > 0 && c.h > 0) return { w: Math.round(c.w * z), h: Math.round(c.h * z), mode: 'custom' };
    if (c.mode === 'fit') {
      const m = withoutOverride(region => {
        if (!region) return null;
        const col = region.parentElement || mainEl();
        const stock = stockOf(region);
        return { colH: col.getBoundingClientRect().height, mainW: mainEl().getBoundingClientRect().width, aspect: stock ? stock.w / stock.h : 0.5625 };
      });
      if (!m || m.colH < 200) return null;
      const h = Math.floor(m.colH - 72);                                   // the gamepad hangs ~55% of its height below the region
      const w = Math.min(Math.round(h * m.aspect), Math.floor(m.mainW - 32));
      return { w, h, mode: 'fit' };
    }
    if (Math.abs(z - 1) < 0.001) return null;
    if (!zoomBase) zoomBase = measureBase();
    if (!zoomBase) return null;
    return { w: Math.round(zoomBase.w * z), h: Math.round(zoomBase.h * z), mode: 'zoom' };
  }
  function applySize(silent) {
    const st = zoomStyleEl();
    const s = computeSize();
    lastSize = s;
    st.textContent = s
      ? `main#main-content [role="region"][aria-label="Card stack"],main#main-content [class~="H(--recs-card-height)--ml"]{max-width:${s.w}px !important;height:${s.h}px !important;}\n.profileCard__slider,.profileCard__slider__imgShadow,.profileCard__slider__img{width:100% !important;height:100% !important;}`
      : '';
    if (!silent) toast(s ? `Card ${s.w}×${s.h}px${s.mode === 'fit' ? ' · fitted to the window' : s.mode === 'zoom' ? ` · zoom ${Math.round(settings.zoom * 100)}%` : ''}` : 'Card: Tinder’s own size');
    updateHUD(true);
  }
  function currentSize() {
    const s = computeSize();
    if (s) return s;
    const b = zoomBase || (zoomBase = measureBase());
    return b ? { w: Math.round(b.w), h: Math.round(b.h), mode: 'stock' } : null;
  }
  function sizeLabel() {
    const s = lastSize;
    if (!s) return 'Stock size';
    return s.mode === 'fit' ? `Fit ${s.w}×${s.h}` : s.mode === 'zoom' ? `Zoom ${Math.round(settings.zoom * 100)}%` : `${s.w}×${s.h}`;
  }
  function zoom(delta) {
    if (delta === 0) { settings.zoom = 1; settings.card.mode = 'stock'; save(); applySize(); return true; }
    if (settings.card.mode === 'fit') { const c = currentSize(); if (c) settings.card = { mode: 'custom', w: c.w, h: c.h }; } // zooming a fitted card makes it custom
    settings.zoom = Math.min(3, Math.max(0.4, +(settings.zoom * (delta > 0 ? 1.1 : 1 / 1.1)).toFixed(3)));
    save(); applySize(); return true;
  }
  function resizeCard(dw, dh) {
    const c = currentSize();
    if (!c) { toast('Card not on screen yet'); return true; }
    settings.card = { mode: 'custom', w: Math.max(240, c.w + dw), h: Math.max(320, c.h + dh) }; // zoom folded into pixels
    settings.zoom = 1;
    save(); applySize(); return true;
  }
  function fitCard() { settings.card.mode = 'fit'; settings.zoom = 1; save(); applySize(); return true; }
  function bigPreset() { settings.card = { mode: 'custom', w: 800, h: 1280 }; settings.zoom = 1; save(); applySize(); return true; }

  const HUD_MODES = ['full', 'mini', 'off'];
  function cycleHud() {
    settings.hudMode = HUD_MODES[(HUD_MODES.indexOf(settings.hudMode) + 1) % HUD_MODES.length];
    save(); updateHUD(true); toast(`HUD: ${settings.hudMode}`);
    return true;
  }

  function probe() {
    const region = cardRegion();
    const profile = profileRoot();
    const scope = profile || region;
    // Do not reuse readState(): its profile name/age are appropriate only for the local HUD.
    // Copy fixed keys and numeric values explicitly; never spread DOM state or saved settings.
    const number = value => Number.isFinite(Number(value)) ? Math.round(Number(value)) : null;
    const dimensions = el => {
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      return { width: number(rect.width), height: number(rect.height) };
    };
    const controls = scope ? $$('button, [role="button"]', scope) : [];
    const main = document.getElementById('main-content');
    // The collapsed card's decision bar is sometimes a sibling of its region.
    if (!profile && main) {
      for (const el of $$('.gamepad-button', main)) if (!controls.includes(el)) controls.push(el);
    }
    const actions = ['like', 'nope', 'super like', 'rewind', 'boost', 'next photo', 'previous photo', 'open profile', 'close profile', 'back'].map(action => {
      const matches = controls.filter(el => labelOf(el) === action && isUsable(el));
      return { action, found: matches.length, enabled: matches.filter(el => !isDisabled(el)).length };
    });
    const ps = photoState(scope || document.createElement('div'));
    const report = {
      version: VERSION,
      state: { cardRegionFound: !!region, activeCardFound: !!activeCard(), profileOpen: profileIsOpen(),
        photoCount: ps.count, photoIndex: ps.index, empty: emptyState(), onCards: onRecs(), focus: !!settings.focus },
      layout: { region: dimensions(region), viewport: { width: number(innerWidth), height: number(innerHeight) } },
      actions,
      reasons: [!region && 'card-region-missing', !ps.count && 'photo-tabs-missing', profileIsOpen() && 'profile-open'].filter(Boolean),
    };
    const serialized = JSON.stringify(report, null, 2);
    console.log('[Tinder Power Mode] sanitized diagnostics\n' + serialized);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(serialized).then(
        () => toast('Sanitized diagnostics copied; also in console (F12)'),
        () => toast('Clipboard unavailable; sanitized diagnostics are in console (F12)')
      );
    } else {
      toast('Sanitized diagnostics are in console (F12); clipboard unavailable');
    }
    return true;
  }

  const CARD_GROUPS = new Set(['decide', 'photos', 'profile']);
  function runAction(action, source) {
    // HUD clicks must share the keyboard/controller guard; overlays can cover a live card.
    if (!GLOBAL_ACTIONS.has(action) && (!onRecs() || blockingModal() || ui.settingsOpen || isTyping())) return true;
    highlightChip(action);
    const meta = ACTIONS[action];
    if ((meta ? CARD_GROUPS.has(meta.group) : /^photo[1-9]$/.test(action)) && emptyState()) {
      toast('No profiles left here — Tinder is showing its "Go Global" screen');
      return true;
    }
    switch (action) {
      case 'like':          return decide('like', 'like');
      case 'nope':          return decide('nope', 'nope');
      case 'superlike':     return decide('superlike', 'super like');
      case 'rewind':        return decide('rewind', 'rewind');
      case 'boost':         return decide('boost', 'boost');
      case 'nextPhoto':     return stepPhoto(1);
      case 'prevPhoto':     return stepPhoto(-1);
      case 'toggleProfile': return profileIsOpen() ? closeProfile() : openProfile();
      case 'openProfile':   return openProfile();
      case 'closeProfile':  return closeProfile();
      case 'focus':         return setFocus(!settings.focus);
      case 'zoomIn':        return zoom(1);
      case 'zoomOut':       return zoom(-1);
      case 'zoomReset':     return zoom(0);
      case 'cardFit':       return fitCard();
      case 'cardWider':     return resizeCard(32, 0);
      case 'cardNarrower':  return resizeCard(-32, 0);
      case 'cardTaller':    return resizeCard(0, 32);
      case 'cardShorter':   return resizeCard(0, -32);
      case 'hud':           return cycleHud();
      case 'settings':      return toggleSettings();
      case 'probe':         return probe();
      default:
        if (/^photo[1-9]$/.test(action)) return jumpPhoto(+action.slice(5));
    }
    return true;
  }

  /* ═══════════════════════════════ 4. KEYBOARD ═══════════════════════════════ */

  function keyName(e) {
    let k = e.key;
    if (k === ' ' || k === 'Spacebar') k = 'space';
    k = k.toLowerCase();
    const mods = [];
    if (e.ctrlKey) mods.push('ctrl');
    if (e.altKey) mods.push('alt');
    if (e.metaKey) mods.push('meta');
    if (e.shiftKey && (k.length > 1 || /^[a-z]$/.test(k))) mods.push('shift'); // printable symbols already reflect Shift
    return mods.concat(k).join('+');
  }
  function keyLabel(k) {
    const m = String(k).match(/^((?:ctrl\+|alt\+|meta\+|shift\+)*)(.+)$/) || [k, '', k]; // the "+" key itself must survive the split
    const parts = m[1].split('+').filter(Boolean).concat(m[2]);
    return parts.map(p => KEY_LABELS[p] || (p.length === 1 ? p.toUpperCase() : p[0].toUpperCase() + p.slice(1))).join('+');
  }

  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    const tag = el.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable || !!el.closest('[contenteditable=""],[contenteditable="true"]');
  }

  // A Tinder modal (e.g. "It's a Match", paywalls) rendered outside <main>: leave every key alone so Tinder/browser handle it.
  // Counts only real overlays: aria-modal, or a role="dialog" covering ≥ 40% of the viewport (so a small banner never freezes the keys).
  let modalToastAt = 0;
  function blockingModal() {
    const main = document.getElementById('main-content');
    const hit = $$('[role="dialog"], [aria-modal="true"]').some(d => {
      if (d.closest('#tpm-root') || (main && main.contains(d)) || !d.getClientRects().length) return false;
      if (d.getAttribute('aria-modal') === 'true') return true;
      const r = d.getBoundingClientRect();
      return (r.width * r.height) >= 0.4 * innerWidth * innerHeight;
    });
    if (hit && Date.now() - modalToastAt > 3000) { modalToastAt = Date.now(); toast('Tinder dialog open — Power Mode keys paused'); }
    return hit;
  }

  function actionForKey(k) {
    for (const [action, keys] of Object.entries(settings.keys)) if (keys.includes(k)) return action;
    if (/^[1-9]$/.test(k)) return 'photo' + k;
    return null;
  }

  const GLOBAL_ACTIONS = new Set(['hud', 'settings', 'probe', 'focus']);
  const swallow = new Set();
  // Nothing from this script may reach window.onerror: Tinder's Sentry would file it as their bug, with our stack trace in it.
  const guard = fn => function (...a) { try { return fn.apply(this, a); } catch (_) { try { console.debug('[Tinder Power Mode] Handler failed; press P for sanitized diagnostics.'); } catch (_) { /* ignore */ } } };

  function onKeyDown(e) {
    if (ui.rebinding) { e.preventDefault(); e.stopImmediatePropagation(); finishRebind(e); return; }
    const k = keyName(e);
    if (ui.settingsOpen) {
      // Keep native form editing and keyboard activation inside our modal.
      e.stopImmediatePropagation();
      if (k === 'escape') {
        e.preventDefault(); swallow.add(e.code || e.key); closeSettings();
      } else if (k === 'tab' || k === 'shift+tab') {
        e.preventDefault();
        const controls = $$('button, input, select, textarea, [tabindex]', ui.settings).filter(el => !el.disabled && el.tabIndex >= 0);
        const index = controls.indexOf(document.activeElement);
        const next = e.shiftKey ? (index <= 0 ? controls.length - 1 : index - 1) : (index + 1) % controls.length;
        if (controls[next]) controls[next].focus();
      } else if (!isTyping()) {
        e.preventDefault();
        if ((k === 'enter' || k === 'space') && document.activeElement?.tagName === 'BUTTON') document.activeElement.click();
      }
      return;
    }
    if (isTyping()) return;
    const action = actionForKey(k);
    if (!action) return;                                          // unbound → Tinder / browser handle it natively
    if (!GLOBAL_ACTIONS.has(action)) {
      if (!onRecs()) return;
      if (blockingModal()) return;
      if (action === 'closeProfile' && k === 'escape' && !closeProfileControl()) return; // nothing to close → pass Esc through
    }
    e.preventDefault(); e.stopImmediatePropagation();
    swallow.add(e.code || e.key);
    if (e.repeat) {
      const meta = ACTIONS[action];
      const repeatable = /^photo[1-9]$/.test(action) ? false : !!(meta && meta.repeat) && (meta.group !== 'photos' || settings.photoRepeat);
      if (!repeatable) return;
    }
    runAction(action, 'key');
  }
  function onKeyOther(e) {
    const id = e.code || e.key;
    if (ui.settingsOpen) {
      e.stopImmediatePropagation();
      if (e.type === 'keyup') swallow.delete(id); else if (!isTyping()) e.preventDefault();
      return;
    }
    if (!swallow.has(id)) return;
    e.stopImmediatePropagation();
    if (e.type === 'keyup') swallow.delete(id); else e.preventDefault();
  }
  window.addEventListener('keydown', guard(onKeyDown), true);
  window.addEventListener('keypress', guard(onKeyOther), true);
  window.addEventListener('keyup', guard(onKeyOther), true);

  /* ═══════════════════════════════ 5. CONTROLLER ═══════════════════════════════ */

  // Standard mapping: A like · B nope · X rewind · Y super like · LB/RB photos · D-pad ←→ photos, ↑↓ profile · Back focus · Start HUD
  const PAD_MAP = { 0: 'like', 1: 'nope', 2: 'rewind', 3: 'superlike', 4: 'prevPhoto', 5: 'nextPhoto', 8: 'focus', 9: 'hud', 12: 'openProfile', 13: 'closeProfile', 14: 'prevPhoto', 15: 'nextPhoto' };
  let padRAF = 0;
  const padPrev = new Map();
  function padTick() {
    padRAF = 0;
    if (!settings.controller) return;
    const pads = (navigator.getGamepads ? navigator.getGamepads() : []) || [];
    let any = false;
    for (const gp of pads) {
      if (!gp) continue;
      any = true;
      const prev = padPrev.get(gp.index) || [];
      gp.buttons.forEach((b, i) => {
        const pressed = b.pressed || b.value > 0.6;
        if (pressed && !prev[i] && PAD_MAP[i] && !ui.settingsOpen && !isTyping() && (GLOBAL_ACTIONS.has(PAD_MAP[i]) || (onRecs() && !blockingModal()))) {
          runAction(PAD_MAP[i], 'pad');
        }
        prev[i] = pressed;
      });
      padPrev.set(gp.index, prev);
    }
    if (any) padRAF = requestAnimationFrame(safePadTick);
  }
  const safePadTick = guard(padTick);
  function startPad() { if (!padRAF && settings.controller) padRAF = requestAnimationFrame(safePadTick); }
  window.addEventListener('gamepadconnected', e => { toast(`🎮 Controller connected: ${(e.gamepad.id || '').split('(')[0].trim() || 'gamepad'}`); startPad(); });
  window.addEventListener('gamepaddisconnected', () => toast('🎮 Controller disconnected'));

  /* ═══════════════════════════════ 6. UI ═══════════════════════════════ */

  const CSS = `
#tpm-root{position:fixed;inset:0;pointer-events:none;z-index:2147483000;font-family:Inter,ui-sans-serif,system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-size:13px;line-height:1.3;color:#fff;
  --tpm-like:#21d07a;--tpm-nope:#ff4f6a;--tpm-super:#3d8bff;--tpm-rewind:#ffb020;--tpm-boost:#b55cff;--tpm-nav:#cfd6e0;--tpm-view:#8f9bb0}
#tpm-root *{box-sizing:border-box}
#tpm-hud{position:absolute;pointer-events:auto;background:rgba(12,13,18,.88);backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);border:1px solid rgba(255,255,255,.08);border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.45);padding:12px 14px;width:330px;user-select:none}
#tpm-hud.tpm-off{display:none}
#tpm-hud.tpm-mini{width:auto;padding:8px 12px}
#tpm-hud.tpm-mini .tpm-full{display:none}
#tpm-hud:not(.tpm-mini) .tpm-minibar{display:none}
.tpm-pos-bottom-right{right:16px;bottom:16px}.tpm-pos-bottom-left{left:16px;bottom:16px}.tpm-pos-top-right{right:16px;top:16px}.tpm-pos-top-left{left:16px;top:16px}
.tpm-head{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:8px}
.tpm-logo{font-weight:800;letter-spacing:.14em;font-size:11px}
.tpm-who{font-weight:600;opacity:.85;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:170px}
.tpm-photo{display:flex;align-items:center;gap:10px;margin-bottom:8px}
.tpm-count{font-weight:800;font-variant-numeric:tabular-nums;letter-spacing:.06em;font-size:11px;color:#dfe5ee;white-space:nowrap}
.tpm-dots{display:flex;gap:3px;flex:1}
.tpm-dots i{flex:1;height:4px;border-radius:3px;background:rgba(255,255,255,.16)}
.tpm-dots i.seen{background:rgba(255,255,255,.45)}
.tpm-dots i.on{background:#fff}
.tpm-group{display:flex;flex-wrap:wrap;gap:5px;align-items:center;margin:4px 0}
.tpm-gt{flex-basis:100%;font-size:9px;font-weight:800;letter-spacing:.18em;color:#7f8a9c;margin-top:4px}
.tpm-chip{display:inline-flex;align-items:center;gap:5px;padding:3px 7px 3px 3px;border-radius:8px;background:rgba(255,255,255,.05);border:1px solid rgba(255,255,255,.07);font-size:10.5px;font-weight:700;letter-spacing:.03em;color:#e6ebf2;cursor:pointer;transition:transform .12s,background .12s,box-shadow .12s;--c:var(--tpm-nav)}
.tpm-chip:hover{background:rgba(255,255,255,.1)}
.tpm-chip kbd{display:inline-flex;align-items:center;justify-content:center;min-width:22px;height:20px;padding:0 5px;border-radius:5px;background:#1c1f27;border:1px solid #363b47;border-bottom-width:2px;font:inherit;font-size:10.5px;color:#fff}
.tpm-chip i{font-style:normal;color:var(--c)}
.tpm-chip.is-active{transform:scale(1.08);background:color-mix(in srgb,var(--c) 30%,transparent);box-shadow:0 0 0 1px var(--c)}
.tpm-chip.native{opacity:.5;cursor:default}
.tpm-chip.off{opacity:.38;filter:saturate(.2)}
.tpm-c-like{--c:var(--tpm-like)}.tpm-c-nope{--c:var(--tpm-nope)}.tpm-c-super{--c:var(--tpm-super)}.tpm-c-rewind{--c:var(--tpm-rewind)}.tpm-c-boost{--c:var(--tpm-boost)}.tpm-c-nav{--c:var(--tpm-nav)}.tpm-c-view{--c:var(--tpm-view)}
.tpm-foot{margin-top:8px;font-size:10px;color:#7f8a9c;display:flex;gap:10px;flex-wrap:wrap}
.tpm-foot b{color:#c9d1dc;font-weight:700}
.tpm-minibar{display:flex;align-items:center;gap:10px;font-weight:700;font-size:11px;white-space:nowrap}
.tpm-minibar kbd{font:inherit;font-size:10px;padding:1px 5px;border-radius:4px;background:#1c1f27;border:1px solid #363b47}
#tpm-stamp{position:absolute;display:none;align-items:center;justify-content:center;flex-direction:column;gap:6px}
#tpm-stamp.show{display:flex;animation:tpm-stamp .72s ease-out forwards}
#tpm-stamp .tpm-ic{font-size:110px;line-height:1;filter:drop-shadow(0 8px 30px rgba(0,0,0,.55))}
#tpm-stamp .tpm-tx{font-weight:900;letter-spacing:.3em;font-size:22px;text-shadow:0 2px 12px rgba(0,0,0,.6)}
@keyframes tpm-stamp{0%{opacity:0;transform:scale(.5) rotate(-6deg)}18%{opacity:1;transform:scale(1.05) rotate(0)}70%{opacity:1;transform:scale(1)}100%{opacity:0;transform:scale(1.12)}}
#tpm-pill{position:absolute;display:none;padding:5px 12px;border-radius:999px;background:rgba(10,11,15,.82);border:1px solid rgba(255,255,255,.12);font-weight:800;font-size:12px;letter-spacing:.08em;font-variant-numeric:tabular-nums;transform:translateX(-50%)}
#tpm-pill.show{display:block;animation:tpm-pill 1.1s ease-out forwards}
@keyframes tpm-pill{0%{opacity:0;transform:translateX(-50%) translateY(-6px)}15%{opacity:1;transform:translateX(-50%)}75%{opacity:1}100%{opacity:0}}
#tpm-toasts{position:absolute;left:50%;bottom:28px;transform:translateX(-50%);display:flex;flex-direction:column;gap:6px;align-items:center}
.tpm-toast{padding:8px 14px;border-radius:10px;background:rgba(12,13,18,.92);border:1px solid rgba(255,255,255,.1);font-weight:600;font-size:12px;animation:tpm-toast 2.6s ease forwards;white-space:nowrap;max-width:80vw;overflow:hidden;text-overflow:ellipsis}
@keyframes tpm-toast{0%{opacity:0;transform:translateY(8px)}10%{opacity:1;transform:none}80%{opacity:1}100%{opacity:0}}
#tpm-settings{position:absolute;inset:0;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.55);pointer-events:auto}
#tpm-settings.open{display:flex}
.tpm-modal{width:min(580px,94vw);max-height:88vh;overflow:auto;background:#0f1117;border:1px solid rgba(255,255,255,.1);border-radius:16px;padding:18px 20px;box-shadow:0 30px 80px rgba(0,0,0,.6)}
.tpm-modal h2{margin:0 0 4px;font-size:14px;letter-spacing:.12em}
.tpm-modal p{margin:0 0 10px;color:#8f9bb0;font-size:12px}
.tpm-sec{font-size:9px;font-weight:800;letter-spacing:.18em;color:#7f8a9c;margin:12px 0 2px}
.tpm-row{display:flex;align-items:center;gap:8px;padding:6px 0;border-top:1px solid rgba(255,255,255,.06)}
.tpm-row .tpm-lbl{flex:1;font-weight:600}
.tpm-row .tpm-lbl small{display:block;color:#7f8a9c;font-weight:500;font-size:11px}
.tpm-keys{display:flex;flex-wrap:wrap;gap:4px;justify-content:flex-end;max-width:55%}
.tpm-key{cursor:pointer;display:inline-flex;align-items:center;gap:4px;padding:2px 7px;border-radius:6px;background:#1c1f27;border:1px solid #363b47;font-weight:700;font-size:11px}
.tpm-key:hover{border-color:#8f9bb0}
.tpm-key.rec{border-color:var(--tpm-super);box-shadow:0 0 0 2px rgba(61,139,255,.35)}
.tpm-key b{color:#7f8a9c;margin-left:2px;font-weight:900}
.tpm-key b:hover{color:var(--tpm-nope)}
.tpm-key.add{background:transparent;color:#7f8a9c;border-style:dashed}
.tpm-modal select,.tpm-modal input[type=number]{background:#1c1f27;color:#fff;border:1px solid #363b47;border-radius:6px;padding:3px 6px;font:inherit;font-size:12px}
.tpm-modal input[type=number]{width:80px}
.tpm-modal input[type=checkbox]{width:16px;height:16px;accent-color:var(--tpm-super)}
.tpm-btns{display:flex;gap:8px;justify-content:flex-end;margin-top:14px}
.tpm-btn{cursor:pointer;padding:7px 14px;border-radius:8px;border:1px solid #363b47;background:#1c1f27;color:#fff;font:inherit;font-weight:700;font-size:12px}
#tpm-settings button.tpm-key{font:inherit;color:inherit}
#tpm-settings .tpm-key-wrap{display:inline-flex;gap:3px}
#tpm-settings .tpm-key.remove{padding:4px 6px;color:#c4cbd8}
#tpm-settings :is(button,input,select):focus-visible{outline:2px solid #77adff;outline-offset:3px}
#tpm-settings .tpm-modal:focus{outline:none}
.tpm-btn.primary{background:var(--tpm-super);border-color:transparent}
html.tpm-hide-tips .recsToolbar{display:none !important}
html.tpm-empty main#main-content [role="region"][aria-label="Card stack"]{height:min(var(--recs-card-height,600px),600px) !important;max-width:var(--recs-card-width,375px) !important;margin-top:auto !important;margin-bottom:auto !important}
html.tpm-focus *:has(> main#main-content) > :not(main#main-content):not([role="dialog"]):not(:has([role="dialog"])){display:none !important}
html.tpm-focus main#main-content{border:0 !important}
html.tpm-focus .recsToolbar{display:none !important}
`;

  const ui = { root: null, hud: null, stamp: null, pill: null, toasts: null, settings: null, settingsOpen: false, rebinding: null, lastState: '', prev: null };

  function injectStyle() {
    if (document.getElementById('tpm-style')) return;
    const s = document.createElement('style');
    s.id = 'tpm-style';
    s.textContent = CSS;
    (document.head || document.documentElement).appendChild(s);
  }

  function ensureUI() {
    if (ui.root || !document.body) return;
    const root = document.createElement('div');
    root.id = 'tpm-root';
    root.setAttribute('data-sentry-block', ''); // Sentry session replay records a blocked box here instead of the HUD's content
    root.innerHTML = '<div id="tpm-hud"></div><div id="tpm-stamp"><div class="tpm-ic"></div><div class="tpm-tx"></div></div><div id="tpm-pill"></div><div id="tpm-toasts"></div><div id="tpm-settings"></div>';
    document.body.appendChild(root);
    ui.root = root;
    ui.hud = $('#tpm-hud', root);
    ui.stamp = $('#tpm-stamp', root);
    ui.pill = $('#tpm-pill', root);
    ui.toasts = $('#tpm-toasts', root);
    ui.settings = $('#tpm-settings', root);
    ui.hud.addEventListener('click', guard(e => {
      const chip = e.target.closest('[data-action]');
      if (chip && !chip.classList.contains('native')) runAction(chip.dataset.action, 'mouse');
    }));
    ui.settings.addEventListener('click', guard(onSettingsClick));
    ui.settings.addEventListener('change', guard(onSettingsChange));
  }

  function toast(msg) {
    ensureUI();
    if (!ui.toasts) return;
    const el = document.createElement('div');
    el.className = 'tpm-toast';
    el.textContent = msg;
    ui.toasts.appendChild(el);
    while (ui.toasts.children.length > 3) ui.toasts.firstChild.remove();
    setTimeout(() => el.remove(), 2600);
  }

  function regionRect() {
    const r = cardRegion();
    return r ? r.getBoundingClientRect() : { left: 0, top: 0, width: innerWidth, height: innerHeight };
  }

  function stamp(action) {
    if (!settings.flash) return;
    ensureUI();
    if (!ui.stamp) return;
    const meta = ACTIONS[action];
    const r = regionRect();
    ui.stamp.style.cssText = `left:${r.left}px;top:${r.top}px;width:${r.width}px;height:${r.height}px;color:var(--tpm-${meta.color})`;
    $('.tpm-ic', ui.stamp).textContent = meta.icon;
    $('.tpm-tx', ui.stamp).textContent = meta.label.toUpperCase();
    ui.stamp.classList.remove('show');
    void ui.stamp.offsetWidth;
    ui.stamp.classList.add('show');
    clearTimeout(ui.stamp._t);
    ui.stamp._t = setTimeout(() => ui.stamp.classList.remove('show'), 740);
  }

  function pill(text) {
    ensureUI();
    if (!ui.pill) return;
    const r = regionRect();
    ui.pill.style.cssText = `left:${r.left + r.width / 2}px;top:${r.top + 14}px`;
    ui.pill.textContent = text;
    ui.pill.classList.remove('show');
    void ui.pill.offsetWidth;
    ui.pill.classList.add('show');
    clearTimeout(ui.pill._t);
    ui.pill._t = setTimeout(() => ui.pill.classList.remove('show'), 1120);
  }

  function highlightChip(action) {
    if (!ui.hud) return;
    const chip = ui.hud.querySelector(`[data-action="${action}"]`);
    if (!chip) return;
    chip.classList.add('is-active');
    setTimeout(() => chip.classList.remove('is-active'), 260);
  }

  function readState() {
    const card = activeCard();
    const prof = profileRoot();
    const ps = photoState();
    const q = (sel) => { const el = card && card.querySelector(sel); return el ? el.textContent.trim() : ''; };
    let name = q('[itemprop="name"]'), age = q('[itemprop="age"]');
    if (prof) { // the open profile's <h1 aria-label="Name 32 years"><span>Name</span><span>32</span></h1>
      const h1 = prof.querySelector('h1');
      const spans = h1 ? Array.from(h1.querySelectorAll('span')).map(x => x.textContent.trim()).filter(Boolean) : [];
      if (spans.length) { name = spans[0]; age = spans[1] || ''; }
      else if (h1) { name = h1.textContent.trim(); age = ''; }
    }
    return {
      name, age,
      count: ps.count, index: ps.index,
      profile: profileIsOpen(), sl: superLikesLeft(), off: decisionAvailability(), empty: emptyState(),
      size: sizeLabel(), focus: settings.focus, mode: settings.hudMode, pos: settings.hudPos, recs: onRecs(),
    };
  }

  function chip(action, opts = {}) {
    const meta = ACTIONS[action];
    const keys = opts.keys || settings.keys[action] || [];
    if (!keys.length) return '';
    const labels = keys.slice(0, 2).map(keyLabel);
    const kbd = labels.map(l => `<kbd>${esc(l)}</kbd>`).join('');
    const icon = labels.includes(meta.icon) ? '' : `<i>${meta.icon}</i>`; // don't print "→ → Next photo"
    const title = opts.off ? `${meta.label} — greyed out in Tinder right now` : meta.label;
    return `<span class="tpm-chip tpm-c-${meta.color}${opts.off ? ' off' : ''}" data-action="${action}" title="${esc(title)}">${kbd}${icon}${esc(opts.label || meta.label)}</span>`;
  }
  function nativeChip(key, label, icon, color) {
    if (actionForKey(key)) return ''; // rebound by us → not native any more
    return `<span class="tpm-chip native tpm-c-${color}" title="Tinder's own shortcut"><kbd>${esc(keyLabel(key))}</kbd><i>${icon}</i>${esc(label)}</span>`;
  }

  let hudRAF = 0;
  function updateHUD(force) {
    if (force) ui.lastState = '';
    if (hudRAF) return;
    hudRAF = requestAnimationFrame(() => { hudRAF = 0; renderHUD(); });
  }

  function renderHUD() {
    ensureUI();
    if (!ui.hud) return;
    const s = readState();
    const key = JSON.stringify(s);
    if (key === ui.lastState) return;
    const p = ui.prev;
    if (p && p.name === s.name && p.age === s.age && p.count === s.count && s.count > 0 && s.index >= 0 && s.index !== p.index) {
      pill(`${s.index + 1} / ${s.count}`); // photo counter flash on every photo change (keys, mouse or Space)
    }
    ui.prev = s;
    ui.lastState = key;

    document.documentElement.classList.toggle('tpm-focus', !!(s.focus && s.recs)); // focus mode only on the card page — the sidebar comes back in chats
    document.documentElement.classList.toggle('tpm-empty', !!s.empty);           // "out of profiles" screen: give the region Tinder's own size back
    ui.hud.className = `tpm-pos-${s.pos} ${(s.mode === 'off' || !s.recs) ? 'tpm-off' : s.mode === 'mini' ? 'tpm-mini' : ''}`;
    if (s.mode === 'off' || !s.recs) return;

    const who = s.empty ? 'no profiles left here' : s.name ? `${esc(s.name)}${s.age ? ', ' + esc(s.age) : ''}` : '';
    const counter = s.empty ? 'NO CARD' : s.count ? `PHOTO ${s.index + 1}/${s.count}` : 'PHOTO –';
    const dots = s.count ? Array.from({ length: s.count }, (_, i) => `<i class="${i < s.index ? 'seen' : i === s.index ? 'on' : ''}"></i>`).join('') : '';
    const sl = s.sl ? `<b>★ ${esc(s.sl)}</b> left` : '';

    ui.hud.innerHTML = `
      <div class="tpm-minibar">🎮 <span>${counter}</span>${who ? `<span style="opacity:.8">${who}</span>` : ''}${s.profile ? '<span style="opacity:.8">PROFILE</span>' : ''}<kbd>H</kbd></div>
      <div class="tpm-full">
        <div class="tpm-head"><span class="tpm-logo">🎮 POWER MODE</span><span class="tpm-who">${who}</span></div>
        <div class="tpm-photo"><span class="tpm-count">${counter}</span><div class="tpm-dots">${dots}</div></div>
        <div class="tpm-group"><span class="tpm-gt">DECIDE</span>${chip('nope', { off: s.off.nope })}${chip('like', { off: s.off.like })}${chip('superlike', { off: s.off.superlike })}${chip('rewind', { off: s.off.rewind })}${chip('boost', { off: s.off.boost })}${nativeChip('enter', 'Super Like', '★', 'super')}</div>
        <div class="tpm-group"><span class="tpm-gt">PHOTOS</span>${chip('prevPhoto')}${chip('nextPhoto')}<span class="tpm-chip tpm-c-nav" title="Jump to photo"><kbd>1</kbd><kbd>9</kbd><i>#</i>Jump</span>${nativeChip('space', 'Next photo', '→', 'nav')}</div>
        <div class="tpm-group"><span class="tpm-gt">PROFILE ${s.profile ? '· <span style="color:#fff">OPEN</span>' : '· closed'}</span>${chip('toggleProfile')}${chip('openProfile')}${chip('closeProfile')}${nativeChip('arrowup', 'Open profile', '↑', 'nav')}${nativeChip('arrowdown', 'Close profile', '↓', 'nav')}</div>
        <div class="tpm-group"><span class="tpm-gt">VIEW · card ${esc(s.size.toLowerCase())}</span>${chip('focus', { label: s.focus ? 'Focus ON' : 'Focus' })}${chip('zoomOut', { label: 'Smaller' })}${chip('zoomIn', { label: 'Bigger' })}${chip('cardFit', { label: 'Fit' })}<span class="tpm-chip tpm-c-view" title="Shift + arrow keys: card width / height in 32px steps"><kbd>⇧</kbd><kbd>←↑↓→</kbd><i>⤢</i>Size</span>${chip('zoomReset', { label: 'Stock' })}${chip('hud', { label: 'HUD' })}${chip('settings')}${chip('probe', { label: 'Probe' })}</div>
        <div class="tpm-foot">${sl}<span>dimmed = Tinder native key</span><span><b>1–9</b> jump to photo</span></div>
      </div>`;
  }

  /* ── options panel ── */

  function toggleSettings() { ui.settingsOpen ? closeSettings() : openSettings(); return true; }
  function openSettings() {
    ensureUI(); if (!ui.settings) return;
    ui.previousFocus = document.activeElement;
    ui.settingsOpen = true; ui.settings.classList.add('open'); renderSettings();
  }
  function closeSettings() {
    ui.settingsOpen = false; ui.rebinding = null;
    if (ui.settings?.contains(document.activeElement)) document.activeElement.blur();
    if (ui.settings) ui.settings.classList.remove('open');
    if (ui.previousFocus?.isConnected) ui.previousFocus.focus();
    updateHUD(true);
  }

  function renderSettings() {
    const focusedId = ui.settings.contains(document.activeElement) ? document.activeElement.id : '';
    const groups = [['decide', 'DECIDE'], ['photos', 'PHOTOS'], ['profile', 'PROFILE'], ['view', 'VIEW & TOOLS']];
    const rows = groups.map(([g, title]) => `<div class="tpm-sec">${title}</div>` + Object.entries(ACTIONS).filter(([, m]) => m.group === g).map(([a, m]) => `
      <div class="tpm-row">
        <div class="tpm-lbl"><span style="color:var(--tpm-${m.color})">${m.icon}</span> ${esc(m.label)}${a === 'boost' ? '<small>unbound by default — Boost can open a purchase flow</small>' : ''}${a === 'closeProfile' ? '<small>Esc closes our panels first, then the profile; passes through when nothing is open</small>' : ''}</div>
        <div class="tpm-keys">${settings.keys[a].map((k, i) => `<span class="tpm-key-wrap"><button type="button" id="tpm-key-${a}-${i}" class="tpm-key" data-a="${a}" data-i="${i}" aria-label="Rebind ${esc(m.label)}: ${esc(keyLabel(k))}">${esc(keyLabel(k))}</button><button type="button" class="tpm-key remove" data-a="${a}" data-i="${i}" data-del="1" aria-label="Remove ${esc(keyLabel(k))} binding for ${esc(m.label)}">×</button></span>`).join('')}<button type="button" id="tpm-key-${a}-add" class="tpm-key add" data-a="${a}" data-i="-1" aria-label="Add key for ${esc(m.label)}">+ key</button></div>
      </div>`).join('')).join('');

    const fieldLabels = { cardMode: 'Card size mode', hudMode: 'HUD mode', hudPos: 'HUD position', hideNativeTips: 'Hide native shortcut bar', flash: 'Show action stamps', photoRepeat: 'Repeat photo navigation when held', controller: 'Enable controller input' };
    const sel = (name, opts, cur = settings[name]) => `<select id="tpm-opt-${name}" aria-label="${fieldLabels[name]}" data-opt="${name}">${opts.map(o => `<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`).join('')}</select>`;
    const chk = (name) => `<input type="checkbox" id="tpm-opt-${name}" aria-label="${fieldLabels[name]}" data-opt="${name}" ${settings[name] ? 'checked' : ''}>`;

    ui.settings.innerHTML = `<div class="tpm-modal" role="dialog" aria-modal="true" aria-labelledby="tpm-options-title" aria-describedby="tpm-options-description" tabindex="-1">
      <h2 id="tpm-options-title">🎮 TINDER POWER MODE — OPTIONS</h2>
      <p id="tpm-options-description">Activate a key to rebind it, then press the new key (Esc cancels). Tab moves between controls. Outside these options, Tinder's native keys keep working unless you bind them here: <b>↑</b> open profile · <b>↓</b> close profile · <b>Space</b> next photo · <b>Enter</b> Super Like. <b>1–9</b> jump to that photo (fixed).</p>
      ${rows}
      <div class="tpm-sec">CARD SIZE</div>
      <div class="tpm-row"><div class="tpm-lbl">Mode<small><b>fit</b> fills the window’s height (also <b>X</b>) · <b>custom</b> = exact pixels · <b>stock</b> = Tinder’s own size (also <b>0</b>)</small></div>${sel('cardMode', ['fit', 'custom', 'stock'], settings.card.mode)}</div>
      <div class="tpm-row"><div class="tpm-lbl">Custom size (px)<small>Shift+←/→ width, Shift+↑/↓ height, 32px steps; + / − scale it</small></div><input type="number" id="tpm-opt-cardW" aria-label="Card width in pixels" data-opt="cardW" min="240" max="4000" step="8" value="${+settings.card.w}"> × <input type="number" id="tpm-opt-cardH" aria-label="Card height in pixels" data-opt="cardH" min="320" max="4000" step="8" value="${+settings.card.h}"></div>
      <div class="tpm-row"><div class="tpm-lbl">Preset<small>the 50em × 80em card from the old Stylish sheet</small></div><button class="tpm-btn" data-act="big">800 × 1280</button></div>
      <div class="tpm-sec">BEHAVIOUR</div>
      <div class="tpm-row"><div class="tpm-lbl">Hide Tinder's own shortcut bar<small>its "← Nope · → Like" hints are wrong once the arrows are remapped</small></div>${chk('hideNativeTips')}</div>
      <div class="tpm-row"><div class="tpm-lbl">Action stamp over the card<small>♥ LIKE / ✕ NOPE / ★ SUPER LIKE / ↶ REWIND flash</small></div>${chk('flash')}</div>
      <div class="tpm-row"><div class="tpm-lbl">Hold ←/→ to keep flipping photos</div>${chk('photoRepeat')}</div>
      <div class="tpm-row"><div class="tpm-lbl">Controller support<small>A like · B nope · Y super like · X rewind · LB/RB or D-pad ←→ photos · D-pad ↑↓ profile · Start HUD · Back focus</small></div>${chk('controller')}</div>
      <div class="tpm-row"><div class="tpm-lbl">Decision cooldown (ms)<small>a second Like/Nope/Super Like inside this window is ignored</small></div><input type="number" id="tpm-opt-decisionCooldownMs" aria-label="Decision cooldown in milliseconds" data-opt="decisionCooldownMs" min="0" max="3000" step="50" value="${+settings.decisionCooldownMs}"></div>
      <div class="tpm-row"><div class="tpm-lbl">HUD</div>${sel('hudMode', HUD_MODES)} ${sel('hudPos', ['bottom-right', 'bottom-left', 'top-right', 'top-left'])}</div>
      <div class="tpm-btns"><button class="tpm-btn" data-act="reset">Reset defaults</button><button class="tpm-btn primary" data-act="close">Done</button></div>
    </div>`;
    if (ui.settingsOpen) (document.getElementById(focusedId) || ui.settings.querySelector('[role="dialog"]')).focus();
  }

  function onSettingsClick(e) {
    if (e.target === ui.settings) { closeSettings(); return; }
    const btn = e.target.closest('[data-act]');
    if (btn) {
      if (btn.dataset.act === 'reset') {
        for (const a of Object.keys(DEFAULTS.keys)) settings.keys[a] = [...DEFAULTS.keys[a]];
        for (const k of ['hideNativeTips', 'flash', 'controller', 'photoRepeat', 'hudMode', 'hudPos', 'decisionCooldownMs', 'zoom', 'focus']) settings[k] = DEFAULTS[k];
        settings.card = Object.assign({}, DEFAULTS.card);
        save(); applySettings(); applySize(true); renderSettings(); toast('Defaults restored');
      } else if (btn.dataset.act === 'big') {
        bigPreset(); renderSettings();
      } else closeSettings();
      return;
    }
    const key = e.target.closest('.tpm-key');
    if (!key) return;
    const a = key.dataset.a, i = +key.dataset.i;
    if (e.target.dataset.del) {
      settings.keys[a].splice(i, 1);
      save(); renderSettings(); updateHUD(true);
      return;
    }
    if (ui.rebinding && ui.rebinding.el) ui.rebinding.el.classList.remove('rec');
    ui.rebinding = { a, i, el: key };
    key.classList.add('rec');
    key.textContent = 'press a key…';
  }

  function finishRebind(e) {
    const rb = ui.rebinding;
    ui.rebinding = null;
    const k = keyName(e);
    if (['shift', 'control', 'alt', 'meta', 'shift+shift'].includes(k) || k.endsWith('+control') || k.endsWith('+alt') || k.endsWith('+meta')) { ui.rebinding = rb; return; } // modifier alone: keep waiting
    if (k === 'escape') { renderSettings(); return; }
    if (k === 'backspace' || k === 'delete') { if (rb.i >= 0) settings.keys[rb.a].splice(rb.i, 1); }
    else if (/^[1-9]$/.test(k)) { toast('1–9 are reserved for jumping to a photo'); }
    else {
      for (const other of Object.keys(settings.keys)) settings.keys[other] = settings.keys[other].filter(x => x !== k); // one key → one action
      if (rb.i >= 0 && rb.i < settings.keys[rb.a].length) settings.keys[rb.a][rb.i] = k; else settings.keys[rb.a].push(k);
    }
    save(); renderSettings(); updateHUD(true);
  }

  function onSettingsChange(e) {
    const el = e.target.closest('[data-opt]');
    if (!el) return;
    const name = el.dataset.opt;
    if (name === 'cardMode') { settings.card.mode = el.value; settings.zoom = 1; save(); applySize(true); return; }
    if (name === 'cardW' || name === 'cardH') {
      const v = Math.max(name === 'cardW' ? 240 : 320, Math.min(4000, Math.round(+el.value || 0)));
      settings.card[name === 'cardW' ? 'w' : 'h'] = v; settings.card.mode = 'custom'; settings.zoom = 1;
      save(); applySize(true);
      const modeSel = ui.settings.querySelector('[data-opt="cardMode"]'); if (modeSel) modeSel.value = 'custom';
      return;
    }
    settings[name] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Math.max(0, +el.value || 0) : el.value;
    save(); applySettings();
  }

  function applySettings() {
    document.documentElement.classList.toggle('tpm-hide-tips', !!settings.hideNativeTips);
    document.documentElement.classList.toggle('tpm-focus', !!(settings.focus && onRecs()));
    if (settings.controller) startPad();
    updateHUD(true);
  }

  /* ═══════════════════════════════ 7. BOOT ═══════════════════════════════ */

  let regionSeen = false;
  function onDomChange() {
    updateHUD();
    if (!regionSeen && cardRegion()) {
      regionSeen = true;
      setTimeout(() => applySize(true), 600); // let Tinder's layout settle before measuring the stock size / column
    }
  }

  let resizeT = 0;
  window.addEventListener('resize', () => {
    clearTimeout(resizeT);
    resizeT = setTimeout(() => { zoomBase = null; applySize(true); }, 250); // fit follows the window; stock is re-measured
  });

  // At document-start <html> may not exist yet (Playwright init scripts, some Tampermonkey builds).
  function whenRootExists(fn) {
    if (document.documentElement) { fn(); return; }
    const mo = new MutationObserver(() => { if (document.documentElement) { mo.disconnect(); fn(); } });
    mo.observe(document, { childList: true });
  }

  function boot() {
    injectStyle();
    applySettings();
    const start = () => {
      ensureUI();
      updateHUD(true);
      new MutationObserver(guard(onDomChange)).observe(document.body, {
        subtree: true, childList: true, attributes: true, attributeFilter: ['aria-selected', 'aria-hidden', 'disabled', 'inert'],
      });
      onDomChange();
      if (settings.focus) setTimeout(() => toast('Focus mode ON — press F to exit'), 1200);
    };
    if (document.body) start(); else document.addEventListener('DOMContentLoaded', start, { once: true });
    // SPA route changes (recs ⇄ messages) don't reload the page
    for (const m of ['pushState', 'replaceState']) {
      const orig = history[m];
      history[m] = function () { const r = orig.apply(this, arguments); setTimeout(() => updateHUD(true), 60); return r; };
    }
    window.addEventListener('popstate', () => updateHUD(true));
  }

  whenRootExists(boot);
})();
