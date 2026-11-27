'use client';

import { Plus, Trash2 } from 'lucide-react';
import { buildCondition, conditionParts, leafProblem, newLeaf, withOp, withVariable, type ConditionMode } from '@/lib/workflow-inspector';
import { BENEFIT_LABELS, BENEFIT_TYPES, OP_LABELS, OPS_FOR, VARIABLES, type BenefitType, type ConditionLeaf, type ConditionOp, type ConditionVariable, type Guard } from '@/lib/workflow-labels';
import styles from './workflow-designer.module.css';

type Condition = Extract<Guard, { kind: 'CONDITION' }>['condition'];
const MODES: Record<ConditionMode, string> = { single: 'Một điều kiện', all: 'Tất cả đều đúng (VÀ)', any: 'Ít nhất một đúng (HOẶC)' };

/** Operator/field/value rows that can only express contract-valid WorkflowCondition shapes (no raw guard JSON). */
export function ConditionBuilder({ condition, disabled, onChange }: { condition: Condition; disabled: boolean; onChange(next: Condition): void }) {
  const { mode, leaves } = conditionParts(condition);
  const set = (nextMode: ConditionMode, next: ConditionLeaf[]) => onChange(buildCondition(nextMode, next));
  const update = (i: number, leaf: ConditionLeaf) => set(mode, leaves.map((l, j) => j === i ? leaf : l));
  return <fieldset className={styles.condition} disabled={disabled} data-field="guard.condition" tabIndex={-1}>
    <legend>Điều kiện rẽ nhánh</legend>
    <p className={styles.hint}>Biến do máy chủ tính từ hồ sơ; chỉ chọn đường đi, không cấp quyền hay quyết định tiền.</p>
    <label>Cách kết hợp<select value={mode} onChange={e => set(e.target.value as ConditionMode, e.target.value === 'single' ? leaves.slice(0, 1) : leaves)}>
      {(Object.keys(MODES) as ConditionMode[]).map(m => <option key={m} value={m}>{MODES[m]}</option>)}
    </select></label>
    {leaves.map((leaf, i) => {
      const meta = VARIABLES[leaf.variable], problem = leafProblem(leaf), id = `cond-${i}`;
      return <div key={i} className={styles.conditionRow} role="group" aria-label={`Điều kiện ${i + 1}`} data-invalid={!!problem || undefined}>
        <label>Biến<select data-field={`guard.condition.${i}`} value={leaf.variable} aria-invalid={!!problem} aria-describedby={problem ? `${id}-err` : undefined}
          onChange={e => update(i, withVariable(leaf, e.target.value as ConditionVariable))}>
          {(Object.keys(VARIABLES) as ConditionVariable[]).map(v => <option key={v} value={v}>{VARIABLES[v].label}</option>)}
        </select></label>
        <label>Phép so sánh<select value={leaf.op} onChange={e => update(i, withOp(leaf, e.target.value as ConditionOp))}>
          {OPS_FOR[meta.type].map(op => <option key={op} value={op}>{OP_LABELS[op]}</option>)}
        </select></label>
        {meta.type === 'count'
          ? <label>Giá trị (số nguyên 0–1000)<input type="number" min={0} max={1000} step={1} value={typeof leaf.value === 'number' ? leaf.value : ''}
            onChange={e => update(i, { ...leaf, value: e.target.value === '' ? -1 : Math.trunc(Number(e.target.value)) } as ConditionLeaf)} /></label>
          : leaf.op === 'IN'
            ? <fieldset className={styles.checks}><legend>Giá trị (một hoặc nhiều)</legend>{BENEFIT_TYPES.map(b => {
              const values = Array.isArray(leaf.value) ? leaf.value : [];
              return <label key={b} className={styles.check}><input type="checkbox" checked={values.includes(b)}
                onChange={e => update(i, { ...leaf, value: e.target.checked ? [...values, b] : values.filter(v => v !== b) } as ConditionLeaf)} />{BENEFIT_LABELS[b]}</label>;
            })}</fieldset>
            : <label>Giá trị<select value={typeof leaf.value === 'string' ? leaf.value : ''} onChange={e => update(i, { ...leaf, value: e.target.value as BenefitType } as ConditionLeaf)}>
              {BENEFIT_TYPES.map(b => <option key={b} value={b}>{BENEFIT_LABELS[b]}</option>)}</select></label>}
        {leaves.length > 1 && <button type="button" className={styles.iconButton} aria-label={`Xóa điều kiện ${i + 1}`} onClick={() => set(mode, leaves.filter((_, j) => j !== i))}><Trash2 size={14} /></button>}
        {problem && <p id={`${id}-err`} className={styles.fieldError}>{problem}</p>}
      </div>;
    })}
    {mode !== 'single' && leaves.length < 5 && <button type="button" className={styles.textButton} onClick={() => set(mode, [...leaves, newLeaf()])}><Plus size={14} />Thêm điều kiện</button>}
  </fieldset>;
}
