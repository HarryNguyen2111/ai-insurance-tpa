// Read-only PREVIEW model of an intake form config (docs/ai-specs/11-dynamic-intake-design.md,
// example in docs/ai-specs/examples). This is NOT the F2 `packages/intake-rules`
// validator/evaluator and is never a source of decisions: backend validation is
// authoritative. It only explains, in Vietnamese, what the configured form would
// collect and which backend capability each field still waits for.

export type Condition =
  | { field: string; op: string; value?: unknown }
  | { all: Condition[] }
  | { any: Condition[] }
  | { not: Condition };

export interface IntakeField {
  key: string;
  binding: { kind: 'CANONICAL'; path: string } | { kind: 'EXTENSION'; extensionKey: string; catalogVersion: number } | { kind: 'NONE' };
  component: string;
  label: string;
  help?: string;
  options?: { value: string; label: string }[];
  requiredAt: 'NEVER' | 'SUBMIT';
  requiredWhen?: Condition;
  visibleWhen?: Condition;
  aiPrefill?: boolean;
  constraints?: Record<string, unknown>;
  docTypes?: string[];
  layout?: { webWidth?: 'FULL' | 'HALF' };
}

export interface IntakeStep {
  stepKey: string;
  title: string;
  help?: string;
  visibleWhen?: Condition;
  fieldKeys: string[];
}

export interface IntakeFormConfig {
  schemaVersion: string;
  formKey: string;
  title: string;
  description?: string;
  scope: { eventType: string; benefitTypes: string[]; channels: string[] };
  steps: IntakeStep[];
  fields: IntakeField[];
}

export type DraftValue = string | boolean | undefined;
export type DraftValues = Readonly<Record<string, DraftValue>>;

export type Availability =
  | { kind: 'LOCAL_DRAFT' }
  | { kind: 'INFO' }
  | { kind: 'NEEDS_BACKEND'; dependency: string };

export class UnsupportedPreviewError extends Error {}

const COMPONENT_LABELS: Record<string, string> = {
  MEMBER_PICKER: 'Chọn người được bảo hiểm',
  DOCUMENT_SLOT: 'Ô tải chứng từ',
  TEXTAREA: 'Đoạn văn bản',
  DATE: 'Ngày',
  PROVIDER_PICKER: 'Chọn cơ sở y tế',
  ICD10_PICKER: 'Chọn mã ICD-10',
  MONEY: 'Số tiền (chuỗi thập phân)',
  SINGLE_SELECT: 'Chọn một',
  MULTI_SELECT: 'Chọn nhiều',
  BOOLEAN: 'Có / Không',
  NUMBER_INT: 'Số nguyên',
  INFO: 'Thông báo',
};

const EVENT_LABELS: Record<string, string> = {
  OUTPATIENT_VISIT: 'Khám ngoại trú',
  HOSPITALIZATION: 'Nằm viện',
};

const BENEFIT_LABELS: Record<string, string> = {
  OUTPATIENT: 'Ngoại trú',
  DENTAL: 'Nha khoa',
  INPATIENT: 'Nội trú',
};

const CHANNEL_LABELS: Record<string, string> = { WEB: 'Web', ZALO: 'Zalo Mini App' };

// Backend capability each canonical field still waits for (issue/task IDs from spec 11 §13).
const CANONICAL_DEPENDENCIES: Record<string, string> = {
  memberId: 'Danh tính & membership đã xác minh (#21, GET /v1/me/memberships)',
  documents: 'Tải chứng từ qua Pre-signed URL và quét an toàn (#26, POST /v1/claims/upload-url)',
  narrative: 'Lưu mã hóa AES-256-GCM phía server (F3); không giữ trong trình duyệt',
  visitDate: 'API intake kiểm tra ngày theo hiệu lực hợp đồng (F6)',
  providerId: 'Danh mục cơ sở y tế phía server (F5/F6)',
  icd10Code: 'Danh mục ICD-10 phía server (F6)',
  totalRequested: 'API intake + intake-rules, tiền dạng chuỗi Decimal (F2/F6)',
  admitDatetime: 'API intake (F6)',
  dischargeDatetime: 'API intake (F6)',
  hasSurgeryCert: 'API intake (F6)',
};

const LOCAL_DRAFT_COMPONENTS = new Set(['SINGLE_SELECT', 'BOOLEAN', 'DATE']);

export function componentLabel(component: string): string {
  const label = COMPONENT_LABELS[component];
  if (!label) throw new UnsupportedPreviewError(`Unsupported component ${component}`);
  return label;
}

export function availabilityOf(field: IntakeField): Availability {
  if (field.component === 'INFO') return { kind: 'INFO' };
  if (field.binding.kind === 'EXTENSION' && LOCAL_DRAFT_COMPONENTS.has(field.component)) {
    return { kind: 'LOCAL_DRAFT' };
  }
  if (field.binding.kind === 'CANONICAL') {
    return { kind: 'NEEDS_BACKEND', dependency: CANONICAL_DEPENDENCIES[field.binding.path] ?? 'API intake (F6)' };
  }
  return { kind: 'NEEDS_BACKEND', dependency: 'API intake (F6)' };
}

function isSet(value: DraftValue): boolean {
  return value !== undefined && value !== '';
}

export function evaluateCondition(condition: Condition, values: DraftValues, depth = 0): boolean {
  if (depth > 3) throw new UnsupportedPreviewError('Condition depth exceeds 3');
  if ('all' in condition) return condition.all.every(c => evaluateCondition(c, values, depth + 1));
  if ('any' in condition) return condition.any.some(c => evaluateCondition(c, values, depth + 1));
  if ('not' in condition) return !evaluateCondition(condition.not, values, depth + 1);
  const current = values[condition.field];
  switch (condition.op) {
    case 'IS_SET':
      return isSet(current);
    case 'IS_NOT_SET':
      return !isSet(current);
    case 'EQ':
      return isSet(current) && current === condition.value;
    case 'NEQ':
      return isSet(current) && current !== condition.value;
    case 'IN':
      return isSet(current) && Array.isArray(condition.value) && condition.value.includes(current);
    case 'NOT_IN':
      return isSet(current) && Array.isArray(condition.value) && !condition.value.includes(current);
    default:
      // GT/GTE/LT/LTE need typed Money/date comparison owned by F2 intake-rules.
      throw new UnsupportedPreviewError(`Operator ${condition.op} is not evaluated in the preview`);
  }
}

export interface PreviewField {
  key: string;
  label: string;
  help?: string;
  component: string;
  componentLabel: string;
  bindingLabel: string;
  options: { value: string; label: string }[];
  availability: Availability;
  aiPrefill: boolean;
  visible: boolean;
  requiredAtSubmit: boolean;
  conditional: boolean;
  docTypes: string[];
  halfWidth: boolean;
}

export interface PreviewStep {
  stepKey: string;
  title: string;
  help?: string;
  visible: boolean;
  conditional: boolean;
  fields: PreviewField[];
}

export interface IntakePreview {
  formKey: string;
  title: string;
  description?: string;
  eventLabel: string;
  benefitLabels: string[];
  channelLabels: string[];
  steps: PreviewStep[];
  missingAtSubmit: string[];
}

function bindingLabel(field: IntakeField): string {
  switch (field.binding.kind) {
    case 'CANONICAL':
      return `Trường chuẩn · canonical.${field.binding.path}`;
    case 'EXTENSION':
      return `Trường mở rộng · ${field.binding.extensionKey} (catalog v${field.binding.catalogVersion})`;
    default:
      return 'Chỉ hiển thị';
  }
}

export function buildIntakePreview(config: IntakeFormConfig, values: DraftValues = {}): IntakePreview {
  const fieldsByKey = new Map(config.fields.map(f => [f.key, f]));
  const missingAtSubmit: string[] = [];
  const steps = config.steps.map(step => {
    const stepVisible = step.visibleWhen ? evaluateCondition(step.visibleWhen, values) : true;
    const fields = step.fieldKeys.map(key => {
      const field = fieldsByKey.get(key);
      if (!field) throw new UnsupportedPreviewError(`Step ${step.stepKey} references unknown field ${key}`);
      const visible = stepVisible && (field.visibleWhen ? evaluateCondition(field.visibleWhen, values) : true);
      const requiredAtSubmit = visible && (field.requiredAt === 'SUBMIT' || (field.requiredWhen ? evaluateCondition(field.requiredWhen, values) : false));
      if (requiredAtSubmit && !isSet(values[field.key])) missingAtSubmit.push(field.key);
      return {
        key: field.key,
        label: field.label,
        help: field.help,
        component: field.component,
        componentLabel: componentLabel(field.component),
        bindingLabel: bindingLabel(field),
        options: field.options ?? [],
        availability: availabilityOf(field),
        aiPrefill: field.aiPrefill === true,
        visible,
        requiredAtSubmit,
        conditional: field.visibleWhen !== undefined || field.requiredWhen !== undefined,
        docTypes: field.docTypes ?? [],
        halfWidth: field.layout?.webWidth === 'HALF',
      } satisfies PreviewField;
    });
    return { stepKey: step.stepKey, title: step.title, help: step.help, visible: stepVisible, conditional: step.visibleWhen !== undefined, fields };
  });
  return {
    formKey: config.formKey,
    title: config.title,
    description: config.description,
    eventLabel: EVENT_LABELS[config.scope.eventType] ?? config.scope.eventType,
    benefitLabels: config.scope.benefitTypes.map(b => BENEFIT_LABELS[b] ?? b),
    channelLabels: config.scope.channels.map(c => CHANNEL_LABELS[c] ?? c),
    steps,
    missingAtSubmit,
  };
}
