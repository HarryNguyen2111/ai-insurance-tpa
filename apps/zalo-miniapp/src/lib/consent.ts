/**
 * Versioned consent (Luật BVDLCN 91/2025/QH15 flavour) — SYNTHETIC wording for the prototype only.
 * Real policy text, purpose codes and version/hash come from the approved legal source (blocked on #21/#26).
 * Shapes mirror OpenAPI `ConsentRequest`; the prototype never sends it anywhere.
 */
export const CONSENT_POLICY = {
  purpose: 'CLAIM_PROCESSING_HEALTH_DATA',
  policyVersion: 'synthetic-2026.11-v1',
  title: 'Đồng ý xử lý dữ liệu cá nhân (bản MẪU)',
  paragraphs: [
    'Đây là văn bản MẪU dùng cho bản thử nghiệm, KHÔNG phải điều khoản pháp lý chính thức.',
    'Mục đích: tiếp nhận và giải quyết yêu cầu bồi thường bảo hiểm sức khỏe của bạn.',
    'Dữ liệu được xử lý: thông tin thẻ bảo hiểm, chứng từ khám chữa bệnh và hóa đơn bạn tải lên.',
    'Bạn có quyền rút lại đồng ý bất cứ lúc nào; việc rút lại không ảnh hưởng tới các xử lý đã thực hiện trước đó.',
    'Nếu không đồng ý, bạn vẫn xem được thẻ bảo hiểm điện tử nhưng không thể gửi yêu cầu bồi thường trực tuyến.',
  ],
  /** sha256 of `consentCanonicalText()`; verified by consent.test.ts. */
  policyHash: '15cb3e2e654f729121a9c0f5631e9730b83dcc1b911fbc553c47116cf8447b9d',
} as const;

export type ConsentDecision = 'PENDING' | 'ACCEPTED' | 'DENIED';

/** Canonical text that the hash binds: version + purpose + paragraphs, newline separated. */
export type ConsentPolicyText = { policyVersion: string; purpose: string; title: string; paragraphs: readonly string[] };

export function consentCanonicalText(policy: ConsentPolicyText = CONSENT_POLICY): string {
  return [policy.policyVersion, policy.purpose, policy.title, ...policy.paragraphs].join('\n');
}

export type ConsentRequest = {
  memberId: string;
  purpose: string;
  policyVersion: string;
  policyHash: string;
  accepted: true;
};

/**
 * Build the OpenAPI ConsentRequest for an acceptance. A denial produces NO request:
 * the contract only admits `accepted: true`, so a refusal is simply never recorded as consent.
 */
export function buildConsentRequest(memberId: string, decision: ConsentDecision): ConsentRequest | null {
  if (decision !== 'ACCEPTED') return null;
  return {
    memberId,
    purpose: CONSENT_POLICY.purpose,
    policyVersion: CONSENT_POLICY.policyVersion,
    policyHash: CONSENT_POLICY.policyHash,
    accepted: true,
  };
}

/** Claim submission (FNOL) is only reachable with an accepted consent of the CURRENT version. */
export function canSubmitClaim(decision: ConsentDecision, acceptedVersion: string | null): boolean {
  return decision === 'ACCEPTED' && acceptedVersion === CONSENT_POLICY.policyVersion;
}
