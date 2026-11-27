/**
 * SYNTHETIC workspace fixtures for issue #106 — invented organisations, no real insurer, programme, person
 * or brand. IDs use the reserved 00000000-0000-4000-8000-… range. Tenant meaning follows the current model
 * (tenant = insurer workspace, AGENTS.md "Đa DNBH"); Loyalty360 is a PROPOSED per-tenant service [G2/G4],
 * not an approved product. Loyalty data never contains insurance, claim, health or bank data.
 *
 * Brand colours are chosen to exercise the theme rules:
 *   A  #0f766e  teal   — readable as text, no warning.
 *   B  #ecbf3b  yellow — < 3:1 on the page → LOW_SURFACE_CONTRAST warning (OD-WS1) + derived ink/border.
 *   C  #6d28d9  purple — Loyalty360 only (no TPA capability).
 *   A after "branding update" (version 4) → #b91c1c.
 */
import type {
  PersonalLoyaltyHome,
  PersonalProfile,
  TenantLoyaltyData,
  TenantTpaData,
  WorkspaceMembership,
  WorkspaceTheme,
} from '../adapters/ports.ts';
import { SYNTHETIC_CLAIMS, SYNTHETIC_CLAIM_DETAILS, SYNTHETIC_ECARD, SYNTHETIC_EOBS, SYNTHETIC_PLAN, type ClaimSummary } from './synthetic.ts';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

export const SYNTHETIC_PROFILE: PersonalProfile = {
  principalId: id(900),
  displayNameMasked: 'N*** V*** M**',
  initials: 'NM',
};

export const WS = { A: id(901), B: id(902), C: id(903) } as const;

export const SYNTHETIC_MEMBERSHIPS: Record<keyof typeof WS, WorkspaceMembership> = {
  A: {
    membershipId: WS.A,
    roles: ['MEMBER'],
    memberIds: [SYNTHETIC_ECARD.memberId],
    version: 2,
    workspace: { displayName: 'An Bình — DNBH mẫu', shortName: 'AB', brandingVersion: 3 },
    services: ['TPA_INSURANCE', 'LOYALTY360'],
  },
  B: {
    membershipId: WS.B,
    roles: ['MEMBER'],
    memberIds: [id(11)],
    version: 1,
    workspace: { displayName: 'Bình Minh — DNBH mẫu', shortName: 'BM', brandingVersion: 1 },
    services: ['TPA_INSURANCE', 'LOYALTY360'],
  },
  C: {
    membershipId: WS.C,
    roles: ['MEMBER'],
    memberIds: [],
    version: 1,
    workspace: { displayName: 'Cát Tường — DNBH mẫu', shortName: 'CT', brandingVersion: 5 },
    services: ['LOYALTY360'],
  },
};

const theme = (primaryColor: string): WorkspaceTheme => ({ primaryColor, radius: 'MD', mode: 'LIGHT', sidebarStyle: 'LIGHT' });

export const SYNTHETIC_THEMES: Record<string, WorkspaceTheme> = {
  [`${WS.A}:3`]: theme('#0f766e'),
  [`${WS.A}:4`]: theme('#b91c1c'),
  [`${WS.B}:1`]: theme('#ecbf3b'),
  [`${WS.C}:5`]: theme('#6d28d9'),
};

const claimB = (n: number, status: ClaimSummary['status'], amount: string, visit: string): ClaimSummary => ({
  claimId: id(n),
  claimCode: `MAU-2026-000${n}`,
  memberId: id(11),
  benefitType: 'INPATIENT',
  visitDate: visit,
  totalRequested: amount,
  status,
  version: 2,
  createdAt: `${visit}T04:00:00Z`,
  updatedAt: `${visit}T08:00:00Z`,
});

const B_CLAIMS = [claimB(611, 'AI_PROCESSING', '4200000.00', '2026-11-21'), claimB(612, 'PAID', '980000.00', '2026-08-14')];

export const SYNTHETIC_TPA: Record<string, TenantTpaData> = {
  // A keeps the #74 fixtures unchanged so every existing claim/EOB test still applies to tenant A.
  [WS.A]: {
    plan: { ...SYNTHETIC_PLAN, insurerLabel: 'An Bình — DNBH mẫu (giả lập)' },
    ecard: SYNTHETIC_ECARD,
    claims: SYNTHETIC_CLAIMS,
    claimDetails: SYNTHETIC_CLAIM_DETAILS,
    eobs: SYNTHETIC_EOBS,
  },
  [WS.B]: {
    plan: { insurerLabel: 'Bình Minh — DNBH mẫu (giả lập)', planLabel: 'Gói Mẫu Bình Minh — Nội trú', effectiveFrom: '2026-03-01', effectiveTo: '2027-02-28' },
    ecard: { memberId: id(11), coverageVersionId: id(12), displayNameMasked: 'N*** V*** M**', cardNumberMasked: 'MAU-••••-0077' },
    claims: B_CLAIMS,
    claimDetails: Object.fromEntries(B_CLAIMS.map((c) => [c.claimId, { claim: c, documents: [], supplementAllowed: false }])),
    eobs: {},
  },
};

const benefit = (n: number, title: string, note: string) => ({ id: id(n), title, note });

export const SYNTHETIC_LOYALTY: Record<string, TenantLoyaltyData> = {
  [WS.A]: { programLabel: 'An Bình Thân Thiết (mẫu)', tier: 'Hạng Bạc', points: '1250', benefits: [benefit(701, 'Phiếu ưu đãi mẫu 50.000 ₫ tại đối tác', 'Giả lập — chưa có đối tác thật')] },
  [WS.B]: { programLabel: 'Bình Minh Rewards (mẫu)', tier: 'Hạng Vàng', points: '380', benefits: [benefit(702, 'Quà tặng sinh nhật mẫu', 'Giả lập — chưa có quà thật')] },
  [WS.C]: { programLabel: 'Cát Tường Club (mẫu)', tier: 'Thành viên', points: '90', benefits: [] },
};

/** (a) The person's OWN Loyalty360 home — not an aggregate of tenant programmes, no pooled points. */
export const SYNTHETIC_PERSONAL_LOYALTY: PersonalLoyaltyHome = {
  programLabel: 'Loyalty360 cá nhân (mẫu)',
  tier: 'Thành viên mới',
  points: '120',
  benefits: [
    benefit(801, 'Ưu đãi chào mừng (mẫu)', 'Giả lập — chưa có ưu đãi thật'),
    benefit(802, 'Hoàn thiện hồ sơ cá nhân để nhận điểm (mẫu)', 'Giả lập — chưa có quy tắc điểm được duyệt'),
  ],
};
