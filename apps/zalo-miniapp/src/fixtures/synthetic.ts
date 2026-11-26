/**
 * SYNTHETIC fixtures — invented data, no real person, contract, provider or claim.
 * Shapes follow docs/ai-specs/02-openapi-contracts.yaml (ClaimSummary, ClaimDetail, ExplainableEOBResponse,
 * EobLine, ContractClause, ECard). Money is always an OpenAPI `Money` string. IDs use the reserved
 * 00000000-0000-4000-8000-… range so they are recognisably fake. Contract clause text is MẪU (sample) only,
 * not approved contract wording.
 */
import type { ClaimStatus } from '../lib/claim-status.ts';
import type { Money } from '../lib/money.ts';

export type BenefitType = 'OUTPATIENT' | 'INPATIENT' | 'DENTAL' | 'MATERNITY' | 'ACCIDENT' | 'HOSPITAL_INCOME';

export type ClaimSummary = {
  claimId: string;
  claimCode: string;
  memberId: string;
  benefitType: BenefitType;
  visitDate: string;
  totalRequested: Money;
  status: ClaimStatus;
  version: number;
  createdAt: string;
  updatedAt: string;
};

export type ClaimDetail = {
  claim: ClaimSummary;
  documents: never[];
  supplementAllowed: boolean;
  supplementDeadline?: string;
};

export type VersionedReference = { id: string; version: number; hash: string };

export type ContractClause = {
  clauseId: string;
  source: 'BENEFIT_RULE' | 'MEDICAL_CATALOG';
  sourceVersion: VersionedReference;
  contractClauseCited: string;
  explanationVi: string;
};

export type EobLine = {
  lineId: string;
  itemName: string;
  requested: Money;
  approved: Money;
  rejected: Money;
  status: 'APPROVED' | 'PARTIAL' | 'REJECTED';
  clauseCited: string;
  contractClause: ContractClause;
  explanationVi: string;
  evidenceIds: string[];
};

export type ExplainableEOBResponse = {
  claimCode: string;
  claimId: string;
  status: ClaimStatus;
  aggregateVersion: number;
  eobVersion: number;
  eobHash: string;
  contractVersionId: string;
  policyVersion: VersionedReference;
  benefitRuleVersion: VersionedReference;
  configurationVersion: VersionedReference;
  calculationRun: VersionedReference;
  summary: { totalRequested: Money; totalApproved: Money; totalRejected: Money; remainingAnnualLimit: Money };
  lineItems: EobLine[];
  reservationIds: string[];
  auditProof: { hashChainTail: string; contractLocked: true };
  publishedAt: string;
};

export type ECardBase = {
  memberId: string;
  coverageVersionId: string;
  displayNameMasked: string;
  cardNumberMasked: string;
};

const id = (n: number) => `00000000-0000-4000-8000-${n.toString().padStart(12, '0')}`;

const HASH = {
  eob: '77a8dd18178dfd742465e4271e9f3da078abfd18cbfdb8c17c6ea5d8a6839ea0',
  policy: 'f0b955da26c93d508fe17ceea491db7a5384dc7ae0b9639633866ea0d00d1169',
  rule: '85a2a0d623efe672ca3115c4e30e77826ffac42209fefc350345426746e84c84',
  config: 'c7375948cc05269ff8643754615d605a6a54c7f5a0ef83c118a8f3adb7245e0a',
  calc: '34f950c7b184618a18e1965560c7ae5a2c7cf39fd828a21d8c25b1d56e2bd773',
  audit: 'e03e7730fa0d95cd3c8dcf28d25aa5c324ab0a0071dae587a49f4d324bd62977',
} as const;

export const SYNTHETIC_MEMBER_ID = id(1);

export const SYNTHETIC_ECARD: ECardBase = {
  memberId: SYNTHETIC_MEMBER_ID,
  coverageVersionId: id(2),
  displayNameMasked: 'N*** V*** M**',
  cardNumberMasked: 'MAU-••••-0042',
};

export const SYNTHETIC_PLAN = {
  insurerLabel: 'DNBH Mẫu (giả lập)',
  planLabel: 'Gói Sức khỏe Mẫu — Ngoại trú',
  effectiveFrom: '2026-01-01',
  effectiveTo: '2026-12-31',
} as const;

const ruleRef: VersionedReference = { id: id(30), version: 3, hash: HASH.rule };
const catalogRef: VersionedReference = { id: id(31), version: 7, hash: HASH.rule };

export const SYNTHETIC_CLAIMS: ClaimSummary[] = [
  {
    claimId: id(101),
    claimCode: 'MAU-2026-000101',
    memberId: SYNTHETIC_MEMBER_ID,
    benefitType: 'OUTPATIENT',
    visitDate: '2026-11-10',
    totalRequested: '1000000.00',
    status: 'EOB_READY',
    version: 6,
    createdAt: '2026-11-11T02:15:00Z',
    updatedAt: '2026-11-13T09:40:00Z',
  },
  {
    claimId: id(102),
    claimCode: 'MAU-2026-000102',
    memberId: SYNTHETIC_MEMBER_ID,
    benefitType: 'OUTPATIENT',
    visitDate: '2026-11-18',
    totalRequested: '1850000.00',
    status: 'SUPPLEMENT_REQUIRED',
    version: 3,
    createdAt: '2026-11-19T03:00:00Z',
    updatedAt: '2026-11-20T08:05:00Z',
  },
  {
    claimId: id(103),
    claimCode: 'MAU-2026-000087',
    memberId: SYNTHETIC_MEMBER_ID,
    benefitType: 'DENTAL',
    visitDate: '2026-09-02',
    totalRequested: '540000.00',
    status: 'PAID',
    version: 9,
    createdAt: '2026-09-03T01:20:00Z',
    updatedAt: '2026-09-08T10:00:00Z',
  },
];

export const SYNTHETIC_CLAIM_DETAILS: Record<string, ClaimDetail> = {
  [id(101)]: { claim: SYNTHETIC_CLAIMS[0]!, documents: [], supplementAllowed: false },
  [id(102)]: {
    claim: SYNTHETIC_CLAIMS[1]!,
    documents: [],
    supplementAllowed: true,
    supplementDeadline: '2026-12-05T16:59:59Z',
  },
  [id(103)]: { claim: SYNTHETIC_CLAIMS[2]!, documents: [], supplementAllowed: false },
};

export const SYNTHETIC_EOBS: Record<string, ExplainableEOBResponse> = {
  [id(101)]: {
    claimCode: 'MAU-2026-000101',
    claimId: id(101),
    status: 'EOB_READY',
    aggregateVersion: 6,
    eobVersion: 1,
    eobHash: HASH.eob,
    contractVersionId: id(20),
    policyVersion: { id: id(21), version: 1, hash: HASH.policy },
    benefitRuleVersion: ruleRef,
    configurationVersion: { id: id(22), version: 2, hash: HASH.config },
    calculationRun: { id: id(23), version: 1, hash: HASH.calc },
    summary: {
      totalRequested: '1000000.00',
      totalApproved: '720000.00',
      totalRejected: '280000.00',
      remainingAnnualLimit: '19280000.00',
    },
    lineItems: [
      {
        lineId: id(201),
        itemName: 'Phí khám chuyên khoa',
        requested: '300000.00',
        approved: '300000.00',
        rejected: '0.00',
        status: 'APPROVED',
        clauseCited: 'Điều MẪU 4.1 — Chi phí khám ngoại trú',
        contractClause: {
          clauseId: id(301),
          source: 'BENEFIT_RULE',
          sourceVersion: ruleRef,
          contractClauseCited: 'Điều MẪU 4.1: Chi phí khám bệnh ngoại trú được chi trả theo thực tế, tối đa theo hạn mức/lần khám.',
          explanationVi: 'Chi phí khám nằm trong hạn mức mỗi lần khám nên được chi trả toàn bộ.',
        },
        explanationVi: 'Được chi trả toàn bộ.',
        evidenceIds: [id(401)],
      },
      {
        lineId: id(202),
        itemName: 'Thuốc kháng sinh (theo đơn)',
        requested: '450000.00',
        approved: '420000.00',
        rejected: '30000.00',
        status: 'PARTIAL',
        clauseCited: 'Danh mục MẪU — Giá thuốc tham chiếu v7',
        contractClause: {
          clauseId: id(302),
          source: 'MEDICAL_CATALOG',
          sourceVersion: catalogRef,
          contractClauseCited: 'Danh mục MẪU v7: Thuốc theo đơn được chi trả tối đa theo giá tham chiếu của danh mục.',
          explanationVi: 'Giá thuốc trên hóa đơn cao hơn giá tham chiếu; phần chênh lệch không được chi trả.',
        },
        explanationVi: 'Chi trả theo giá tham chiếu; phần chênh lệch 30.000 ₫ không được chi trả.',
        evidenceIds: [id(402), id(403)],
      },
      {
        lineId: id(203),
        itemName: 'Thực phẩm chức năng bổ sung vitamin',
        requested: '250000.00',
        approved: '0.00',
        rejected: '250000.00',
        status: 'REJECTED',
        clauseCited: 'Điều MẪU 9.3 — Loại trừ thực phẩm chức năng',
        contractClause: {
          clauseId: id(303),
          source: 'BENEFIT_RULE',
          sourceVersion: ruleRef,
          contractClauseCited: 'Điều MẪU 9.3: Không chi trả thực phẩm chức năng, thực phẩm bổ sung và mỹ phẩm.',
          explanationVi: 'Sản phẩm thuộc nhóm thực phẩm chức năng nằm trong danh sách loại trừ của hợp đồng mẫu.',
        },
        explanationVi: 'Không được chi trả vì thuộc nhóm loại trừ.',
        evidenceIds: [id(404)],
      },
    ],
    reservationIds: [id(501)],
    auditProof: { hashChainTail: HASH.audit, contractLocked: true },
    publishedAt: '2026-11-13T09:40:00Z',
  },
};
