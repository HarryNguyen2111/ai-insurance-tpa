/**
 * Coordinated context switch (issue #106 Deliverables B/C + theme acceptance).
 *
 * One transition = membership re-authorisation + theme + service data, committed together or not at all:
 *
 *   ready(A) ──switchTo(B)──▶ switching(B)  [A's data/theme dropped at once; neutral theme; target name only]
 *        switching(B) ──select ✓ theme ✓ data ✓ (same generation)──▶ ready(B)   [label+theme+data at once]
 *        switching(B) ──403──▶ authoritative membership refresh ──▶ failed(B, REVOKED)  [B leaves the ring]
 *        switching(B) ──offline/error──▶ failed(B, OFFLINE|ERROR)  [neutral; retry or return explicitly]
 *        switching(B) ──switchTo(C)──▶ switching(C)  [B aborted; any late B response is counted + dropped]
 *
 * Every await is followed by a generation check, so a delayed response from an older switch can never
 * paint data, label or colour. Failure never auto-advances to another tenant. Nothing here is persisted:
 * context tokens, snapshots and the theme cache live in memory only.
 */
import {
  PortError,
  type MembershipContext,
  type PersonalLoyaltyHome,
  type PersonalProfile,
  type TenantSnapshot,
  type WorkspaceMembership,
  type WorkspacePort,
} from '../adapters/ports.ts';
import { PERSONAL, contextRing, nextInRing, quickSwitchEnabled, type ContextId } from './context-ring.ts';
import { NEUTRAL_THEME, deriveTenantTheme, themeCacheKey, type DerivedTheme } from './theme.ts';

export type ActiveContext =
  | { kind: 'PERSONAL'; id: typeof PERSONAL; loyalty: PersonalLoyaltyHome; theme: DerivedTheme }
  | {
      kind: 'TENANT';
      id: string;
      membership: WorkspaceMembership;
      context: MembershipContext;
      theme: DerivedTheme;
      /** true when the theme payload was invalid/missing and the neutral theme is shown instead. */
      themeFallback: boolean;
      snapshot: TenantSnapshot;
    };

export type FailureReason = 'REVOKED' | 'OFFLINE' | 'ERROR' | 'NOT_FOUND';

export type SwitchState =
  | { phase: 'idle'; generation: number }
  | { phase: 'switching'; generation: number; target: ContextId; targetLabel: string; from: ContextId | null }
  | { phase: 'ready'; generation: number; active: ActiveContext; from: ContextId | null }
  | { phase: 'failed'; generation: number; target: ContextId; targetLabel: string; reason: FailureReason; from: ContextId | null };

export type SwitchResult = 'committed' | 'stale' | 'failed' | 'ignored';

export const PERSONAL_LABEL = 'Loyalty360 cá nhân';

export class ContextSwitcher {
  private port: WorkspacePort;
  private now: () => number;
  private listeners = new Set<() => void>();
  private controller: AbortController | null = null;
  private themeCache = new Map<string, DerivedTheme>();
  private generation = 0;
  private lastCommitted: ContextId | null = null;

  state: SwitchState = { phase: 'idle', generation: 0 };
  memberships: WorkspaceMembership[] = [];
  profile: PersonalProfile | null = null;
  /** Late responses from superseded switches that were dropped (observable for tests/perf notes). */
  staleDropped = 0;
  /** Duration of the last committed switch in ms (synthetic adapter latency; not an SLA). */
  lastSwitchMs: number | null = null;

  constructor(port: WorkspacePort, now: () => number = () => Date.now()) {
    this.port = port;
    this.now = now;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  private emit(next: SwitchState) {
    this.state = next;
    this.listeners.forEach((fn) => fn());
  }

  get ring(): ContextId[] {
    return contextRing(this.memberships);
  }

  get activeId(): ContextId | null {
    return this.state.phase === 'ready' ? this.state.active.id : null;
  }

  label(id: ContextId): string {
    if (id === PERSONAL) return PERSONAL_LABEL;
    return this.memberships.find((m) => m.membershipId === id)?.workspace.displayName ?? 'Đơn vị không còn khả dụng';
  }

  themeCacheKeys(): string[] {
    return [...this.themeCache.keys()];
  }

  /** Authoritative membership list. Evicts theme cache entries of memberships/versions no longer current. */
  async refreshMemberships(signal?: AbortSignal): Promise<void> {
    const res = await this.port.listMemberships(signal ?? new AbortController().signal);
    this.profile = res.profile;
    this.memberships = res.memberships;
    const current = new Set(res.memberships.map((m) => themeCacheKey(m.membershipId, m.workspace.brandingVersion)));
    for (const k of [...this.themeCache.keys()]) if (!current.has(k)) this.themeCache.delete(k);
    // Active tenant revoked server-side → leave it explicitly (clears its data/theme), never pick another.
    const s = this.state;
    if (s.phase === 'ready' && s.active.kind === 'TENANT' && !res.memberships.some((m) => m.membershipId === s.active.id)) {
      this.generation += 1;
      this.controller?.abort();
      this.emit({ phase: 'failed', generation: this.generation, target: s.active.id, targetLabel: s.active.membership.workspace.displayName, reason: 'REVOKED', from: null });
    } else {
      this.emit({ ...this.state });
    }
  }

  /** Startup: load the authoritative list, then re-authorise the remembered preference (or go personal). */
  async init(preferred: ContextId | null): Promise<SwitchResult> {
    try {
      await this.refreshMemberships();
    } catch {
      this.emit({ phase: 'failed', generation: ++this.generation, target: PERSONAL, targetLabel: PERSONAL_LABEL, reason: 'OFFLINE', from: null });
      return 'failed';
    }
    const target = preferred && this.ring.includes(preferred) ? preferred : PERSONAL;
    return this.switchTo(target);
  }

  /** Double-tap: one step along the stable ring. Bounded: ignored while a switch is in flight. */
  quickSwitch(): Promise<SwitchResult> {
    if (this.state.phase === 'switching' || !quickSwitchEnabled(this.ring)) return Promise.resolve('ignored');
    return this.switchTo(nextInRing(this.ring, this.activeId ?? this.lastCommitted));
  }

  /** Explicit choice (sheet). Supersedes any in-flight switch. */
  async switchTo(target: ContextId): Promise<SwitchResult> {
    const generation = ++this.generation;
    this.controller?.abort();
    const controller = new AbortController();
    this.controller = controller;
    const { signal } = controller;
    const from = this.activeId ?? this.lastCommitted;
    const targetLabel = this.label(target);
    const started = this.now();
    // Prior tenant content and colour are dropped immediately; only the target NAME is shown.
    this.emit({ phase: 'switching', generation, target, targetLabel, from });
    const stale = () => {
      if (generation === this.generation) return false;
      this.staleDropped += 1;
      this.emit({ ...this.state }); // same state, re-published so observers see the drop counter
      return true;
    };

    try {
      let active: ActiveContext;
      if (target === PERSONAL) {
        const loyalty = await this.port.getPersonalLoyalty(signal);
        if (stale()) return 'stale';
        active = { kind: 'PERSONAL', id: PERSONAL, loyalty, theme: NEUTRAL_THEME };
      } else {
        const membership = this.memberships.find((m) => m.membershipId === target);
        if (!membership) {
          this.emit({ phase: 'failed', generation, target, targetLabel, reason: 'NOT_FOUND', from });
          return 'failed';
        }
        const context = await this.port.selectMembership(target, signal);
        if (stale()) return 'stale';
        const key = themeCacheKey(target, membership.workspace.brandingVersion);
        let theme = this.themeCache.get(key);
        let themeFallback = false;
        if (!theme) {
          const payload = await this.port.getTheme(context, membership.workspace.brandingVersion, signal);
          if (stale()) return 'stale';
          const derived = deriveTenantTheme(payload?.primaryColor);
          if (derived) this.themeCache.set(key, derived);
          theme = derived ?? NEUTRAL_THEME;
          themeFallback = !derived;
        }
        const snapshot = await this.port.getTenantSnapshot(context, membership.services, signal);
        if (stale()) return 'stale';
        active = { kind: 'TENANT', id: target, membership, context, theme, themeFallback, snapshot };
      }
      this.lastCommitted = target;
      this.lastSwitchMs = this.now() - started;
      this.emit({ phase: 'ready', generation, active, from });
      return 'committed';
    } catch (e) {
      if (stale()) return 'stale';
      const code = e instanceof PortError ? e.code : 'ERROR';
      if (code === 'ABORTED') return 'stale';
      let reason: FailureReason = code === 'OFFLINE' ? 'OFFLINE' : 'ERROR';
      if (code === 'FORBIDDEN') {
        reason = 'REVOKED';
        try {
          await this.refreshMemberships(); // authoritative state decides; the ring drops the revoked entry
        } catch {
          /* keep REVOKED; list refresh failure is shown on next attempt */
        }
        if (generation !== this.generation) return 'stale';
      }
      this.emit({ phase: 'failed', generation, target, targetLabel, reason, from });
      return 'failed';
    }
  }
}
