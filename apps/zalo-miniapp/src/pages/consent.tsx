import { useId, useState } from 'react';
import { Button, useNavigate } from 'zmp-ui';
import { Shell } from '../components/shell.tsx';
import { CONSENT_POLICY } from '../lib/consent.ts';
import { usePrototype } from '../state.tsx';

export function ConsentPage() {
  const navigate = useNavigate();
  const { decide } = usePrototype();
  const [read, setRead] = useState(false);
  const checkboxId = useId();
  return (
    <Shell title="Đồng ý xử lý dữ liệu">
      <section className="card" aria-labelledby="consent-title">
        <h2 id="consent-title">{CONSENT_POLICY.title}</h2>
        <p className="meta" data-testid="consent-version">
          Phiên bản: <code>{CONSENT_POLICY.policyVersion}</code> · Mã băm: <code>{CONSENT_POLICY.policyHash.slice(0, 12)}…</code>
        </p>
        {CONSENT_POLICY.paragraphs.map((p) => <p key={p}>{p}</p>)}
      </section>
      <div className="check">
        <input id={checkboxId} type="checkbox" checked={read} onChange={(e) => setRead(e.target.checked)} />
        <label htmlFor={checkboxId}>Tôi đã đọc và hiểu nội dung phiên bản {CONSENT_POLICY.policyVersion}.</label>
      </div>
      <div className="actions">
        <Button
          fullWidth
          disabled={!read}
          onClick={() => {
            decide('ACCEPTED');
            navigate('/home');
          }}
        >
          Đồng ý
        </Button>
        <Button
          fullWidth
          variant="secondary"
          onClick={() => {
            decide('DENIED');
            navigate('/consent/denied');
          }}
        >
          Không đồng ý
        </Button>
      </div>
    </Shell>
  );
}

export function ConsentDeniedPage() {
  const navigate = useNavigate();
  return (
    <Shell title="Bạn chưa đồng ý">
      <section className="card notice" role="status">
        <h2>Không thể gửi yêu cầu bồi thường trực tuyến</h2>
        <p>
          Bạn đã chọn không đồng ý. Chúng tôi không ghi nhận đồng ý và không xử lý chứng từ của bạn. Bạn vẫn có thể xem
          thẻ bảo hiểm điện tử, hoặc liên hệ tổng đài để được hỗ trợ nộp hồ sơ giấy.
        </p>
      </section>
      <div className="actions">
        <Button fullWidth onClick={() => navigate('/consent')}>Xem lại điều khoản</Button>
        <Button fullWidth variant="secondary" onClick={() => navigate('/home')}>Tiếp tục với chức năng giới hạn</Button>
      </div>
    </Shell>
  );
}
