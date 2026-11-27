import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BOTTOM_NAV_ROUTES, TABS, activeTab, isKeyboardOpen, shouldShowBottomNav, tabDirection } from './navigation.ts';

const IMPLEMENTED_ROUTES = ['/home', '/claims', '/claims/new', '/ecard'];

test('every available tab maps to an implemented route; unsupported tabs are marked unavailable', () => {
  for (const t of TABS) {
    if (t.available) assert.ok(IMPLEMENTED_ROUTES.includes(t.key), `${t.key} must be an implemented route`);
    else assert.ok(!t.key.startsWith('/'), `${t.key} must not look like a navigable route`);
  }
  assert.deepEqual(TABS.filter((t) => !t.available).map((t) => t.label), ['Cá nhân']);
  assert.equal(TABS.filter((t) => t.raised).length, 1, 'exactly one raised centre action');
  assert.equal(TABS.findIndex((t) => t.raised), Math.floor(TABS.length / 2), 'raised action is centred');
});

test('bar shows only on tab roots; hidden on consent, FNOL, claim detail and EOB', () => {
  for (const p of BOTTOM_NAV_ROUTES) assert.equal(shouldShowBottomNav(p, false), true, p);
  for (const p of ['/', '/consent', '/consent/denied', '/claims/new', '/claims/abc', '/claims/abc/eob', '/home/x']) {
    assert.equal(shouldShowBottomNav(p, false), false, p);
  }
});

test('bar hides while the virtual keyboard is open (reference 160 px heuristic)', () => {
  assert.equal(isKeyboardOpen(844, 844), false);
  assert.equal(isKeyboardOpen(844, 700), false);
  assert.equal(isKeyboardOpen(844, 500), true);
  assert.equal(shouldShowBottomNav('/home', true), false);
});

test('active tab resolves only exact tab roots, never the raised action or nested routes', () => {
  assert.equal(activeTab('/home'), '/home');
  assert.equal(activeTab('/claims'), '/claims');
  assert.equal(activeTab('/ecard'), '/ecard');
  assert.equal(activeTab('/claims/new'), null);
  assert.equal(activeTab('/claims/abc'), null);
  assert.equal(activeTab('/consent'), null);
});

test('tab transition direction follows bar order', () => {
  assert.equal(tabDirection('/home', '/ecard'), 'forward');
  assert.equal(tabDirection('/ecard', '/claims'), 'backward');
  assert.equal(tabDirection('/claims', '/claims/new'), 'forward');
});
