'use client';

import { useMemo, useState } from 'react';
import { buildIntakePreview, type DraftValues, type IntakeFormConfig, type PreviewField } from '@/lib/intake-preview';

const DOC_TYPE_LABELS: Record<string, string> = {
  INVOICE_PHOTO: 'Ảnh hóa đơn', ITEMIZED_LIST: 'Bảng kê', PRESCRIPTION: 'Đơn thuốc', LAB_ORDER: 'Chỉ định xét nghiệm', LAB_RESULT: 'Kết quả xét nghiệm',
};

function Badge({ children, tone = 'slate' }: { children: React.ReactNode; tone?: 'slate' | 'brand' | 'amber' | 'rose' | 'emerald' }) {
  const tones = {
    slate: 'bg-muted text-muted-foreground', brand: 'bg-primary/10 text-primary', amber: 'bg-amber-100 text-amber-900 dark:bg-amber-950/50 dark:text-amber-200',
    rose: 'bg-rose-50 text-rose-700 dark:bg-rose-950/50 dark:text-rose-300', emerald: 'bg-emerald-50 text-emerald-800 dark:bg-emerald-950/50 dark:text-emerald-300',
  } as const;
  return <span className={`rounded-full px-2 py-0.5 text-[11px] font-medium ${tones[tone]}`}>{children}</span>;
}

function FieldControl({ field, value, onChange }: { field: PreviewField; value: DraftValues[string]; onChange: (v: string | boolean | undefined) => void }) {
  const id = `f-${field.key}`;
  if (field.availability.kind === 'INFO') {
    return <p className="rounded-lg bg-primary/10 p-3 text-sm text-foreground">{field.label}</p>;
  }
  if (field.availability.kind === 'NEEDS_BACKEND') {
    return (
      <div className="space-y-2">
        {field.component === 'DOCUMENT_SLOT' ? (
          <button type="button" disabled data-testid={`upload-${field.key}`}
            className="w-full cursor-not-allowed rounded-xl border-2 border-dashed border-border bg-muted/40 px-3 py-4 text-sm text-muted-foreground">
            Tải chứng từ — chưa khả dụng
          </button>
        ) : (
          <input id={id} disabled aria-describedby={`${id}-dep`} placeholder="Chưa khả dụng trong bản xem trước"
            className="w-full cursor-not-allowed rounded-md border bg-muted/40 px-3 py-2 text-sm text-muted-foreground" />
        )}
        <p id={`${id}-dep`} className="text-xs text-muted-foreground">Cần backend: {field.availability.dependency}</p>
      </div>
    );
  }
  switch (field.component) {
    case 'SINGLE_SELECT':
      return (
        <select id={id} data-testid={`draft-${field.key}`} value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm">
          <option value="">— Chọn —</option>
          {field.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      );
    case 'DATE':
      return (
        <input id={id} type="date" data-testid={`draft-${field.key}`} value={typeof value === 'string' ? value : ''}
          onChange={e => onChange(e.target.value === '' ? undefined : e.target.value)}
          className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm" />
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
      <header className="rounded-xl border bg-card p-5 text-card-foreground shadow-xs sm:p-6">
        <div className="flex flex-wrap items-center gap-2">
          <Badge tone="amber">XEM TRƯỚC — không gửi dữ liệu</Badge>
          <Badge>Cấu hình mẫu tổng hợp · {preview.formKey}</Badge>
        </div>
        <h1 className="mt-3 text-2xl font-semibold tracking-tight">{preview.title}</h1>
        <p className="mt-1 text-sm text-muted-foreground">
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
              className={`rounded-xl border bg-card p-5 text-card-foreground shadow-xs ${step.visible ? '' : 'opacity-60'}`}>
              <div className="flex flex-wrap items-center gap-2">
                <span className="grid h-7 w-7 place-items-center rounded-full bg-primary text-xs font-bold text-primary-foreground">{index + 1}</span>
                <h2 className="text-base font-semibold">{step.title}</h2>
                {step.conditional && <Badge tone={step.visible ? 'emerald' : 'slate'}>{step.visible ? 'Đang hiển thị theo điều kiện' : 'Ẩn — chưa thỏa điều kiện'}</Badge>}
              </div>
              {step.help && <p className="mt-1 text-sm text-muted-foreground">{step.help}</p>}
              {step.visible && (
                <div className="mt-4 grid gap-4 sm:grid-cols-2">
                  {step.fields.filter(f => f.visible).map(field => (
                    <div key={field.key} data-testid={`field-${field.key}`} className={`space-y-2 rounded-lg border bg-muted/30 p-4 ${field.halfWidth ? '' : 'sm:col-span-2'}`}>
                      {field.availability.kind !== 'INFO' && (
                        <div className="flex flex-wrap items-center gap-2">
                          <label htmlFor={`f-${field.key}`} className="text-sm font-semibold text-foreground">{field.label}</label>
                          {field.requiredAtSubmit && <Badge tone="rose">Bắt buộc khi nộp</Badge>}
                          {field.availability.kind === 'LOCAL_DRAFT' && <Badge tone="emerald">Nháp cục bộ</Badge>}
                          {field.aiPrefill && <Badge>AI có thể đề xuất — chưa hoạt động</Badge>}
                        </div>
                      )}
                      {field.help && <p className="text-xs text-muted-foreground">{field.help}</p>}
                      <FieldControl field={field} value={draft[field.key]} onChange={v => setDraft(d => ({ ...d, [field.key]: v }))} />
                      {field.docTypes.length > 0 && (
                        <p className="text-xs text-muted-foreground">Loại chứng từ: {field.docTypes.map(t => DOC_TYPE_LABELS[t] ?? t).join(', ')}</p>
                      )}
                      <p className="text-[11px] text-muted-foreground">{field.componentLabel} · {field.bindingLabel}</p>
                    </div>
                  ))}
                  {step.fields.some(f => !f.visible) && (
                    <p className="text-xs text-muted-foreground sm:col-span-2">Một số trường đang ẩn theo điều kiện hiển thị của cấu hình.</p>
                  )}
                </div>
              )}
            </li>
          ))}
        </ol>

        <aside className="space-y-4 lg:sticky lg:top-28 lg:self-start">
          <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-xs" data-testid="draft-summary">
            <h2 className="text-base font-semibold">Nháp cục bộ</h2>
            <p className="mt-1 text-xs text-muted-foreground">Chỉ nằm trong bộ nhớ trang này: không lưu trình duyệt, không gửi máy chủ, mất khi tải lại. Không nhập thông tin cá nhân thật.</p>
            <h3 className="mt-4 text-sm font-semibold">Còn thiếu khi nộp ({preview.missingAtSubmit.length})</h3>
            <ul className="mt-2 space-y-1 text-sm" data-testid="missing-list">
              {preview.missingAtSubmit.map(k => <li key={k} className="text-foreground">• {labelOf(k)}</li>)}
            </ul>
            <p className="mt-3 text-xs text-muted-foreground">Danh sách này chỉ để xem trước; backend mới là nơi quyết định hợp lệ.</p>
            <button type="button" onClick={() => setDraft({})} className="mt-4 w-full rounded-xl px-3 py-2 text-sm font-medium text-primary ring-1 ring-border hover:bg-muted">Xóa nháp</button>
          </section>
          <section className="rounded-xl border bg-card p-5 text-card-foreground shadow-xs">
            <button type="button" disabled data-testid="submit-claim" aria-describedby="submit-why"
              className="w-full cursor-not-allowed rounded-md bg-muted px-3 py-3 text-sm font-semibold text-muted-foreground">
              Nộp hồ sơ — chưa khả dụng
            </button>
            <p id="submit-why" className="mt-2 text-xs text-muted-foreground">
              Cần đăng nhập (#21), tải chứng từ (#26), API intake/claims (F6/#37) và đồng ý xử lý dữ liệu. Core API hiện chưa có các API này nên giao diện không gửi yêu cầu nào.
            </p>
          </section>
        </aside>
      </div>
    </div>
  );
}
