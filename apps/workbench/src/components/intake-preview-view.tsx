'use client';

import { useMemo, useState } from 'react';
import { buildIntakePreview, type DraftValues, type IntakeFormConfig, type PreviewField } from '@/lib/intake-preview';

const DOC_TYPE_LABELS: Record<string, string> = {
  INVOICE_PHOTO: 'Ảnh hóa đơn', ITEMIZED_LIST: 'Bảng kê', PRESCRIPTION: 'Đơn thuốc', LAB_ORDER: 'Chỉ định xét nghiệm', LAB_RESULT: 'Kết quả xét nghiệm',
};

function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'brand' | 'amber' | 'rose' | 'emerald' }) {
  const tones = {
    slate: 'bg-slate-100 text-slate-700', brand: 'bg-brand-50 text-brand-700', amber: 'bg-amber-50 text-amber-800',
    rose: 'bg-rose-50 text-rose-700', emerald: 'bg-emerald-50 text-emerald-800',
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function FieldControl({ field, value, onChange }: { field: PreviewField; value: DraftValues[string]; onChange: (v: string | boolean | undefined) => void }) {
  const id = `f-${field.key}`;
  if (field.availability.kind === 'INFO') {
    return <p className="rounded-xl bg-brand-50 p-3 text-sm text-brand-900">{field.label}</p>;
  }
  if (field.availability.kind === 'NEEDS_BACKEND') {
    return (
      <div className="space-y-2">
        {field.component === 'DOCUMENT_SLOT' ? (
          <button type="button" disabled data-testid={`upload-${field.key}`}
            className="w-full cursor-not-allowed rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 px-3 py-4 text-sm text-slate-500">
            Tải chứng từ — chưa khả dụng
          </button>
        ) : (
          <input id={id} disabled aria-describedby={`${id}-dep`} placeholder="Chưa khả dụng trong bản xem trước"
            className="w-full cursor-not-allowed rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-400" />
        )}
        <p id={`${id}-dep`} className="text-xs text-slate-500">Cần backend: {field.availability.dependency}</p>
      </div>
    );
  }
  switch (field.component) {
    case 'SINGLE_SELECT':
      return (
        <select id={id} data-testid={`draft-${field.key}`} value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm">
          <option value="">— Chọn —</option>
          {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'DATE':
      return (
        <input id={id} type="date" data-testid={`draft-${field.key}`} value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}
          className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm" />
      );
    case 'BOOLEAN':
      return (
        <label className="inline-flex items-center gap-2 text-sm">
          <input id={id} type="checkbox" data-testid={`draft-${field.key}`} checked={value === true}
            onChange={e => onChange(e.target.checked ? true : undefined)} className="h-4 w-4 rounded" />
          Có
        </label>
      );
    default:
      return null;
  }
}

export function IntakePreviewView({ config }: { config: IntakeFormConfig }) {
  const [draft, setDraft] = useState<Record<string, string | boolean | undefined>>({});
  const preview = useMemo(() => buildIntakePreview(config, draft), [config, draft]);
  const labelOf = (key: string) => config.fields.find(f => f.key === key)?.label ?? key;

  return (
    <div className="space-y-6">
      <header className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="amber">XEM TRƯỚC — không gửi dữ liệu</Badge>
          <Badge>Cấu hình mẫu tổng hợp · {preview.formKey}</Badge>
        </div>
        <h1 className="mt-3 text-2xl font-bold text-brand-900">{preview.title}</h1>
        <p className="mt-1 text-sm text-slate-600">
          Nguồn: <code>docs/ai-specs/examples/intake-form-health-outpatient.example.json</code> (spec 11). Không phải cấu hình của DNBH thật.
        </p>
        <div className="mt-3 flex flex-wrap gap-2 text-xs">
          <Badge tone="brand">Sự kiện: {preview.eventLabel}</Badge>
          {preview.benefitLabels.map(b => <Badge key={b} tone="brand">Quyền lợi: {b}</Badge>)}
          {preview.channelLabels.map(c => <Badge key={c}>Kênh: {c}</Badge>)}
        </div>
      </header>

      <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
        <ol className="space-y-5">
          {preview.steps.map((step, index) => (
            <li key={step.stepKey} data-testid={`step-${step.stepKey}`} data-visible={step.visible}
              className={`rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200 ${step.visible ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-brand-700 text-xs font-bold text-white">{index + 1}</span>
                <h2 className="text-base font-semibold">{step.title}</h2>
                {step.conditional && <Badge tone={step.visible ? 'emerald' : 'slate'}>{step.visible ? 'Đang hiển thị theo điều kiện' : 'Ẩn — chưa thỏa điều kiện'}</Badge>}
              </div>
              {step.help && <p className="mt-1 text-sm text-slate-600">{step.help}</p>}
              {step.visible && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {step.fields.filter(f => f.visible).map(field => (
                    <div key={field.key} data-testid={`field-${field.key}`} className={`space-y-2 rounded-2xl bg-slate-50 p-4 ring-1 ring-slate-200 ${field.halfWidth ? '' : 'sm:col-span-2'}`}>
                      {field.availability.kind !== 'INFO' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor={`f-${field.key}`} className="text-sm font-semibold text-slate-800">{field.label}</label>
                          {field.requiredAtSubmit && <Badge tone="rose">Bắt buộc khi nộp</Badge>}
                          {field.availability.kind === 'LOCAL_DRAFT' && <Badge tone="emerald">Nháp cục bộ</Badge>}
                          {field.aiPrefill && <Badge>AI có thể đề xuất — chưa hoạt động</Badge>}
                        </div>
                      )}
                      {field.help && <p className="text-xs text-slate-600">{field.help}</p>}
                      <FieldControl field={field} value={draft[field.key]} onChange={v => setDraft(d => ({ ...d, [field.key]: v }))} />
                      {field.docTypes.length > 0 && (
                        <p className="text-xs text-slate-500">Loại chứng từ: {field.docTypes.map(t => DOC_TYPE_LABELS[t] ?? t).join(', ')}</p>
                      )}
                      <p className="text-[11px] text-slate-400">{field.componentLabel} · {field.bindingLabel}</p>
                    </div>
                  ))}
                  {step.fields.some(f => !f.visible) && (
                    <p className="text-xs text-slate-500 sm:col-span-2">Một số trường đang ẩn theo điều kiện hiển thị của cấu hình.</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>

        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200" data-testid="draft-summary">
            <h2 className="text-base font-semibold">Nháp cục bộ</h2>
            <p className="mt-1 text-xs text-slate-600">Chỉ nằm trong bộ nhớ trang này: không lưu trình duyệt, không gửi máy chủ, mất khi tải lại. Không nhập thông tin cá nhân thật.</p>
            <h3 className="mt-4 text-sm font-semibold">Còn thiếu khi nộp ({preview.missingAtSubmit.length})</h3>
            <ul className="mt-2 space-y-1 text-sm" data-testid="missing-list">
              {preview.missingAtSubmit.map(k => <li key={k} className="text-slate-700">• {labelOf(k)}</li>)}
            </ul>
            <p className="mt-3 text-xs text-slate-500">Danh sách này chỉ để xem trước; backend mới là nơi quyết định hợp lệ.</p>
            <button type="button" onClick={() => setDraft({})} className="mt-4 w-full rounded-xl px-3 py-2 text-sm font-medium text-brand-700 ring-1 ring-brand-100">Xóa nháp</button>
          </section>
          <section className="rounded-3xl bg-white p-5 shadow-sm ring-1 ring-slate-200">
            <button type="button" disabled data-testid="submit-claim" aria-describedby="submit-why"
              className="w-full cursor-not-allowed rounded-xl bg-slate-300 px-3 py-3 text-sm font-semibold text-slate-600">
              Nộp hồ sơ — chưa khả dụng
            </button>
            <p id="submit-why" className="mt-2 text-xs text-slate-600">
              Cần đăng nhập (#21), tải chứng từ (#26), API intake/claims (F6/#37) và đồng ý xử lý dữ liệu. Core API hiện chưa có các API này nên giao diện không gửi yêu cầu nào.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
