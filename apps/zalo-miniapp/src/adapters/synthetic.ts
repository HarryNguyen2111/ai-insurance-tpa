/**
 * SYNTHETIC in-memory WorkspacePort (issue #106). No network, no storage, no real API: every "response" is
 * a fixture behind a timer. Scenario knobs exist so the prototype and tests can reproduce membership counts,
 * slow/late responses, failures, offline, revocation and a branding update. All are labelled in the UI.
 *
 * URL scenario (read once at start; e.g. `/?members=2&slow=BM&start=PERSONAL`):
 *   members=0|1|2|3     how many synthetic memberships the principal has (default 3)
 *   start=PERSONAL|AB|BM|CT  remembered preference to re-authorise at start (default AB)
 *   slow=BM             responses for that workspace take SLOW_MS and IGNORE abort (a late response that
 *                       still arrives) — the switcher's generation guard must drop it
 *   badtheme=CT         that workspace's theme payload is invalid → neutral fallback
 *   latency=<ms>        base latency (default 120)
 */
import { PortError, type ServiceKey, type WorkspaceMembership, type WorkspacePort } from './ports.ts';
import {
  SYNTHETIC_LOYALTY,
  SYNTHETIC_MEMBERSHIPS,
  SYNTHETIC_PERSONAL_LOYALTY,
  SYNTHETIC_PROFILE,
  SYNTHETIC_THEMES,
  SYNTHETIC_TPA,
} from '../fixtures/workspaces.ts';
import { PERSONAL, type ContextId } from '../lib/context-ring.ts';

export const SLOW_MS = 1500;

export type Scenario = {
  members: 0 | 1 | 2 | 3;
  start: ContextId | null;
  slow: Set<string>;
  badTheme: Set<string>;
  latencyMs: number;
};

const ORDER = ['A', 'B', 'C'] as const;
const byShort = (s: string) => Object.values(SYNTHETIC_MEMBERSHIPS).find((m) => m.workspace.shortName === s.toUpperCase());

export function parseScenario(search: string): Scenario {
  const q = new URLSearchParams(search);
  const n = Number(q.get('members') ?? '3');
  const members = ([0, 1, 2, 3] as const).find((x) => x === n) ?? 3;
  const startRaw = q.get('start') ?? 'AB';
  const start = startRaw.toUpperCase() === PERSONAL ? PERSONAL : (byShort(startRaw)?.membershipId ?? null);
  const ids = (k: string) => new Set((q.get(k) ?? '').split(',').filter(Boolean).flatMap((s) => byShort(s)?.membershipId ?? []));
  const latency = Number(q.get('latency') ?? '120');
  return { members, start, slow: ids('slow'), badTheme: ids('badtheme'), latencyMs: Number.isFinite(latency) ? Math.max(0, Math.min(5000, latency)) : 120 };
}

/** Runtime switches shown (and labelled) on the Personal screen's prototype panel. */
export type Controls = {
  offline: boolean;
  failNextSwitch: boolean;
  revoked: Set<string>;
  /** membershipIds whose branding was updated by an (imaginary) authorised admin → version + 1. */
  brandingBumped: Set<string>;
};

function delay<T>(ms: number, signal: AbortSignal, honourAbort: boolean, value: () => T): Promise<T> {
  return new Promise((resolve, reject) => {
    if (honourAbort && signal.aborted) return reject(new PortError('ABORTED'));
    const t = setTimeout(() => {
      try {
        resolve(value());
      } catch (e) {
        reject(e);
      }
    }, ms);
    if (honourAbort) {
      signal.addEventListener('abort', () => {
        clearTimeout(t);
        reject(new PortError('ABORTED'));
      }, { once: true });
    }
  });
}

export class SyntheticWorkspaceAdapter implements WorkspacePort {
  readonly scenario: Scenario;
  readonly controls: Controls = { offline: false, failNextSwitch: false, revoked: new Set(), brandingBumped: new Set() };

  constructor(scenario: Scenario) {
    this.scenario = scenario;
  }

  private wait<T>(membershipId: string | null, signal: AbortSignal, value: () => T): Promise<T> {
    const slow = membershipId !== null && this.scenario.slow.has(membershipId);
    return delay(slow ? SLOW_MS : this.scenario.latencyMs, signal, !slow, () => {
      if (this.controls.offline) throw new PortError('OFFLINE');
      return value();
    });
  }

  private granted(): WorkspaceMembership[] {
    return ORDER.slice(0, this.scenario.members)
      .map((k) => SYNTHETIC_MEMBERSHIPS[k])
      .filter((m) => !this.controls.revoked.has(m.membershipId))
      .map((m) =>
        this.controls.brandingBumped.has(m.membershipId)
          ? { ...m, workspace: { ...m.workspace, brandingVersion: m.workspace.brandingVersion + 1 } }
          : m,
      );
  }

  listMemberships(signal: AbortSignal) {
    return this.wait(null, signal, () => ({ profile: SYNTHETIC_PROFILE, memberships: this.granted() }));
  }

  selectMembership(membershipId: string, signal: AbortSignal) {
    return this.wait(membershipId, signal, () => {
      if (this.controls.failNextSwitch) {
        this.controls.failNextSwitch = false;
        throw new PortError('ERROR');
      }
      if (!this.granted().some((m) => m.membershipId === membershipId)) throw new PortError('FORBIDDEN');
      return { membershipId, expiresAt: '2026-11-27T23:59:59Z', contextToken: `synthetic-opaque-${membershipId.slice(-3)}` };
    });
  }

  getTheme(ctx: { membershipId: string }, brandingVersion: number, signal: AbortSignal) {
    return this.wait(ctx.membershipId, signal, () => {
      if (this.scenario.badTheme.has(ctx.membershipId)) return { primaryColor: 'red', radius: 'MD', mode: 'LIGHT', sidebarStyle: 'LIGHT' } as const;
      const t = SYNTHETIC_THEMES[`${ctx.membershipId}:${brandingVersion}`];
      if (!t) throw new PortError('ERROR');
      return t;
    });
  }

  getTenantSnapshot(ctx: { membershipId: string }, services: ServiceKey[], signal: AbortSignal) {
    return this.wait(ctx.membershipId, signal, () => ({
      tpa: services.includes('TPA_INSURANCE') ? (SYNTHETIC_TPA[ctx.membershipId] ?? null) : null,
      loyalty: services.includes('LOYALTY360') ? (SYNTHETIC_LOYALTY[ctx.membershipId] ?? null) : null,
    }));
  }

  getPersonalLoyalty(signal: AbortSignal) {
    return this.wait(null, signal, () => SYNTHETIC_PERSONAL_LOYALTY);
  }
}
