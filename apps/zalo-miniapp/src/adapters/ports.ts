/**
 * Ports the #106 shell talks to. ONLY a synthetic in-memory adapter exists (adapters/synthetic.ts); no
 * runtime API is implemented or implied. Each field is tagged with its source:
 *
 *   [02]  exists in docs/ai-specs/02-openapi-contracts.yaml today
 *   [Gn]  PROPOSED contract gap, listed in docs/106-user-hub-design.md §7 — NOT an approved API
 *
 * Data classes (issue #106 Deliverable C):
 *   (a) personal identity/preferences    → PersonalProfile, PersonalLoyaltyHome
 *   (b) tenant branding/access capability → WorkspaceMembership.workspace / services
 *   (c) tenant+service records            → TenantTpaData / TenantLoyaltyData
 * They are separate types on purpose: there is no shared "customer" object.
 */
import type { ClaimDetail, ClaimSummary, ECardBase, ExplainableEOBResponse } from '../fixtures/synthetic.ts';

/** Capability-approved services of a workspace [G2]. */
export type ServiceKey = 'TPA_INSURANCE' | 'LOYALTY360';

export type MembershipRole = 'MEMBER' | 'GUARDIAN' | 'CLAIM_REVIEWER' | 'INSURER_REVIEWER' | 'FINANCE' | 'CURATOR';

export type WorkspaceMembership = {
  membershipId: string; // [02] Membership.membershipId
  roles: MembershipRole[]; // [02]
  memberIds: string[]; // [02]
  version: number; // [02] Membership.version
  /** Display identity for the member channel [G1]; spec 13 only has admin/profile + unapproved public branding. */
  workspace: { displayName: string; shortName: string; brandingVersion: number };
  /** [G2] services the server says this membership may use; branding never implies access. */
  services: ServiceKey[];
};

/** [02] MembershipContext returned by POST /v1/me/membership. Opaque token; held in memory only. */
export type MembershipContext = { membershipId: string; expiresAt: string; contextToken: string };

/** [02] WorkspaceTheme (admin contract) — member-channel read is [G3]. */
export type WorkspaceTheme = {
  primaryColor: string;
  radius: 'NONE' | 'SM' | 'MD' | 'LG';
  mode: 'LIGHT' | 'DARK';
  sidebarStyle: 'LIGHT' | 'BRAND';
};

/** (a) Minimal personal identity [G5]. Masked display only; no CCCD/phone/bank. */
export type PersonalProfile = { principalId: string; displayNameMasked: string; initials: string };

/** (a) Personal Loyalty360 home [G4]: the person's OWN program data, no tenant, no health/claim data. */
export type PersonalLoyaltyHome = {
  programLabel: string;
  tier: string;
  points: string; // integer-as-string; points are not money and never feed policy limits
  benefits: { id: string; title: string; note: string }[];
};

/** (c) TPA records for one tenant. Shapes are the existing [02] schemas. */
export type TenantTpaData = {
  plan: { insurerLabel: string; planLabel: string; effectiveFrom: string; effectiveTo: string };
  ecard: ECardBase;
  claims: ClaimSummary[];
  claimDetails: Record<string, ClaimDetail>;
  eobs: Record<string, ExplainableEOBResponse>;
};

/** (c) Tenant Loyalty360 program records [G4]. Separate from TPA; never contains insurance or health data. */
export type TenantLoyaltyData = PersonalLoyaltyHome;

/** Everything a committed tenant context renders, fetched under ONE context generation. */
export type TenantSnapshot = { tpa: TenantTpaData | null; loyalty: TenantLoyaltyData | null };

export type PortErrorCode = 'FORBIDDEN' | 'OFFLINE' | 'ABORTED' | 'ERROR';

export class PortError extends Error {
  readonly code: PortErrorCode;
  constructor(code: PortErrorCode) {
    super(code);
    this.code = code;
  }
}

export interface WorkspacePort {
  /** [02] GET /v1/me/memberships (Me) — plus [G1]/[G2] fields. Authoritative list. */
  listMemberships(signal: AbortSignal): Promise<{ profile: PersonalProfile; memberships: WorkspaceMembership[] }>;
  /** [02] POST /v1/me/membership — server re-authorises the grant; FORBIDDEN when revoked. */
  selectMembership(membershipId: string, signal: AbortSignal): Promise<MembershipContext>;
  /** [G3] read-only theme for an authorised membership at a branding version. */
  getTheme(ctx: MembershipContext, brandingVersion: number, signal: AbortSignal): Promise<WorkspaceTheme>;
  /** (c) tenant service data under the context token; only for services in `services` [02 + G4]. */
  getTenantSnapshot(ctx: MembershipContext, services: ServiceKey[], signal: AbortSignal): Promise<TenantSnapshot>;
  /** [G4] personal Loyalty360 home; no membership context is sent. */
  getPersonalLoyalty(signal: AbortSignal): Promise<PersonalLoyaltyHome>;
}
