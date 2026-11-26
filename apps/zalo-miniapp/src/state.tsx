import { createContext, useContext, useMemo, useState, type ReactNode } from 'react';
import { CONSENT_POLICY, buildConsentRequest, canSubmitClaim, type ConsentDecision, type ConsentRequest } from './lib/consent.ts';
import type { RuntimeKind } from './lib/platform.ts';
import { SYNTHETIC_MEMBER_ID } from './fixtures/synthetic.ts';

type PrototypeState = {
  runtime: RuntimeKind;
  decision: ConsentDecision;
  acceptedVersion: string | null;
  /** The request that WOULD be POSTed to /v1/consents; kept in memory only, never sent. */
  pendingConsentRequest: ConsentRequest | null;
  canSubmit: boolean;
  decide: (d: Exclude<ConsentDecision, 'PENDING'>) => void;
};

const Ctx = createContext<PrototypeState | null>(null);

/** In-memory only: nothing is persisted to storage, so a reload resets the prototype. */
export function PrototypeProvider({ runtime, children }: { runtime: RuntimeKind; children: ReactNode }) {
  const [decision, setDecision] = useState<ConsentDecision>('PENDING');
  const [acceptedVersion, setAcceptedVersion] = useState<string | null>(null);
  const value = useMemo<PrototypeState>(() => ({
    runtime,
    decision,
    acceptedVersion,
    pendingConsentRequest: buildConsentRequest(SYNTHETIC_MEMBER_ID, decision),
    canSubmit: canSubmitClaim(decision, acceptedVersion),
    decide: (d) => {
      setDecision(d);
      setAcceptedVersion(d === 'ACCEPTED' ? CONSENT_POLICY.policyVersion : null);
    },
  }), [runtime, decision, acceptedVersion]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function usePrototype(): PrototypeState {
  const v = useContext(Ctx);
  if (!v) throw new Error('usePrototype outside PrototypeProvider');
  return v;
}
