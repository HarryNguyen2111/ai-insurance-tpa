import example from '../../../../../docs/ai-specs/examples/intake-form-health-outpatient.example.json';
import { IntakePreviewView } from '@/components/intake-preview-view';
import type { IntakeFormConfig } from '@/lib/intake-preview';

export const metadata = { title: 'Tiếp nhận hồ sơ (xem trước) — TPA' };

export default function IntakePreviewPage() {
  return <IntakePreviewView config={example as unknown as IntakeFormConfig} />;
}
