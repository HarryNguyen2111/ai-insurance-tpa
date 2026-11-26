'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { EMPTY_STORE, MAX_PROTOTYPE_WORKSPACES, parseStore, serializeStore, STORE_KEY, type PrototypeStore, type PrototypeWorkspace } from '@/lib/prototype-store';
import {
  DEFAULT_THEME, normalizeProfile, themeCssVars, validateProfile, validateTheme,
  type FieldErrors, type WorkspaceLogo, type WorkspaceProfile, type WorkspaceTheme,
} from '@/lib/workspace-profile';

// PROTOTYPE ONLY: state lives in this browser's localStorage. No server, tenant,
// membership or permission is created; see docs/ai-specs/13-… for the real design.

export type MutationResult = { ok: true; id: string } | { ok: false; errors: FieldErrors; message: string };

interface WorkspaceCtx {
  loaded: boolean;
  workspaces: PrototypeWorkspace[];
  active: PrototypeWorkspace | null;
  create: (input: { profile: WorkspaceProfile; theme: WorkspaceTheme; logo: WorkspaceLogo | null }) => MutationResult;
  update: (id: string, expectedVersion: number, patch: Partial<Pick<PrototypeWorkspace, 'profile' | 'theme' | 'logo'>>) => MutationResult;
  setActive: (id: string) => void;
  remove: (id: string) => void;
  clearAll: () => void;
}

const Ctx = createContext<WorkspaceCtx | null>(null);

function readStore(): PrototypeStore {
  try {
    return parseStore(window.localStorage.getItem(STORE_KEY));
  } catch {
    return EMPTY_STORE;
  }
}

function writeStore(store: PrototypeStore): string | null {
  try {
    if (store.workspaces.length === 0) window.localStorage.removeItem(STORE_KEY);
    else window.localStorage.setItem(STORE_KEY, serializeStore(store));
    return null;
  } catch {
    return 'Bộ nhớ trình duyệt đầy hoặc bị chặn; không lưu được bản prototype.';
  }
}

const VAR_NAMES = Object.keys(themeCssVars({ ...DEFAULT_THEME, sidebarStyle: 'BRAND' }));

function applyTheme(theme: WorkspaceTheme) {
  const root = document.documentElement;
  for (const name of VAR_NAMES) root.style.removeProperty(name);
  for (const [name, value] of Object.entries(themeCssVars(theme))) root.style.setProperty(name, value);
  root.classList.toggle('dark', theme.mode === 'DARK');
  root.dataset.workspaceTheme = theme.primaryColor;
}

export function WorkspaceProvider({ children }: { children: ReactNode }) {
  const [store, setStore] = useState<PrototypeStore>(EMPTY_STORE);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    setStore(readStore());
    setLoaded(true);
    const onStorage = (e: StorageEvent) => { if (e.key === STORE_KEY || e.key === null) setStore(readStore()); };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const active = useMemo(() => store.workspaces.find(w => w.id === store.activeId) ?? null, [store]);

  useEffect(() => {
    if (loaded) applyTheme(active?.theme ?? DEFAULT_THEME);
  }, [active, loaded]);

  const commit = useCallback((next: PrototypeStore): string | null => {
    const error = writeStore(next);
    if (!error) setStore(next);
    return error;
  }, []);

  const create = useCallback<WorkspaceCtx['create']>(({ profile, theme, logo }) => {
    const current = readStore();
    if (current.workspaces.length >= MAX_PROTOTYPE_WORKSPACES) {
      return { ok: false, errors: {}, message: `Prototype giới hạn ${MAX_PROTOTYPE_WORKSPACES} tổ chức trên trình duyệt này.` };
    }
    const normalized = normalizeProfile(profile);
    const errors = { ...validateProfile(normalized, new Set(current.workspaces.map(w => w.profile.slug))), ...validateTheme(theme).errors };
    if (Object.keys(errors).length > 0) return { ok: false, errors, message: 'Thông tin chưa hợp lệ.' };
    const now = new Date().toISOString();
    const ws: PrototypeWorkspace = { id: crypto.randomUUID(), profile: normalized, theme: { ...theme, primaryColor: theme.primaryColor.toLowerCase() }, logo, version: 1, createdAt: now, updatedAt: now };
    const error = commit({ schema: 1, activeId: ws.id, workspaces: [...current.workspaces, ws] });
    return error ? { ok: false, errors: {}, message: error } : { ok: true, id: ws.id };
  }, [commit]);

  const update = useCallback<WorkspaceCtx['update']>((id, expectedVersion, patch) => {
    const current = readStore();
    const target = current.workspaces.find(w => w.id === id);
    if (!target) return { ok: false, errors: {}, message: 'Không tìm thấy tổ chức.' };
    if (target.version !== expectedVersion) {
      return { ok: false, errors: {}, message: 'Tổ chức vừa được thay đổi ở tab khác. Hãy tải lại trước khi lưu.' };
    }
    const profile = patch.profile ? normalizeProfile(patch.profile) : target.profile;
    const theme = patch.theme ? { ...patch.theme, primaryColor: patch.theme.primaryColor.toLowerCase() } : target.theme;
    const taken = new Set(current.workspaces.filter(w => w.id !== id).map(w => w.profile.slug));
    const errors = { ...validateProfile(profile, taken), ...validateTheme(theme).errors };
    if (Object.keys(errors).length > 0) return { ok: false, errors, message: 'Thông tin chưa hợp lệ.' };
    const next: PrototypeWorkspace = {
      ...target, profile, theme, logo: patch.logo === undefined ? target.logo : patch.logo,
      version: target.version + 1, updatedAt: new Date().toISOString(),
    };
    const error = commit({ ...current, workspaces: current.workspaces.map(w => (w.id === id ? next : w)) });
    return error ? { ok: false, errors: {}, message: error } : { ok: true, id };
  }, [commit]);

  const setActive = useCallback((id: string) => {
    const current = readStore();
    if (current.workspaces.some(w => w.id === id)) commit({ ...current, activeId: id });
  }, [commit]);

  const remove = useCallback((id: string) => {
    const current = readStore();
    const workspaces = current.workspaces.filter(w => w.id !== id);
    commit({ schema: 1, activeId: current.activeId === id ? workspaces[0]?.id ?? null : current.activeId, workspaces });
  }, [commit]);

  const clearAll = useCallback(() => { commit(EMPTY_STORE); }, [commit]);

  const value = useMemo(() => ({ loaded, workspaces: store.workspaces, active, create, update, setActive, remove, clearAll }),
    [loaded, store.workspaces, active, create, update, setActive, remove, clearAll]);
  return <Ctx value={value}>{children}</Ctx>;
}

export function useWorkspaces(): WorkspaceCtx {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error('WorkspaceProvider missing');
  return ctx;
}
