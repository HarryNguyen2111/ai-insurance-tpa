import assert from 'node:assert/strict';
import test from 'node:test';
import { EMPTY_STORE, MAX_PROTOTYPE_WORKSPACES, parseStore, serializeStore, type PrototypeWorkspace } from './prototype-store.ts';

const ws = (n: number, extra: Partial<PrototypeWorkspace> = {}): PrototypeWorkspace => ({
  id: `00000000-0000-4000-8000-00000000000${n}`,
  profile: { displayName: `Tổ chức mẫu ${n}`, shortName: `TC${n}`, slug: `to-chuc-${n}`, orgType: 'INSURER', description: '' },
  theme: { primaryColor: '#0F766E', radius: 'MD', mode: 'LIGHT', sidebarStyle: 'LIGHT' },
  logo: null, version: 1, createdAt: '2026-11-26T04:00:00.000Z', updatedAt: '2026-11-26T04:00:00.000Z', ...extra,
});

const logo = { mime: 'image/png', dataUrl: 'data:image/png;base64,iVBORw0KGgo=', width: 128, height: 128, bytes: 1200 };

test('round-trips a valid store and normalises colour case', () => {
  const store = parseStore(serializeStore({ schema: 1, activeId: ws(2).id, workspaces: [ws(1), ws(2, { logo: logo as never })] }));
  assert.equal(store.workspaces.length, 2);
  assert.equal(store.activeId, ws(2).id);
  assert.equal(store.workspaces[0]!.theme.primaryColor, '#0f766e');
  assert.equal(store.workspaces[1]!.logo?.mime, 'image/png');
});

test('missing, corrupt or foreign-schema data yields an empty store', () => {
  assert.deepEqual(parseStore(null), EMPTY_STORE);
  assert.deepEqual(parseStore('{not json'), EMPTY_STORE);
  assert.deepEqual(parseStore('{"schema":2,"workspaces":[]}'), EMPTY_STORE);
  assert.deepEqual(parseStore('[]'), EMPTY_STORE);
});

test('tampered entries are dropped instead of rendered', () => {
  const bad = [
    ws(1, { profile: { ...ws(1).profile, displayName: '<img src=x onerror=alert(1)>' } }),
    ws(2, { theme: { ...ws(2).theme, primaryColor: 'red;}*{display:none' } }),
    ws(3, { logo: { ...logo, mime: 'image/svg+xml', dataUrl: 'data:image/svg+xml;base64,PHN2Zz4=' } as never }),
    ws(4, { logo: { ...logo, dataUrl: 'javascript:alert(1)' } as never }),
    ws(5, { id: 'not-a-uuid' }),
    ws(6, { logo: { ...logo, width: 10 } as never }),
  ];
  const store = parseStore(JSON.stringify({ schema: 1, activeId: ws(1).id, workspaces: [...bad, ws(7)] }));
  assert.deepEqual(store.workspaces.map(w => w.profile.slug), []);
});

test('duplicate slugs keep the first entry; active id falls back; list is capped', () => {
  const dup = ws(2, { profile: { ...ws(2).profile, slug: 'to-chuc-1' } });
  const store = parseStore(JSON.stringify({ schema: 1, activeId: 'gone', workspaces: [ws(1), dup] }));
  assert.deepEqual(store.workspaces.map(w => w.id), [ws(1).id]);
  assert.equal(store.activeId, ws(1).id);
  const many = Array.from({ length: 9 }, (_, i) => ws(i + 1));
  assert.equal(parseStore(JSON.stringify({ schema: 1, activeId: null, workspaces: many })).workspaces.length, MAX_PROTOTYPE_WORKSPACES);
});
