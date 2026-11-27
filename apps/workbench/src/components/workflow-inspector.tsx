'use client';

import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Crosshair, Link2, Plus, Trash2 } from 'lucide-react';
import { NODE_LABELS, type EditorDocument, type WorkflowContent, type WorkflowEdge, type WorkflowNode } from '@/lib/workflow-definition';
import { connectionProblem, CONNECTION_MESSAGES, nextId, replaceEdge, replaceNode } from '@/lib/workflow-graph';
import { guardChoices, guardValue, PLACEHOLDER_KEY, type BuilderIssue } from '@/lib/workflow-inspector';
import {
  ACTION_LABELS, ACTIVITY_KIND_LABELS, APPROVED_BENEFITS, BENEFIT_LABELS, BENEFIT_TYPES, CANDIDATE_ROLE_LABELS, DATA_SCHEMAS, DOCUMENT_LABELS, DOCUMENT_TYPES,
  END_OUTCOME_LABELS, ESCALATION_LABELS, EVIDENCE_SOURCES, guardLabel, NODE_HELP, OWNER_LABELS, SCHEMA_LABELS, SOURCE_LABELS, STRATEGY_LABELS, TASK_KIND_LABELS,
} from '@/lib/workflow-labels';
import { ConditionBuilder } from './workflow-condition-builder';
import { NODE_ICONS } from './workflow-flow-canvas-icons';
import styles from './workflow-designer.module.css';

type Rule = WorkflowContent['assignmentPolicy']['rules'][number];
type Human = Extract<WorkflowNode, { type: 'HUMAN_TASK' }>;
type Ai = Extract<WorkflowNode, { type: 'AI_ACTIVITY' }>;
type Ref = Ai['modelRef'];
interface Ctx { issues: BuilderIssue[]; disabled: boolean }

const MINUTE = 60, HOUR = 3600, DAY = 86400;
const UNIT_LABELS: Record<number, string> = { 1: 'giây', [MINUTE]: 'phút', [HOUR]: 'giờ', [DAY]: 'ngày' };

/** Labelled control with help text and the field's current issues; `data-field` lets the drawer focus it. */
function Field({ ctx, field, label, help, children }: { ctx: Ctx; field: string; label: string; help?: string; children: (p: { id: string; 'data-field': string; 'aria-invalid': boolean; 'aria-describedby'?: string; disabled: boolean }) => ReactNode }) {
  const id = useId(), errors = ctx.issues.filter(i => i.field === field);
  const described = [help ? `${id}-help` : '', errors.length ? `${id}-err` : ''].filter(Boolean).join(' ');
  return <div className={styles.field} data-invalid={errors.length > 0 || undefined}>
    <label htmlFor={id}>{label}</label>
    {children({ id, 'data-field': field, 'aria-invalid': errors.length > 0, ...(described ? { 'aria-describedby': described } : {}), disabled: ctx.disabled })}
    {help && <p id={`${id}-help`} className={styles.hint}>{help}</p>}
    {errors.length > 0 && <p id={`${id}-err`} className={styles.fieldError}>{errors.map(e => e.message).join(' ')}</p>}
  </div>;
}
function Checks<T extends string>({ ctx, field, legend, help, options, values, onChange }: { ctx: Ctx; field: string; legend: string; help?: string; options: [T, string][]; values: T[]; onChange(v: T[]): void }) {
  const errors = ctx.issues.filter(i => i.field === field);
  return <fieldset className={styles.checks} data-field={field} tabIndex={-1} disabled={ctx.disabled} data-invalid={errors.length > 0 || undefined}>
    <legend>{legend}</legend>
    {help && <p className={styles.hint}>{help}</p>}
    {options.map(([value, label]) => <label key={value} className={styles.check}><input type="checkbox" checked={values.includes(value)}
      onChange={e => onChange(e.target.checked ? [...values, value] : values.filter(v => v !== value))} /><span>{label}<code>{value}</code></span></label>)}
    {errors.length > 0 && <p className={styles.fieldError}>{errors.map(e => e.message).join(' ')}</p>}
  </fieldset>;
}
function Duration({ ctx, field, label, help, seconds, units, onChange }: { ctx: Ctx; field: string; label: string; help?: string; seconds: number; units: number[]; onChange(s: number): void }) {
  const best = [...units].reverse().find(u => seconds > 0 && seconds % u === 0) ?? units[0];
  const [unit, setUnit] = useState(best);
  useEffect(() => { if (seconds > 0 && seconds % unit !== 0) setUnit(best); }, [seconds, unit, best]);
  return <Field ctx={ctx} field={field} label={label} help={help}>{p => <div className={styles.duration}>
    <input {...p} type="number" min={0} step="any" placeholder="chưa đặt" value={seconds > 0 ? seconds / unit : ''} onChange={e => onChange(e.target.value === '' ? 0 : Math.round(Number(e.target.value) * unit))} />
    <select aria-label={`Đơn vị · ${label}`} value={unit} disabled={p.disabled} onChange={e => { const u = Number(e.target.value); if (seconds > 0) onChange(Math.round((seconds / unit) * u)); setUnit(u); }}>
      {units.map(u => <option key={u} value={u}>{UNIT_LABELS[u]}</option>)}
    </select></div>}</Field>;
}
function Reminders({ ctx, field, values, units, onChange }: { ctx: Ctx; field: string; values: number[] | undefined; units: number[]; onChange(v: number[] | undefined): void }) {
  const list = values ?? [];
  return <fieldset className={styles.checks} data-field={field} tabIndex={-1} disabled={ctx.disabled}>
    <legend>Nhắc trước hạn (tối đa 3, tùy chọn)</legend>
    {list.map((v, i) => <div key={i} className={styles.inlineRow}>
      <Duration ctx={ctx} field={`${field}.${i}`} label={`Nhắc lần ${i + 1}`} seconds={v} units={units} onChange={s => onChange(list.map((x, j) => j === i ? s : x))} />
      <button type="button" className={styles.iconButton} aria-label={`Xóa nhắc lần ${i + 1}`} onClick={() => onChange(list.length > 1 ? list.filter((_, j) => j !== i) : undefined)}><Trash2 size={14} /></button>
    </div>)}
    {list.length < 3 && <button type="button" className={styles.textButton} onClick={() => onChange([...list, 0])}><Plus size={14} />Thêm lần nhắc</button>}
    {ctx.issues.filter(i => i.field === field).map((e, i) => <p key={i} className={styles.fieldError}>{e.message}</p>)}
  </fieldset>;
}
function RefField({ ctx, field, label, value, onChange }: { ctx: Ctx; field: string; label: string; value: Ref; onChange(v: Ref): void }) {
  const errors = ctx.issues.filter(i => i.field === field), placeholder = value.key === PLACEHOLDER_KEY;
  return <fieldset className={styles.checks} data-field={field} tabIndex={-1} disabled={ctx.disabled} data-invalid={errors.length > 0 || undefined}>
    <legend>{label}</legend>
    <div className={styles.refGrid}>
      <label>Mã<input value={placeholder ? '' : value.key} placeholder="ví dụ synthetic.vlm" spellCheck={false} onChange={e => onChange({ ...value, key: e.target.value || PLACEHOLDER_KEY })} /></label>
      <label>Phiên bản<input type="number" min={1} step={1} value={value.version} onChange={e => onChange({ ...value, version: Math.trunc(Number(e.target.value)) })} /></label>
      <label className={styles.wide}>Mã băm SHA-256<input value={/^0{64}$/.test(value.hash) ? '' : value.hash} placeholder="64 ký tự hex" spellCheck={false} onChange={e => onChange({ ...value, hash: e.target.value.trim().toLowerCase() || '0'.repeat(64) })} /></label>
    </div>
    {errors.length > 0 && <p className={styles.fieldError}>{errors.map(e => e.message).join(' ')}</p>}
  </fieldset>;
}

function RuleEditor({ ctx, rule, content, onChange }: { ctx: Ctx; rule: Rule; content: WorkflowContent; onChange(r: Rule): void }) {
  const humans = content.nodes.filter(n => n.type === 'HUMAN_TASK');
  const f = (k: string) => `rule.${rule.ruleKey}.${k}`;
  return <div className={styles.rule} role="group" aria-label={`Quy tắc phân công ${rule.ruleKey}`}>
    <Checks ctx={ctx} field={f('candidateRoles')} legend="Ứng viên (Responsible · ai được nhận việc)" help="Vai trò theo danh mục cố định của hợp đồng VWF-01. Danh bạ nhóm (#21) chưa sẵn sàng nên không hiển thị nhóm."
      options={(Object.keys(CANDIDATE_ROLE_LABELS) as Rule['candidateRoles']).map(r => [r, CANDIDATE_ROLE_LABELS[r]])} values={rule.candidateRoles} onChange={v => onChange({ ...rule, candidateRoles: v })} />
    <Field ctx={ctx} field={f('strategy')} label="Cách nhận việc">{p => <select {...p} value={rule.strategy} onChange={e => onChange({ ...rule, strategy: e.target.value as Rule['strategy'] })}>
      {(Object.keys(STRATEGY_LABELS) as Rule['strategy'][]).map(s => <option key={s} value={s}>{STRATEGY_LABELS[s]}</option>)}</select>}</Field>
    <Field ctx={ctx} field={f('maxActiveTasksPerAssignee')} label="Số việc đang mở tối đa mỗi người">{p => <input {...p} type="number" min={1} max={200} step={1}
      value={rule.maxActiveTasksPerAssignee || ''} onChange={e => onChange({ ...rule, maxActiveTasksPerAssignee: Math.trunc(Number(e.target.value)) || 0 })} />}</Field>
    {humans.length > 1 && <Checks ctx={ctx} field={f('distinctFromNodeIds')} legend="Tách nhiệm vụ: người nhận phải khác người đã xử lý"
      options={humans.map(n => [n.nodeId, n.label] as [string, string])} values={rule.distinctFromNodeIds} onChange={v => onChange({ ...rule, distinctFromNodeIds: v })} />}
  </div>;
}

function OwnerField({ ctx, value }: { ctx: Ctx; value: string }) {
  return <Field ctx={ctx} field="accountableOwner" label="Người chịu trách nhiệm (Accountable)" help="Luôn là con người; tác nhân AI không bao giờ là người chịu trách nhiệm.">
    {p => <select {...p} value={value} onChange={() => undefined}>{Object.entries(OWNER_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>;
}
function DataFields<N extends { inputSchemas: Human['inputSchemas']; outputSchemas: Human['outputSchemas'] }>({ ctx, node, set }: { ctx: Ctx; node: N; set(n: N): void }) {
  const options = DATA_SCHEMAS.map(s => [s, SCHEMA_LABELS[s]] as [typeof s, string]);
  return <details className={styles.more}><summary>Dữ liệu vào / ra ({node.inputSchemas.length} / {node.outputSchemas.length})</summary>
    <Checks ctx={ctx} field="inputSchemas" legend="Dữ liệu đầu vào" help="Phải do Bắt đầu (mã hồ sơ, bộ chứng từ) hoặc bước trước tạo ra." options={options} values={node.inputSchemas} onChange={v => set({ ...node, inputSchemas: v })} />
    <Checks ctx={ctx} field="outputSchemas" legend="Dữ liệu đầu ra" options={options} values={node.outputSchemas} onChange={v => set({ ...node, outputSchemas: v })} />
  </details>;
}
function Evidence({ ctx, value, set }: { ctx: Ctx; value: Human['allowedEvidence']; set(v: Human['allowedEvidence']): void }) {
  return <>
    <Checks ctx={ctx} field="allowedEvidence.documentTypes" legend="Chứng từ được dùng làm bằng chứng" options={DOCUMENT_TYPES.map(d => [d, DOCUMENT_LABELS[d]])} values={value.documentTypes} onChange={v => set({ ...value, documentTypes: v })} />
    <Checks ctx={ctx} field="allowedEvidence.sources" legend="Nguồn bằng chứng" options={EVIDENCE_SOURCES.map(s => [s, SOURCE_LABELS[s]])} values={value.sources} onChange={v => set({ ...value, sources: v })} />
  </>;
}

function NodeForm({ ctx, node, doc, change }: { ctx: Ctx; node: WorkflowNode; doc: EditorDocument; change(next: EditorDocument, tag?: string): void }) {
  const set = (n: WorkflowNode, tag?: string) => change(replaceNode(doc, n), tag && `n_${node.nodeId}:${tag}`);
  const rules = doc.content.assignmentPolicy.rules;
  const label = <Field ctx={ctx} field="label" label="Tên bước" help="Tên hiển thị; không nhập thông tin cá nhân.">{p => <input {...p} value={node.label} maxLength={120} onChange={e => set({ ...node, label: e.target.value }, 'label')} />}</Field>;
  switch (node.type) {
    case 'START': case 'CONDITION': return label;
    case 'END': return <>{label}<Field ctx={ctx} field="outcome" label="Kết quả kết thúc">{p => <select {...p} value={node.outcome} onChange={e => set({ ...node, outcome: e.target.value as typeof node.outcome })}>
      {Object.entries(END_OUTCOME_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field></>;
    case 'TIMER': return <>{label}<Duration ctx={ctx} field="delaySeconds" label="Thời gian chờ" help="Từ 1 phút tới 7 ngày." seconds={node.delaySeconds} units={[MINUTE, HOUR, DAY]} onChange={s => set({ ...node, delaySeconds: s }, 'delay')} /></>;
    case 'SUPPLEMENT_WAIT': return <>{label}<OwnerField ctx={ctx} value={node.accountableOwner} />
      <Duration ctx={ctx} field="maxWaitSeconds" label="Hạn bổ sung" help="Từ 1 tới 30 ngày. Hết hạn đi theo nhánh “Hết hạn bổ sung”." seconds={node.maxWaitSeconds} units={[DAY, HOUR]} onChange={s => set({ ...node, maxWaitSeconds: s }, 'wait')} />
      <Reminders ctx={ctx} field="reminderOffsetsSeconds" values={node.reminderOffsetsSeconds} units={[DAY, HOUR]} onChange={v => { const { reminderOffsetsSeconds: _r, ...rest } = node; set(v ? { ...rest, reminderOffsetsSeconds: v } : rest); }} />
      <DataFields ctx={ctx} node={node} set={n => set(n)} /></>;
    case 'HUMAN_TASK': {
      const rule = rules.find(r => r.ruleKey === node.assignmentRuleKey);
      const updateRule = (r: Rule) => change({ ...doc, content: { ...doc.content, assignmentPolicy: { ...doc.content.assignmentPolicy, rules: rules.map(x => x.ruleKey === r.ruleKey ? r : x) } } }, `rule_${r.ruleKey}`);
      return <>{label}
        <Field ctx={ctx} field="taskKind" label="Loại việc">{p => <select {...p} value={node.taskKind} onChange={e => set({ ...node, taskKind: e.target.value as Human['taskKind'] })}>
          {Object.entries(TASK_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        <Field ctx={ctx} field="assignmentRuleKey" label="Quy tắc phân công" help="Quy tắc dùng chung trong quy trình; sửa ứng viên bên dưới áp dụng cho mọi bước dùng quy tắc này.">
          {p => <select {...p} value={node.assignmentRuleKey} onChange={e => set({ ...node, assignmentRuleKey: e.target.value })}>
            {!rule && <option value={node.assignmentRuleKey}>{node.assignmentRuleKey} (không tồn tại)</option>}
            {rules.map(r => <option key={r.ruleKey} value={r.ruleKey}>{r.ruleKey} · {r.candidateRoles.map(c => CANDIDATE_ROLE_LABELS[c]).join(', ') || 'chưa có ứng viên'}</option>)}</select>}</Field>
        {rule && <RuleEditor ctx={ctx} rule={rule} content={doc.content} onChange={updateRule} />}
        <OwnerField ctx={ctx} value={node.accountableOwner} />
        <Duration ctx={ctx} field="sla.dueSeconds" label="SLA xử lý" help="Từ 1 giờ tới 14 ngày. Không có giá trị mặc định." seconds={node.sla.dueSeconds} units={[HOUR, DAY]} onChange={s => set({ ...node, sla: { ...node.sla, dueSeconds: s } }, 'sla')} />
        <Field ctx={ctx} field="sla.escalateTo" label="Chuyển cấp khi quá SLA">{p => <select {...p} value={node.sla.escalateTo} onChange={e => set({ ...node, sla: { ...node.sla, escalateTo: e.target.value as Human['sla']['escalateTo'] } })}>
          {Object.entries(ESCALATION_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
        <Reminders ctx={ctx} field="sla.reminderOffsetsSeconds" values={node.sla.reminderOffsetsSeconds} units={[HOUR, DAY]} onChange={v => { const { reminderOffsetsSeconds: _r, ...sla } = node.sla; set({ ...node, sla: v ? { ...sla, reminderOffsetsSeconds: v } : sla }); }} />
        <Checks ctx={ctx} field="allowedActionIds" legend="Hành động người xử lý được làm" help="Mỗi hành động cần đúng một nhánh ra."
          options={(['CONFIRM_EXTRACTION', 'REQUEST_SUPPLEMENT', 'ESCALATE_TO_MANUAL_REVIEW'] as const).map(a => [a, ACTION_LABELS[a]])} values={node.allowedActionIds} onChange={v => set({ ...node, allowedActionIds: v })} />
        <Evidence ctx={ctx} value={node.allowedEvidence} set={v => set({ ...node, allowedEvidence: v })} />
        <DataFields ctx={ctx} node={node} set={n => set(n)} />
        <details className={styles.more}><summary>Biểu mẫu đã ghim (tùy chọn)</summary>
          {node.formRef ? <><RefField ctx={ctx} field="formRef" label="Biểu mẫu xử lý" value={node.formRef} onChange={v => set({ ...node, formRef: v }, 'form')} />
            <button type="button" className={styles.textButton} disabled={ctx.disabled} onClick={() => { const { formRef: _f, ...rest } = node; set(rest); }}><Trash2 size={14} />Bỏ biểu mẫu</button></>
            : <button type="button" className={styles.textButton} disabled={ctx.disabled} onClick={() => set({ ...node, formRef: { key: PLACEHOLDER_KEY, version: 1, hash: '0'.repeat(64) } })}><Plus size={14} />Ghim biểu mẫu</button>}
        </details>
      </>;
    }
    case 'AI_ACTIVITY': return <>{label}
      <p role="note" className={styles.aiNote}>AI chỉ đề xuất có bằng chứng. Bước này không chạy AI trong trình thiết kế; mô hình, prompt và chính sách phải là phiên bản đã xuất bản, máy chủ kiểm tra khi xuất bản. Chưa có API danh mục mô hình nên nhập mã thủ công.</p>
      <Field ctx={ctx} field="activityKind" label="Loại tác vụ AI">{p => <select {...p} value={node.activityKind} onChange={e => set({ ...node, activityKind: e.target.value as Ai['activityKind'] })}>
        {Object.entries(ACTIVITY_KIND_LABELS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select>}</Field>
      <Field ctx={ctx} field="serviceActorScopeKey" label="Tác nhân AI (phạm vi dịch vụ)" help="Danh tính máy được cấp cho tổ chức; không phải người chịu trách nhiệm.">
        {p => <input {...p} spellCheck={false} placeholder="ví dụ ai.extraction.synthetic" value={node.serviceActorScopeKey === PLACEHOLDER_KEY ? '' : node.serviceActorScopeKey} onChange={e => set({ ...node, serviceActorScopeKey: e.target.value || PLACEHOLDER_KEY }, 'actor')} />}</Field>
      <OwnerField ctx={ctx} value={node.accountableOwner} />
      <Checks ctx={ctx} field="allowedActionIds" legend="Loại đề xuất AI được phép" options={(['PROPOSE_EXTRACTION', 'PROPOSE_DOCUMENT_LABEL', 'PROPOSE_QUALITY_FLAG'] as const).map(a => [a, ACTION_LABELS[a]])}
        values={node.allowedActionIds} onChange={v => set({ ...node, allowedActionIds: v })} />
      <RefField ctx={ctx} field="modelRef" label="Mô hình" value={node.modelRef} onChange={v => set({ ...node, modelRef: v }, 'model')} />
      <RefField ctx={ctx} field="promptRef" label="Prompt" value={node.promptRef} onChange={v => set({ ...node, promptRef: v }, 'prompt')} />
      <RefField ctx={ctx} field="policyRef" label="Chính sách sử dụng AI" value={node.policyRef} onChange={v => set({ ...node, policyRef: v }, 'policy')} />
      <Evidence ctx={ctx} value={node.allowedEvidence} set={v => set({ ...node, allowedEvidence: v })} />
      <Duration ctx={ctx} field="timeoutSeconds" label="Thời gian tối đa" help="30 giây tới 10 phút; quá hạn đi nhánh “AI lỗi” tới người xử lý." seconds={node.timeoutSeconds} units={[1, MINUTE]} onChange={s => set({ ...node, timeoutSeconds: s }, 'timeout')} />
      <details className={styles.more}><summary>Thử lại khi lỗi tạm thời</summary>
        {([['maxAttempts', 'Số lần thử (1–5)'], ['initialIntervalSeconds', 'Khoảng chờ đầu (giây, 1–60)'], ['backoffCoefficient', 'Hệ số giãn (1–4)'], ['maxIntervalSeconds', 'Khoảng chờ tối đa (giây, 1–600)']] as const).map(([k, l]) =>
          <Field key={k} ctx={ctx} field={`retry.${k}`} label={l}>{p => <input {...p} type="number" step={1} value={node.retry[k] || ''} onChange={e => set({ ...node, retry: { ...node.retry, [k]: Math.trunc(Number(e.target.value)) || 0 } }, `retry_${k}`)} />}</Field>)}
      </details>
      <DataFields ctx={ctx} node={node} set={n => set(n)} />
    </>;
  }
}

function EdgeForm({ ctx, edge, doc, change }: { ctx: Ctx; edge: WorkflowEdge; doc: EditorDocument; change(next: EditorDocument, tag?: string): void }) {
  const source = doc.content.nodes.find(n => n.nodeId === edge.source), target = doc.content.nodes.find(n => n.nodeId === edge.target);
  const set = (e: WorkflowEdge, tag?: string) => change(replaceEdge(doc, e), tag && `e_${edge.edgeId}:${tag}`);
  const choices = guardChoices(source), current = guardValue(edge.guard);
  const siblings = doc.content.edges.filter(e => e.source === edge.source && e.edgeId !== edge.edgeId);
  return <>
    <dl className={styles.facts}><dt>Từ bước</dt><dd>{source?.label ?? edge.source}</dd><dt>Đến bước</dt><dd>{target?.label ?? edge.target}</dd></dl>
    <Field ctx={ctx} field="guard" label="Nhánh đi khi" help={source?.type === 'CONDITION' ? 'Nhánh điều kiện xét theo thứ tự ưu tiên; nếu không nhánh nào đúng thì đi nhánh Mặc định.' : 'Mỗi hành động/kết quả của bước nguồn cần đúng một nhánh.'}>
      {p => <select {...p} value={choices.some(c => c.value === current) ? current : ''} onChange={e => {
        const choice = choices.find(c => c.value === e.target.value);
        if (!choice) return;
        const priority = choice.guard.kind === 'CONDITION' ? Math.min(10, Math.max(0, ...siblings.map(s => s.guard.kind === 'CONDITION' ? s.guard.priority : 0)) + 1) : 0;
        const guard = choice.guard.kind === 'CONDITION' ? { ...choice.guard, priority } : choice.guard;
        const { loopBack: _l, ...rest } = edge;
        set(guard.kind === 'CONDITION' || guard.kind === 'DEFAULT' ? { ...edge, guard } : { ...rest, guard });
      }}>
        {!choices.some(c => c.value === current) && <option value="">{guardLabel(edge) || edge.guard.kind} (không hợp với bước nguồn)</option>}
        {choices.map(c => <option key={c.value} value={c.value}>{guardLabel({ ...edge, guard: c.guard, loopBack: undefined }) || 'Đi tiếp'}{c.guard.kind === 'CONDITION' ? '…' : ''}</option>)}
      </select>}</Field>
    {edge.guard.kind === 'CONDITION' && (() => {
      const g = edge.guard;
      return <>
        <Field ctx={ctx} field="guard.priority" label="Thứ tự ưu tiên (1–10)" help="Số nhỏ được xét trước; không trùng với nhánh điều kiện khác.">{p => <input {...p} type="number" min={1} max={10} step={1} value={g.priority || ''}
          onChange={e => set({ ...edge, guard: { ...g, priority: Math.trunc(Number(e.target.value)) || 0 } }, 'priority')} />}</Field>
        <ConditionBuilder condition={g.condition} disabled={ctx.disabled} onChange={condition => set({ ...edge, guard: { ...g, condition } }, 'condition')} />
      </>;
    })()}
    {source?.type === 'CONDITION' && <fieldset className={styles.checks} data-field="loopBack" tabIndex={-1} disabled={ctx.disabled}>
      <legend>Vòng lặp có giới hạn</legend>
      <label className={styles.check}><input type="checkbox" checked={!!edge.loopBack} onChange={e => { const { loopBack: _l, ...rest } = edge; set(e.target.checked ? { ...edge, loopBack: { maxIterations: 1 } } : rest); }} />Nhánh này quay lại bước trước</label>
      {edge.loopBack && <Field ctx={ctx} field="loopBack.maxIterations" label="Số lần lặp tối đa (1–5)" help="Hết số lần, nhánh được coi là sai và quy trình đi nhánh Mặc định.">{p => <input {...p} type="number" min={1} max={5} step={1} value={edge.loopBack!.maxIterations || ''}
        onChange={e => set({ ...edge, loopBack: { maxIterations: Math.trunc(Number(e.target.value)) || 0 } }, 'loop')} />}</Field>}
    </fieldset>}
  </>;
}

function WorkflowForm({ ctx, doc, keyLocked, change }: { ctx: Ctx; doc: EditorDocument; keyLocked: boolean; change(next: EditorDocument, tag?: string): void }) {
  const c = doc.content, rules = c.assignmentPolicy.rules;
  const setContent = (next: WorkflowContent, tag?: string) => change({ ...doc, content: next }, tag);
  const setRules = (next: Rule[]) => setContent({ ...c, assignmentPolicy: { ...c.assignmentPolicy, rules: next } });
  return <>
    <Field ctx={ctx} field="workflowKey" label="Mã quy trình" help={keyLocked ? 'Mã đã cố định trên máy chủ.' : 'Chữ thường, số, gạch dưới; dùng để gắn quy trình với loại quyền lợi.'}>
      {p => <input {...p} disabled={p.disabled || keyLocked} spellCheck={false} value={c.workflowKey} onChange={e => setContent({ ...c, workflowKey: e.target.value }, 'wf:key')} />}</Field>
    <Checks ctx={{ ...ctx }} field="scope.benefitTypes" legend="Áp dụng cho loại quyền lợi" help="Phase 1 chỉ duyệt Ngoại trú, Nha khoa, Nội trú; loại khác sẽ bị máy chủ từ chối."
      options={BENEFIT_TYPES.map(b => [b, `${BENEFIT_LABELS[b]}${APPROVED_BENEFITS.includes(b) ? '' : ' (ngoài Phase 1)'}`])} values={c.scope.benefitTypes} onChange={v => setContent({ ...c, scope: { benefitTypes: v } })} />
    <h3 className={styles.subhead}>Quy tắc phân công</h3>
    {rules.map(r => {
      const used = c.nodes.some(n => n.type === 'HUMAN_TASK' && n.assignmentRuleKey === r.ruleKey);
      return <div key={r.ruleKey} className={styles.ruleBox}>
        <div className={styles.inlineRow}><strong>{r.ruleKey}</strong>
          <button type="button" className={styles.textButton} disabled={ctx.disabled || used || rules.length < 2} title={used ? 'Đang được bước người xử lý dùng' : rules.length < 2 ? 'Cần ít nhất một quy tắc' : undefined}
            onClick={() => setRules(rules.filter(x => x.ruleKey !== r.ruleKey))}><Trash2 size={14} />Xóa quy tắc</button></div>
        <RuleEditor ctx={ctx} rule={r} content={c} onChange={next => setRules(rules.map(x => x.ruleKey === r.ruleKey ? next : x))} />
      </div>;
    })}
    {rules.length < 20 && <button type="button" className={styles.textButton} disabled={ctx.disabled} onClick={() => setRules([...rules, {
      ruleKey: nextId('rule', k => rules.some(r => r.ruleKey === k)), candidateRoles: [], strategy: 'QUEUE_CLAIM', accountableOwner: 'CASE_OWNER', distinctFromNodeIds: [], maxActiveTasksPerAssignee: 0,
    }])}><Plus size={14} />Thêm quy tắc phân công</button>}
  </>;
}

export interface FocusRequest { field?: string; nonce: number }
export function WorkflowInspector({ doc, selected, disabled, keyLocked, issues, focus, change, onSelect, onConnect, onDelete, onCenter }: {
  doc: EditorDocument; selected: string; disabled: boolean; keyLocked: boolean; issues: BuilderIssue[]; focus: FocusRequest | null;
  change(next: EditorDocument, tag?: string): void; onSelect(id: string): void; onConnect(source: string, target: string): void;
  onDelete(id: string): void; onCenter(nodeId: string): void;
}) {
  const ref = useRef<HTMLElement>(null), headingRef = useRef<HTMLHeadingElement>(null);
  const node = selected.startsWith('n_') ? doc.content.nodes.find(n => n.nodeId === selected.slice(2)) : undefined;
  const edge = selected.startsWith('e_') ? doc.content.edges.find(e => e.edgeId === selected.slice(2)) : undefined;
  const mine = issues.filter(i => node ? i.nodeId === node.nodeId : edge ? i.edgeId === edge.edgeId : !i.nodeId && !i.edgeId);
  const ctx: Ctx = { issues: mine, disabled };
  const [target, setTarget] = useState('');
  // Focus after DOM commit: the requested field, else the panel heading (collapsed <details> are opened first).
  useEffect(() => {
    if (!focus) return;
    const root = ref.current;
    const el = focus.field ? root?.querySelector<HTMLElement>(`[data-field="${CSS.escape(focus.field)}"]`) ?? root?.querySelector<HTMLElement>(`[data-field^="${CSS.escape(focus.field)}"]`) : null;
    el?.closest('details')?.setAttribute('open', '');
    (el ?? headingRef.current)?.focus();
    el?.scrollIntoView({ block: 'center' });
  }, [focus]);
  const Icon = node ? NODE_ICONS[node.type] : Link2;
  const outgoing = node ? doc.content.edges.filter(e => e.source === node.nodeId) : [];
  const targets = node ? doc.content.nodes.filter(n => connectionProblem(doc, node.nodeId, n.nodeId) === null) : [];
  return <aside ref={ref} className={styles.inspector} aria-label="Thuộc tính">
    <header className={styles.inspectorHead}>
      {(node || edge) && <span className={styles.cardIcon} aria-hidden="true"><Icon size={15} /></span>}
      <div>
        <h2 ref={headingRef} tabIndex={-1}>{node ? node.label : edge ? `Nhánh ${guardLabel(edge) || 'tiếp theo'}` : 'Thiết lập quy trình'}</h2>
        <p className={styles.hint}>{node ? <>{NODE_LABELS[node.type]} · <code>{node.nodeId}</code></> : edge ? <>Nhánh · <code>{edge.edgeId}</code></> : 'Chọn một bước hoặc nhánh trên sơ đồ để sửa.'}</p>
      </div>
      {node && <button type="button" className={styles.iconButton} aria-label="Căn giữa bước trên sơ đồ" onClick={() => onCenter(node.nodeId)}><Crosshair size={15} /></button>}
    </header>
    {node && <p className={styles.hint}>{NODE_HELP[node.type]}</p>}
    {mine.length > 0 && <p className={styles.fieldError} role="note">{mine.length} vấn đề ở {node ? 'bước' : edge ? 'nhánh' : 'thiết lập'} này; các ô liên quan được đánh dấu.</p>}
    <div className={styles.inspectorBody}>
      {node ? <NodeForm key={node.nodeId} ctx={ctx} node={node} doc={doc} change={change} />
        : edge ? <EdgeForm key={edge.edgeId} ctx={ctx} edge={edge} doc={doc} change={change} />
          : <WorkflowForm ctx={ctx} doc={doc} keyLocked={keyLocked} change={change} />}
      {node && <section className={styles.connectBox} aria-label="Nhánh ra">
        <h3 className={styles.subhead}>Nhánh ra ({outgoing.length})</h3>
        <ul>{outgoing.map(e => <li key={e.edgeId}><button type="button" className={styles.linkButton} onClick={() => onSelect(`e_${e.edgeId}`)}>
          {guardLabel(e) || 'Đi tiếp'} → {doc.content.nodes.find(n => n.nodeId === e.target)?.label ?? e.target}</button></li>)}</ul>
        {node.type !== 'END' && <div className={styles.inlineRow}>
          <label className={styles.grow}>Nối tới bước<select value={target} disabled={disabled} onChange={e => setTarget(e.target.value)}>
            <option value="">Chọn bước đích…</option>
            {targets.map(n => <option key={n.nodeId} value={n.nodeId}>{n.label} · {n.nodeId}</option>)}</select></label>
          <button type="button" className={styles.secondaryButton} disabled={disabled || !target} onClick={() => { onConnect(node.nodeId, target); setTarget(''); }}><Link2 size={14} />Thêm nhánh</button>
        </div>}
        {node.type !== 'END' && targets.length === 0 && <p className={styles.hint}>{doc.content.edges.length >= 100 ? CONNECTION_MESSAGES.LIMIT_EXCEEDED : 'Không còn bước nào có thể nối tới.'}</p>}
      </section>}
      {(node || edge) && <button type="button" className={styles.dangerButton} disabled={disabled} onClick={() => onDelete(selected)}>
        <Trash2 size={14} />{node ? 'Xóa bước và các nhánh nối' : 'Xóa nhánh'}</button>}
    </div>
  </aside>;
}
