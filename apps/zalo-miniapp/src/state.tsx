import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import { CONSENT_POLICY, buildConsentRequest, canSubmitClaim, type ConsentDecision, type ConsentRequest } from './lib/consent.ts';
import type { RuntimeKind } from './lib/platform.ts';
import { SYNTHETIC_MEMBER_ID } from './fixtures/synthetic.ts';
import { SyntheticWorkspaceAdapter, parseScenario } from './adapters/synthetic.ts';
import type { PersonalLoyaltyHome, TenantLoyaltyData, TenantTpaData, WorkspaceMembership } from './adapters/ports.ts';
import { ContextSwitcher, PERSONAL_LABEL, type SwitchState } from './lib/context-switcher.ts';
import { PERSONAL, quickSwitchEnabled, type ContextId } from './lib/context-ring.ts';
import { NEUTRAL_THEME, cssVariables, type DerivedTheme } from './lib/theme.ts';
import { draftHasPendingWork, draftKey, type FnolDraft } from './lib/scope.ts';

/* ------------------------------------------------------------------------------------------------------
 * Consent (#74) — now scoped to the active context: a decision given while tenant A is active never
 * counts for tenant B (consent belongs to that tenant's TPA service, Deliverable C "no shared consent").
 * ---------------------------------------------------------------------------------------------------- */
type PrototypeState = {
  runtime: RuntimeKind;
  decision: ConsentDecision;
  acceptedVersion: string | null;
  /** The request that WOULD be POSTed to /v1/consents; kept in memory only, never sent. */
  pendingConsentRequest: ConsentRequest | null;
  canSubmit: boolean;
  decide: (d: Exclude<ConsentDecision, 'PENDING'>) => void;
};

type Consent = { decision: ConsentDecision; acceptedVersion: string | null };

/* ------------------------------------------------------------------------------------------------------
 * Workspace context (#106)
 * ---------------------------------------------------------------------------------------------------- */
export type SwitchTarget = ContextId | 'NEXT';
export type WarningChoice = 'stay' | 'keep' | 'discard';

type WorkspaceState = {
  switcher: ContextSwitcher;
  adapter: SyntheticWorkspaceAdapter;
  state: SwitchState;
  memberships: WorkspaceMembership[];
  ring: ContextId[];
  activeId: ContextId | null;
  quickSwitch: boolean;
  theme: DerivedTheme;
  label: (id: ContextId) => string;
  sheetOpen: boolean;
  openSheet: () => void;
  closeSheet: () => void;
  requestSwitch: (target: SwitchTarget) => void;
  warning: { target: SwitchTarget; scopeLabel: string } | null;
  resolveWarning: (choice: WarningChoice) => void;
  toast: { text: string; returnTo: ContextId | null; returnLabel: string } | null;
  dismissToast: () => void;
  draft: FnolDraft | undefined;
  setDraft: (d: FnolDraft | undefined) => void;
  /** Re-render after a prototype control changed (offline, revoke, …). */
  touch: () => void;
};

const Ctx = createContext<PrototypeState | null>(null);
const WsCtx = createContext<WorkspaceState | null>(null);

function applyTheme(theme: DerivedTheme, state: SwitchState, switcher: ContextSwitcher) {
  const root = document.documentElement;
  for (const [k, v] of Object.entries(cssVariables(theme))) root.style.setProperty(k, v);
  root.dataset.theme = theme.kind === 'TENANT' ? 'tenant' : 'neutral';
  root.dataset.themeWarning = theme.warnings.join(' ') || 'none';
  root.dataset.contextPhase = state.phase;
  root.dataset.contextGeneration = String(state.generation);
  root.dataset.staleDropped = String(switcher.staleDropped);
  root.dataset.switchMs = switcher.lastSwitchMs === null ? '' : String(switcher.lastSwitchMs);
}

/** In-memory only: nothing is persisted to storage, so a reload resets the prototype. */
export function PrototypeProvider({ runtime, children }: { runtime: RuntimeKind; children: ReactNode }) {
  const [{ adapter, switcher, scenario }] = useState(() => {
    const sc = parseScenario(typeof window === 'undefined' ? '' : window.location.search);
    const ad = new SyntheticWorkspaceAdapter(sc);
    return { adapter: ad, switcher: new ContextSwitcher(ad), scenario: sc };
  });
  const state = useSyncExternalStore(switcher.subscribe, () => switcher.state);
  const [, touch] = useReducer((n: number) => n + 1, 0);
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void switcher.init(scenario.start);
  }, [switcher, scenario]);

  const activeId = state.phase === 'ready' ? state.active.id : null;
  // Consent scope: the committed context, or the context being opened at start-up.
  const consentScope = activeId ?? (state.phase === 'switching' ? state.target : PERSONAL);
  const [consents, setConsents] = useState<Record<string, Consent>>({});
  const consent = consents[consentScope] ?? { decision: 'PENDING', acceptedVersion: null };
  const tpaReady = state.phase === 'ready' && state.active.kind === 'TENANT' && !!state.active.snapshot.tpa;

  const value = useMemo<PrototypeState>(() => ({
    runtime,
    decision: consent.decision,
    acceptedVersion: consent.acceptedVersion,
    pendingConsentRequest: buildConsentRequest(SYNTHETIC_MEMBER_ID, consent.decision),
    canSubmit: tpaReady && canSubmitClaim(consent.decision, consent.acceptedVersion),
    decide: (d) =>
      setConsents((c) => ({ ...c, [consentScope]: { decision: d, acceptedVersion: d === 'ACCEPTED' ? CONSENT_POLICY.policyVersion : null } })),
  }), [runtime, consent, consentScope, tpaReady]);

  // Theme follows the COMMITTED context only; switching/failed/personal → neutral platform theme.
  const theme = state.phase === 'ready' ? state.active.theme : NEUTRAL_THEME;
  useLayoutEffect(() => applyTheme(theme, state, switcher), [theme, state, switcher]);

  const [sheetOpen, setSheetOpen] = useState(false);
  const [warning, setWarning] = useState<WorkspaceState['warning']>(null);
  const [toast, setToast] = useState<WorkspaceState['toast']>(null);
  const [drafts, setDrafts] = useState<Record<string, FnolDraft>>({});
  const announceGen = useRef(-1);
  const principalId = switcher.profile?.principalId ?? 'anonymous';
  const currentDraftKey = activeId && activeId !== PERSONAL ? draftKey(principalId, activeId) : null;

  const perform = useCallback((target: SwitchTarget) => {
    setToast(null);
    void (target === 'NEXT' ? switcher.quickSwitch() : switcher.switchTo(target));
    if (switcher.state.phase === 'switching') announceGen.current = switcher.state.generation;
  }, [switcher]);

  const requestSwitch = useCallback((target: SwitchTarget) => {
    if (target !== 'NEXT' && target === activeId) return;
    if (target === 'NEXT' && (state.phase === 'switching' || !quickSwitchEnabled(switcher.ring))) return;
    if (currentDraftKey && draftHasPendingWork(drafts[currentDraftKey])) {
      setWarning({ target, scopeLabel: switcher.label(activeId!) });
      return;
    }
    perform(target);
  }, [activeId, state.phase, switcher, currentDraftKey, drafts, perform]);

  const resolveWarning = useCallback((choice: WarningChoice) => {
    const w = warning;
    setWarning(null);
    if (!w || choice === 'stay') return;
    if (choice === 'discard' && currentDraftKey) {
      setDrafts((d) => {
        const { [currentDraftKey]: _dropped, ...rest } = d;
        return rest;
      });
    }
    perform(w.target);
  }, [warning, currentDraftKey, perform]);

  // Announce a user-initiated switch once it commits (toast with explicit return).
  useEffect(() => {
    if (state.phase !== 'ready' || state.generation !== announceGen.current) return;
    announceGen.current = -1;
    const label = switcher.label(state.active.id);
    setToast({
      text: `Đã chuyển sang ${label}.`,
      returnTo: state.from && state.from !== state.active.id && switcher.ring.includes(state.from) ? state.from : null,
      returnLabel: state.from ? switcher.label(state.from) : '',
    });
  }, [state, switcher]);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 6000);
    return () => clearTimeout(t);
  }, [toast]);

  const ws = useMemo<WorkspaceState>(() => ({
    switcher,
    adapter,
    state,
    memberships: switcher.memberships,
    ring: switcher.ring,
    activeId,
    quickSwitch: quickSwitchEnabled(switcher.ring),
    theme,
    label: (id) => switcher.label(id),
    sheetOpen,
    openSheet: () => setSheetOpen(true),
    closeSheet: () => setSheetOpen(false),
    requestSwitch,
    warning,
    resolveWarning,
    toast,
    dismissToast: () => setToast(null),
    draft: currentDraftKey ? drafts[currentDraftKey] : undefined,
    setDraft: (d) => {
      if (!currentDraftKey) return;
      setDrafts((all) => {
        const next = { ...all };
        if (d) next[currentDraftKey] = d;
        else delete next[currentDraftKey];
        return next;
      });
    },
    touch,
  }), [switcher, adapter, state, activeId, theme, sheetOpen, requestSwitch, warning, resolveWarning, toast, currentDraftKey, drafts]);

  return (
    <Ctx.Provider value={value}>
      <WsCtx.Provider value={ws}>{children}</WsCtx.Provider>
    </Ctx.Provider>
  );
}

export function usePrototype(): PrototypeState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePrototype outside PrototypeProvider');
  return v;
}

export function useWorkspace(): WorkspaceState {
  const v = useContext(WsCtx);
  if (!v) throw new Error('useWorkspace outside PrototypeProvider');
  return v;
}

/**
 * What a service screen may render right now. Data is ONLY returned for a committed context that holds the
 * service capability; every other phase renders a neutral state with no business data.
 */
export type ServiceView<T> =
  | { status: 'loading'; label: string }
  | { status: 'failed' }
  | { status: 'needs-tenant' }
  | { status: 'unavailable'; label: string }
  | { status: 'ready'; data: T; label: string; personal: boolean };

export function useTpaView(): ServiceView<TenantTpaData> {
  const { state } = useWorkspace();
  if (state.phase === 'switching') return { status: 'loading', label: state.targetLabel };
  if (state.phase !== 'ready') return state.phase === 'idle' ? { status: 'loading', label: '' } : { status: 'failed' };
  const a = state.active;
  if (a.kind === 'PERSONAL') return { status: 'needs-tenant' };
  if (!a.snapshot.tpa) return { status: 'unavailable', label: a.membership.workspace.displayName };
  return { status: 'ready', data: a.snapshot.tpa, label: a.membership.workspace.displayName, personal: false };
}

export function useLoyaltyView(): ServiceView<TenantLoyaltyData | PersonalLoyaltyHome> {
  const { state } = useWorkspace();
  if (state.phase === 'switching') return { status: 'loading', label: state.targetLabel };
  if (state.phase !== 'ready') return state.phase === 'idle' ? { status: 'loading', label: '' } : { status: 'failed' };
  const a = state.active;
  if (a.kind === 'PERSONAL') return { status: 'ready', data: a.loyalty, label: PERSONAL_LABEL, personal: true };
  if (!a.snapshot.loyalty) return { status: 'unavailable', label: a.membership.workspace.displayName };
  return { status: 'ready', data: a.snapshot.loyalty, label: a.membership.workspace.displayName, personal: false };
}
