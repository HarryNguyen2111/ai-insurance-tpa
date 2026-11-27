import { useState } from 'react';
import { SvgIcon } from '../components/icons.tsx';
import { Section } from '../components/section.tsx';
import { Shell } from '../components/shell.tsx';
import { ContextHeader } from '../components/context-header.tsx';
import { ServiceState } from '../components/service-state.tsx';
import type { PersonalLoyaltyHome } from '../adapters/ports.ts';
import { useLoyaltyView } from '../state.tsx';

/** Points are an integer string; grouped for display without Number() (not money, but keep it exact). */
export const formatPoints = (p: string) => p.replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * Tier/points/benefits card. Contains ONLY loyalty programme data: no insurance, claim, health or bank data,
 * and points are never shown as or converted into policy limits.
 */
export function LoyaltyCard({ data, personal }: { data: PersonalLoyaltyHome; personal: boolean }) {
  return (
    <div className="loyalty-card" role="group" aria-label={`${data.programLabel} — dữ liệu giả lập`} data-testid="loyalty-card">
      <span className="loyalty-program">{data.programLabel}</span>
      <span className="loyalty-tier" data-testid="loyalty-tier">{data.tier}</span>
      <span className="loyalty-points">
        <strong data-testid="loyalty-points">{formatPoints(data.points)}</strong> điểm <span className="synthetic-tag">mẫu</span>
      </span>
      <span className="loyalty-scope">{personal ? 'Chương trình của riêng bạn — không gộp điểm của các đơn vị.' : 'Điểm chỉ thuộc chương trình của đơn vị này.'}</span>
    </div>
  );
}

export function BenefitList({ data }: { data: PersonalLoyaltyHome }) {
  if (!data.benefits.length) return <p className="hint" data-testid="benefits-empty">Chưa có ưu đãi nào (mẫu).</p>;
  return (
    <ul className="recent" aria-label="Ưu đãi (mẫu)">
      {data.benefits.map((b) => (
        <li key={b.id} className="benefit">
          <span className="recent-icon" aria-hidden="true"><SvgIcon name="gift" /></span>
          <span className="recent-body">
            <strong>{b.title}</strong>
            <span className="hint">{b.note}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

const MENU = [
  { key: 'overview', label: 'Tổng quan', available: true },
  { key: 'vouchers', label: 'Ưu đãi', available: false },
  { key: 'history', label: 'Lịch sử điểm', available: false },
] as const;

/** H2 — Loyalty360 service home for the active context (personal programme or the tenant's programme). */
export function LoyaltyPage() {
  const view = useLoyaltyView();
  const [note, setNote] = useState('');
  return (
    <Shell title="Loyalty360" back={false} tone="warm" hero={<ContextHeader service={{ label: 'Loyalty360', icon: 'star' }} />}>
      <h1 className="sr-only">Loyalty360</h1>
      {/* Contextual service menu (separate from the TPA menu). */}
      <nav className="service-menu" aria-label="Menu Loyalty360">
        {MENU.map((m) => (
          <button
            key={m.key}
            type="button"
            className={m.key === 'overview' ? 'seg current' : 'seg'}
            aria-current={m.key === 'overview' ? 'page' : undefined}
            onClick={() => setNote(m.available ? '' : `${m.label} chưa có trong bản thử nghiệm.`)}
          >
            {m.label}
            {!m.available && <span className="sr-only"> (sắp có)</span>}
          </button>
        ))}
      </nav>
      {note && <p className="hint" role="status">{note}</p>}
      {view.status !== 'ready' ? (
        <ServiceState view={view} serviceVi="Loyalty360" />
      ) : (
        <>
          <Section title={view.personal ? 'Hạng thành viên của bạn' : `Hạng thành viên tại ${view.label}`}>
            <LoyaltyCard data={view.data} personal={view.personal} />
          </Section>
          <Section title="Ưu đãi">
            <BenefitList data={view.data} />
          </Section>
          <p className="hint">Dữ liệu Loyalty360 là giả lập; chưa có hệ thống Loyalty360 thật và chưa có hợp đồng API được duyệt.</p>
        </>
      )}
    </Shell>
  );
}
