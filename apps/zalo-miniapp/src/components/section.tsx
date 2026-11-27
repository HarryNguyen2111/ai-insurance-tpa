import { useId, type ReactNode } from 'react';

/**
 * Titled content group (reference: vimid-loyalty `components/section.tsx` — white block with a title and
 * 16 px padding, separated by background dividers). Adapted as a rounded card on the warm page.
 */
export function Section({
  title,
  action,
  flush = false,
  children,
  testId,
}: {
  title: string;
  /** Optional trailing link/button next to the title (e.g. "Xem tất cả"). */
  action?: ReactNode;
  /** true → title keeps its padding but children run edge-to-edge (horizontal scrollers). */
  flush?: boolean;
  children: ReactNode;
  testId?: string;
}) {
  const id = useId();
  return (
    <section className={flush ? 'section flush' : 'section'} aria-labelledby={id} data-testid={testId}>
      <div className="section-head">
        <h2 id={id} className="section-heading">{title}</h2>
        {action}
      </div>
      {children}
    </section>
  );
}
