import { useEffect, useRef, useState } from 'react';
import { Shell } from '../components/shell.tsx';
import { ServiceState } from '../components/service-state.tsx';
import { useTpaView } from '../state.tsx';
import { ROTATION_SECONDS, placeholderCard, placeholderPattern, secondsRemaining } from '../lib/ecard.ts';

function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(t);
  }, [intervalMs]);
  return now;
}

export function ECardPage() {
  const now = useNow(1000);
  const card = placeholderCard(now);
  const remaining = secondsRemaining(now);
  const pattern = placeholderPattern(card.windowIndex);
  const [announce, setAnnounce] = useState('');
  const lastWindow = useRef(card.windowIndex);
  useEffect(() => {
    if (card.windowIndex !== lastWindow.current) {
      lastWindow.current = card.windowIndex;
      setAnnounce('Mã mẫu đã được làm mới.');
    }
  }, [card.windowIndex]);

  const cell = 8;
  const view = useTpaView();
  if (view.status !== 'ready') {
    return (
      <Shell title="Thẻ bảo hiểm điện tử">
        <ServiceState view={view} serviceVi="Bảo hiểm sức khỏe" />
      </Shell>
    );
  }
  const { plan, ecard } = view.data;
  return (
    <Shell title="Thẻ bảo hiểm điện tử">
      <section className="card ecard" aria-label="Thẻ bảo hiểm mẫu">
        <p className="meta">{plan.insurerLabel}</p>
        <h2>{ecard.displayNameMasked}</h2>
        <p>Số thẻ: <span data-testid="card-number">{ecard.cardNumberMasked}</span></p>
        <p>Hiệu lực: {plan.effectiveFrom} → {plan.effectiveTo}</p>
        <figure className="placeholder">
          <svg
            role="img"
            aria-label="Hình minh họa MẪU, không phải mã QR, không quét được"
            viewBox={`0 0 ${pattern.length * cell} ${pattern.length * cell}`}
            width="168"
            height="168"
            data-testid="ecard-placeholder"
            data-window={card.windowIndex}
          >
            {pattern.flatMap((row, y) =>
              row.map((on, x) => (on ? <rect key={`${x}-${y}`} x={x * cell} y={y * cell} width={cell} height={cell} /> : null)),
            )}
          </svg>
          <figcaption>MẪU — KHÔNG PHẢI MÃ QR</figcaption>
        </figure>
        <p className="countdown">
          Làm mới sau <strong data-testid="ecard-countdown">{remaining}</strong> giây (chu kỳ {ROTATION_SECONDS} giây)
        </p>
        <p className="meta"><code data-testid="ecard-token">{card.qrToken}</code></p>
        <p className="sr-only" aria-live="polite">{announce}</p>
      </section>
      <p className="hint">
        Mã thật là token ngắn hạn (tối đa 60 giây) do máy chủ cấp và phải được xác thực khi sử dụng. Thẻ chỉ xác nhận
        hiệu lực bảo hiểm, không phải phê duyệt quyền lợi.
      </p>
    </Shell>
  );
}
