// Browser-only persistence for the onboarding PROTOTYPE. It is not a tenant, not a
// membership and not server data. Everything read back is re-validated; anything
// invalid is dropped rather than rendered.
import {
  LIMITS,
  LOGO_MIME_TYPES,
  validateLogoDimensions,
  validateProfile,
  validateTheme,
  type WorkspaceLogo,
  type WorkspaceProfile,
  type WorkspaceTheme,
} from './workspace-profile.ts';

export const STORE_KEY = 'tpa.prototype.workspaces.v1';
export const MAX_PROTOTYPE_WORKSPACES = 5;

export interface PrototypeWorkspace {
  id: string;
  profile: WorkspaceProfile;
  theme: WorkspaceTheme;
  logo: WorkspaceLogo | null;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface PrototypeStore {
  schema: 1;
  activeId: string | null;
  workspaces: PrototypeWorkspace[];
}

export const EMPTY_STORE: PrototypeStore = { schema: 1, activeId: null, workspaces: [] };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
// base64 length ≈ bytes * 4/3; allow the header and padding.
const MAX_DATA_URL = Math.ceil((LIMITS.logoBytes * 4) / 3) + 64;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseLogo(v: unknown): WorkspaceLogo | null | undefined {
  if (v === null) return null;
  if (!isRecord(v)) return undefined;
  const { mime, dataUrl, width, height, bytes } = v;
  if (typeof mime !== 'string' || !(LOGO_MIME_TYPES as readonly string[]).includes(mime)) return undefined;
  if (typeof dataUrl !== 'string' || dataUrl.length > MAX_DATA_URL || !dataUrl.startsWith(`data:${mime};base64,`)) return undefined;
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(dataUrl.slice(`data:${mime};base64,`.length))) return undefined;
  if (typeof width !== 'number' || typeof height !== 'number' || typeof bytes !== 'number') return undefined;
  if (validateLogoDimensions(width, height) || bytes <= 0 || bytes > LIMITS.logoBytes) return undefined;
  return { mime: mime as WorkspaceLogo['mime'], dataUrl, width, height, bytes };
}

function parseWorkspace(v: unknown, takenSlugs: Set<string>): PrototypeWorkspace | null {
  if (!isRecord(v) || !isRecord(v.profile) || !isRecord(v.theme)) return null;
  const { id, version, createdAt, updatedAt } = v;
  if (typeof id !== 'string' || !UUID.test(id)) return null;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) return null;
  if (typeof createdAt !== 'string' || !ISO.test(createdAt) || typeof updatedAt !== 'string' || !ISO.test(updatedAt)) return null;
  const p = v.profile;
  const profile = {
    displayName: p.displayName, shortName: p.shortName, slug: p.slug, orgType: p.orgType, description: p.description,
  } as WorkspaceProfile;
  if (Object.values(profile).some(x => typeof x !== 'string')) return null;
  if (Object.keys(validateProfile(profile, takenSlugs)).length > 0) return null;
  const t = v.theme;
  const theme = { primaryColor: t.primaryColor, radius: t.radius, mode: t.mode, sidebarStyle: t.sidebarStyle } as WorkspaceTheme;
  if (typeof theme.primaryColor !== 'string' || Object.keys(validateTheme(theme).errors).length > 0) return null;
  const logo = parseLogo(v.logo);
  if (logo === undefined) return null;
  takenSlugs.add(profile.slug);
  return { id, profile, theme: { ...theme, primaryColor: theme.primaryColor.toLowerCase() }, logo, version, createdAt, updatedAt };
}

export function parseStore(raw: string | null): PrototypeStore {
  if (raw === null) return EMPTY_STORE;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return EMPTY_STORE;
  }
  if (!isRecord(data) || data.schema !== 1 || !Array.isArray(data.workspaces)) return EMPTY_STORE;
  const taken = new Set<string>();
  const workspaces = data.workspaces
    .slice(0, MAX_PROTOTYPE_WORKSPACES)
    .map(w => parseWorkspace(w, taken))
    .filter((w): w is PrototypeWorkspace => w !== null);
  const activeId = typeof data.activeId === 'string' && workspaces.some(w => w.id === data.activeId)
    ? data.activeId
    : workspaces[0]?.id ?? null;
  return { schema: 1, activeId, workspaces };
}

export function serializeStore(store: PrototypeStore): string {
  return JSON.stringify(store);
}
