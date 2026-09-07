const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM, VirtualConsole, ResourceLoader } = require('jsdom');

const root = path.join(__dirname, '..');
const artifact = fs.readFileSync(path.join(root, 'tinder-power-mode.user.js'), 'utf8');
const script = artifact.replace(/\/\/ ==UserScript==[\s\S]*?\/\/ ==\/UserScript==\s*/, '');
const fixture = fs.readFileSync(path.join(__dirname, 'mock.html'), 'utf8');
class NoNetwork extends ResourceLoader {
  fetch(url) { throw new Error('Unexpected fixture network request: ' + url); }
}

// jsdom has no layout engine or hardware. Geometry and Gamepad API are deliberate
// fixture inputs. These checks exercise the shipped script's DOM behavior; browser
// layout, native Tinder event ordering and physical controllers require separate QA.
async function setup(t, options = {}) {
  const messages = [], errors = [], copies = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', error => errors.push(error.message));
  for (const method of ['log', 'debug', 'table', 'group', 'groupEnd', 'error']) vc.on(method, (...args) => messages.push(args));
  let now = 10000, frame = 0, pads = [];
  const frames = new Map();
  const dom = new JSDOM(options.html || fixture, {
    url: options.url || 'https://fixture.invalid/app/recs', runScripts: 'dangerously',
    pretendToBeVisual: true, resources: new NoNetwork(), virtualConsole: vc,
    beforeParse(w) {
      Object.defineProperty(w, 'innerWidth', { value: 1600, configurable: true });
      Object.defineProperty(w, 'innerHeight', { value: 1100, configurable: true });
      w.Date.now = () => now;
      w.requestAnimationFrame = fn => { frames.set(++frame, fn); return frame; };
      w.cancelAnimationFrame = id => frames.delete(id);
      w.navigator.getGamepads = () => pads;
      Object.defineProperty(w.navigator, 'clipboard', { value: { writeText: text => {
        if (options.clipboardReject) return Promise.reject(new Error('Clipboard blocked'));
        copies.push(text); return Promise.resolve();
      } } });
      w.HTMLElement.prototype.getClientRects = function () {
        let el = this;
        while (el) {
          if (el.hidden || el.style?.display === 'none' || el.style?.visibility === 'hidden') return [];
          el = el.parentElement;
        }
        return [this.getBoundingClientRect()];
      };
      w.HTMLElement.prototype.getBoundingClientRect = function () {
        let width = 480, height = 960;
        if (this.id === 'main-content') { width = 1225; height = 1100; }
        if (this.matches('[role="region"], #profileWrap')) {
          const applied = w.document.getElementById('tpm-zoom')?.textContent.match(/max-width:(\d+)px.*?height:(\d+)px/);
          if (applied) { width = +applied[1]; height = +applied[2]; }
        }
        return { x: 0, y: 0, top: 0, left: 0, right: width, bottom: height, width, height, toJSON() { return { width, height }; } };
      };
      if (options.settings) w.localStorage.setItem('tpm.settings.v1', JSON.stringify(options.settings));
    }
  });
  const w = dom.window, d = w.document;
  t.after(() => dom.window.close());
  if (!options.embedded) w.eval(script);
  async function flush() {
    for (let i = 0; i < 3; i++) {
      await Promise.resolve();
      const queue = [...frames.values()]; frames.clear();
      for (const fn of queue) fn(now);
    }
  }
  await flush();
  function key(key, extra = {}) {
    const code = extra.code || (key.length === 1 ? 'Key' + key.toUpperCase() : key);
    const event = new w.KeyboardEvent('keydown', { key, code, bubbles: true, cancelable: true, ...extra });
    (d.activeElement || d.body).dispatchEvent(event);
    (d.activeElement || d.body).dispatchEvent(new w.KeyboardEvent('keyup', { key, code, bubbles: true, cancelable: true, ...extra }));
    return event;
  }
  const click = selector => { const el = d.querySelector(selector); assert.ok(el, selector); el.click(); };
  return {
    w, d, key, click, flush, messages, errors, copies,
    advance(ms = 500) { now += ms; },
    clear() { w.__clicks.length = 0; w.__native.length = 0; },
    clicks: () => Array.from(w.__clicks), native: () => Array.from(w.__native),
    saved: () => JSON.parse(w.localStorage.getItem('tpm.settings.v1')),
    photo: (scope = '[data-keyboard-gamepad][aria-hidden="false"]') => [...d.querySelectorAll(scope + ' [role="tab"]')].findIndex(el => el.getAttribute('aria-selected') === 'true'),
    async pad(index, pressed) {
      if (!pads.length) pads = [{ index: 0, buttons: Array.from({ length: 16 }, () => ({ pressed: false, value: 0 })) }];
      pads[0].buttons[index] = { pressed, value: pressed ? 1 : 0 };
      const event = new w.Event('gamepadconnected'); event.gamepad = { id: 'Synthetic controller' };
      w.dispatchEvent(event); await flush();
    }
  };
}

test('HUD shows the active card, photos and available balance', async t => {
  const h = await setup(t);
  assert.match(h.d.querySelector('#tpm-hud').textContent, /Milo, 31/);
  assert.match(h.d.querySelector('#tpm-hud').textContent, /PHOTO 1\/9/);
  assert.match(h.d.querySelector('#tpm-hud').textContent, /★ 5/);
  assert.ok(h.d.documentElement.classList.contains('tpm-hide-tips'));
  assert.deepEqual(h.errors, []);
});

test('decision keys click once, stamp the action and suppress native arrow decisions', async t => {
  const h = await setup(t);
  for (const [key, label] of [['d', 'Like'], ['a', 'Nope'], ['s', 'Super Like'], ['r', 'Rewind']]) {
    h.key(key); h.advance();
    assert.equal(h.clicks().at(-1), label);
  }
  assert.deepEqual(h.native(), []);
  assert.equal(h.d.querySelector('#tpm-stamp .tpm-tx').textContent, 'REWIND');
});

test('cooldown suppresses rapid decisions and held decision keys', async t => {
  const h = await setup(t);
  h.key('d'); h.key('a'); h.key('d', { repeat: true });
  assert.deepEqual(h.clicks(), ['Like']);
  h.advance(); h.key('a');
  assert.deepEqual(h.clicks(), ['Like', 'Nope']);
});

test('disabled Rewind and exhausted Super Like never click purchase controls', async t => {
  const h = await setup(t);
  h.d.querySelector('.gamepad-button').disabled = true;
  const badge = h.d.querySelector('[aria-label="5 remaining"]'); badge.textContent = '0'; badge.setAttribute('aria-label', '0 remaining');
  h.key('r'); h.key('s'); await h.flush();
  assert.deepEqual(h.clicks(), []);
  assert.match(h.d.querySelector('#tpm-toasts').textContent, /No Super Likes left/);
  assert.ok(h.d.querySelector('#tpm-hud [data-action="superlike"]').classList.contains('off'));
});

test('Boost is unbound by default, and a bound zero-balance Boost remains guarded', async t => {
  const h = await setup(t, { settings: { keys: { boost: ['b'] } } });
  h.key('b');
  assert.deepEqual(h.clicks(), []);
  assert.match(h.d.querySelector('#tpm-toasts').textContent, /No Boosts left/);
});

test('arrows browse only the active card and wrap at either end', async t => {
  const h = await setup(t);
  h.key('ArrowRight'); h.key('ArrowRight'); h.key('ArrowLeft');
  assert.equal(h.photo(), 1);
  assert.deepEqual(h.native(), []);
  h.key('1'); h.key('ArrowLeft'); assert.equal(h.photo(), 8);
  h.key('ArrowRight'); assert.equal(h.photo(), 0);
  assert.equal(h.d.querySelector('[inert] [aria-selected="true"]').getAttribute('aria-label'), 'Photo 1');
});

test('fixed digit jumps and Shift+Space use the photo controls while native keys pass through', async t => {
  const h = await setup(t);
  h.key('5'); assert.equal(h.photo(), 4);
  h.key(' ', { shiftKey: true }); assert.equal(h.photo(), 3);
  for (const key of [' ', 'ArrowUp', 'ArrowDown', 'Enter']) h.key(key);
  assert.deepEqual(h.native(), ['next-photo', 'open-profile', 'close-profile', 'superlike']);
});

test('expanded profiles own navigation, decision targeting and Escape', async t => {
  const h = await setup(t);
  h.key('w'); h.key('ArrowRight'); h.key('3');
  assert.equal(h.photo('#profileWrap'), 2);
  assert.equal(h.photo(), 0);
  h.key('d');
  assert.equal(h.clicks().at(-1), 'P:Like');
  h.key('w'); h.key('Escape');
  assert.equal(h.clicks().at(-1), 'Back');
  h.clear(); h.key('Escape'); assert.deepEqual(h.native(), ['escape']);
});

test('typing in inputs, textareas and contenteditable blocks script shortcuts', async t => {
  const h = await setup(t);
  for (const html of ['<input>', '<textarea></textarea>', '<div contenteditable="true" tabindex="0"></div>']) {
    const container = h.d.createElement('div'); container.innerHTML = html; h.d.body.append(container);
    container.firstElementChild.focus(); h.key('d'); h.key('ArrowRight');
  }
  assert.deepEqual(h.clicks(), []);
});

test('external modal pauses decisions and removes the guard when dismissed', async t => {
  const h = await setup(t);
  const modal = h.d.createElement('div'); modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); h.d.body.append(modal);
  h.key('d'); assert.deepEqual(h.clicks(), []);
  modal.remove(); h.key('d'); assert.deepEqual(h.clicks(), ['Like']);
});

test('HUD mouse decisions must also obey the modal guard', async t => {
  const h = await setup(t);
  const modal = h.d.createElement('div'); modal.setAttribute('aria-modal', 'true'); h.d.body.append(modal);
  h.click('#tpm-hud [data-action="like"]');
  assert.deepEqual(h.clicks(), []);
});

test('remapping persists, removes the old binding and cannot steal fixed photo digits', async t => {
  const h = await setup(t);
  h.key('o'); h.click('[data-a="like"][data-i="0"]'); h.key('k');
  assert.deepEqual(h.saved().keys.like, ['k']);
  h.click('[data-a="like"][data-i="0"]'); h.key('3');
  assert.deepEqual(h.saved().keys.like, ['k']);
  h.key('Escape'); h.key('d'); assert.deepEqual(h.clicks(), []);
  h.key('k'); assert.deepEqual(h.clicks(), ['Like']);
});

test('options block stray decisions and Escape closes the panel first', async t => {
  const h = await setup(t);
  h.key('o'); h.key('d'); h.key('ArrowRight');
  assert.deepEqual(h.clicks(), []); assert.deepEqual(h.native(), []);
  h.key('Escape'); assert.ok(!h.d.querySelector('#tpm-settings').classList.contains('open'));
});

test('editing options fields keeps native form behavior without forwarding keys to the host', async t => {
  const h = await setup(t);
  h.key('o'); h.d.querySelector('[data-opt="cardW"]').focus();
  const arrow = h.key('ArrowRight'); h.key('Enter'); h.key('7');
  assert.equal(arrow.defaultPrevented, false);
  assert.deepEqual(h.clicks(), []); assert.deepEqual(h.native(), []);
  h.key('Escape'); assert.ok(!h.d.querySelector('#tpm-settings').classList.contains('open'));
  h.key('d'); assert.deepEqual(h.clicks(), ['Like']);
});

test('options have a named dialog, labeled fields, semantic key buttons and a Tab focus loop', async t => {
  const h = await setup(t);
  const invoker = h.d.createElement('button'); invoker.textContent = 'Invoker'; h.d.body.append(invoker); invoker.focus();
  h.key('o');
  const dialog = h.d.querySelector('#tpm-settings [role="dialog"]');
  assert.equal(h.d.activeElement, dialog); assert.equal(dialog.getAttribute('aria-modal'), 'true');
  assert.ok(h.d.getElementById(dialog.getAttribute('aria-labelledby')));
  for (const el of dialog.querySelectorAll('input,select')) assert.ok(el.getAttribute('aria-label'));
  for (const el of dialog.querySelectorAll('.tpm-key')) { assert.equal(el.tagName, 'BUTTON'); assert.ok(el.getAttribute('aria-label')); }
  assert.equal(dialog.querySelectorAll('button button').length, 0);
  h.key('Tab'); assert.equal(h.d.activeElement, dialog.querySelector('button'));
  h.key('Tab', { shiftKey: true }); assert.equal(h.d.activeElement.textContent, 'Done');
  h.key('Tab'); assert.equal(h.d.activeElement, dialog.querySelector('button'));
  h.key('Escape'); assert.equal(h.d.activeElement, invoker);
});

test('bindings can be remapped, cancelled, removed and added entirely with keyboard activation', async t => {
  const h = await setup(t); h.key('o');
  h.d.querySelector('#tpm-key-like-0').focus(); h.key('Enter'); h.key('k');
  assert.deepEqual(h.saved().keys.like, ['k']); assert.equal(h.d.activeElement.id, 'tpm-key-like-0');
  h.key('Enter'); h.key('Escape'); assert.ok(h.d.querySelector('#tpm-settings').classList.contains('open'));
  h.d.querySelector('[data-a="like"][data-del]').focus(); h.key(' '); assert.deepEqual(h.saved().keys.like, []);
  h.d.querySelector('#tpm-key-like-add').focus(); h.key('Enter'); h.key('d'); assert.deepEqual(h.saved().keys.like, ['d']);
});

test('focus persists and restores the sidebar on a non-card route', async t => {
  const h = await setup(t);
  h.key('f'); assert.equal(h.saved().focus, true);
  assert.ok(h.d.documentElement.classList.contains('tpm-focus'));
  h.d.querySelector('[aria-label="Card stack"]').remove();
  h.w.history.pushState({}, '', '/app/messages/fake-thread');
  h.key('h'); await h.flush();
  assert.ok(!h.d.documentElement.classList.contains('tpm-focus'));
  assert.ok(h.d.querySelector('#tpm-hud').classList.contains('tpm-off'));
});

test('card fit, custom resize, zoom and stock reset persist valid settings', async t => {
  const h = await setup(t);
  h.key('x'); assert.equal(h.saved().card.mode, 'fit');
  assert.match(h.d.querySelector('#tpm-zoom').textContent, /height:1028px/);
  h.key('ArrowRight', { shiftKey: true }); assert.equal(h.saved().card.mode, 'custom');
  const width = h.saved().card.w;
  h.key('ArrowRight', { shiftKey: true }); assert.equal(h.saved().card.w, width + 32);
  h.key('+'); assert.equal(h.saved().zoom, 1.1);
  h.key('0'); assert.equal(h.saved().card.mode, 'stock'); assert.equal(h.saved().zoom, 1);
  assert.equal(h.d.querySelector('#tpm-zoom').textContent, '');
});

test('HUD cycles full, mini, off and Reset defaults also clears focus and remaps', async t => {
  const h = await setup(t);
  h.key('h'); await h.flush(); assert.ok(h.d.querySelector('#tpm-hud').classList.contains('tpm-mini'));
  h.key('h'); await h.flush(); assert.ok(h.d.querySelector('#tpm-hud').classList.contains('tpm-off'));
  h.key('h'); h.key('f'); h.key('o');
  h.click('[data-a="like"][data-i="0"]'); h.key('k');
  h.click('#tpm-settings [data-act="reset"]');
  assert.equal(h.saved().focus, false); assert.deepEqual(h.saved().keys.like, ['d']);
  assert.equal(h.saved().hudMode, 'full'); assert.equal(h.saved().card.mode, 'fit');
});

test('controller fixture fires only on button edges and supports photo navigation', async t => {
  const h = await setup(t);
  await h.pad(0, true); await h.flush(); assert.deepEqual(h.clicks(), ['Like']);
  h.advance(); await h.pad(0, false); await h.pad(0, true); assert.deepEqual(h.clicks(), ['Like', 'Like']);
  await h.pad(5, true); assert.equal(h.photo(), 1);
});

test('controller ignores typing fields, options and blocking modals', async t => {
  const h = await setup(t);
  h.d.querySelector('#search').focus(); await h.pad(0, true); assert.deepEqual(h.clicks(), []);
  h.d.activeElement.blur(); await h.pad(0, false);
  h.key('o'); await h.pad(0, true); assert.deepEqual(h.clicks(), []);
  h.key('Escape'); await h.pad(0, false);
  const modal = h.d.createElement('div'); modal.setAttribute('aria-modal', 'true'); h.d.body.append(modal);
  await h.pad(0, true); assert.deepEqual(h.clicks(), []);
});

test('empty deck does not click lingering decision controls', async t => {
  const h = await setup(t);
  h.d.querySelector('#cards').innerHTML = '<output class="beacon" aria-busy="true"></output>';
  h.key('d'); h.key('ArrowRight'); await h.flush();
  assert.deepEqual(h.clicks(), []);
  assert.match(h.d.querySelector('#tpm-hud').textContent, /NO CARD/);
});

test('diagnostics exclude private page data, URL fragments, settings strings and DOM objects', async t => {
  const secret = 'PRIVATE_SENTINEL_7F9';
  const h = await setup(t, {
    html: fixture.replaceAll('Milo', secret).replaceAll('31', '987654321'),
    url: 'https://fixture.invalid/app/recs/' + secret + '?token=' + secret + '#'+ secret,
    settings: { card: { mode: 'custom', w: secret, h: secret } }
  });
  const other = h.d.createElement('button'); other.setAttribute('aria-label', secret); other.title = secret; other.className = secret; other.innerHTML = '<span class="Hidden">' + secret + '</span>'; h.d.body.append(other);
  h.d.querySelector('[aria-label="Card stack"]').style.setProperty('--recs-card-width', secret);
  h.key('p'); await h.flush();
  const report = JSON.parse(h.copies[0]);
  assert.equal(report.version, '1.1.2'); assert.equal(report.state.photoCount, 9);
  assert.deepEqual(Object.keys(report), ['version', 'state', 'layout', 'actions', 'reasons']);
  const output = JSON.stringify([h.messages, h.copies]);
  for (const denied of [secret, '987654321', 'fixture.invalid', '/app/recs', 'ariaLabel', 'hiddenText', 'outerHTML', 'className']) assert.ok(!output.includes(denied), denied);
  for (const args of h.messages) for (const value of args) assert.equal(typeof value, 'string');
  h.key('w'); h.key('p'); await h.flush();
  assert.equal(JSON.parse(h.copies[1]).state.profileOpen, true);
  assert.ok(!JSON.stringify([h.messages, h.copies]).includes(secret));
});

test('diagnostics report a blocked clipboard honestly and remain available in console', async t => {
  const h = await setup(t, { clipboardReject: true });
  h.key('p'); await h.flush();
  assert.equal(h.copies.length, 0);
  assert.match(h.d.querySelector('#tpm-toasts').textContent, /Clipboard unavailable/);
  assert.match(h.messages.flat().join(' '), /sanitized diagnostics/);
});

test('handler failures never log exception payloads or profile data', async t => {
  const h = await setup(t);
  const like = [...h.d.querySelectorAll('.gamepad-button')].find(el => el.textContent.trim() === 'Like');
  like.click = () => { throw new Error('PRIVATE_EXCEPTION_SENTINEL'); };
  h.key('d');
  assert.match(h.messages.flat().join(' '), /Handler failed/);
  assert.ok(!JSON.stringify(h.messages).includes('PRIVATE_EXCEPTION_SENTINEL'));
  assert.deepEqual(h.errors, []);
});

test('Pages distributes the exact source artifact and embeds the real script once', () => {
  const page = fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8');
  assert.equal(fs.readFileSync(path.join(root, 'docs/tinder-power-mode.user.js'), 'utf8'), artifact);
  assert.equal(page.split(script).length, 2);
  assert.ok(fs.existsSync(path.join(root, 'docs/.nojekyll')));
  assert.ok(!page.includes('/*__USERSCRIPT__*/'));
  assert.ok(!/fonts\.googleapis|google\.com\/s2\/favicons|YOUR-GITHUB|fetch\(|XMLHttpRequest|WebSocket\(|sendBeacon\(/.test(page));
  assert.match(artifact, /@downloadURL\s+https:\/\/Ademord.github.io\/tinder-power-mode\/tinder-power-mode.user.js/);
});

test('built demo boots without external resources, advances photos and simulates guarded credits', async t => {
  const h = await setup(t, { html: fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8'), embedded: true });
  assert.deepEqual(h.errors, []);
  assert.equal(h.photo(), 0);
  h.key('ArrowRight'); assert.equal(h.photo(), 1);
  h.click('#empty-credits');
  const name = h.d.querySelector('[aria-hidden="false"] [itemprop="name"]').textContent;
  h.key('s');
  assert.equal(h.d.querySelector('[aria-hidden="false"] [itemprop="name"]').textContent, name);
  assert.match(h.d.querySelector('#tpm-toasts').textContent, /No Super Likes left/);
  assert.equal(h.d.querySelector('#play').textContent, '▶ Play tour');
});

test('demo Options works when HUD and its keyboard binding are disabled', async t => {
  const h = await setup(t, {
    html: fs.readFileSync(path.join(root, 'docs/index.html'), 'utf8'), embedded: true,
    settings: { hudMode: 'off', keys: { settings: [] } }
  });
  h.click('#options');
  assert.ok(h.d.querySelector('#tpm-settings').classList.contains('open'));
});
