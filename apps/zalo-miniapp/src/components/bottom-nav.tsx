import { useEffect, useRef, useState } from 'react';
import { BottomNavigation, useLocation, useNavigate } from 'zmp-ui';
import { SvgIcon } from './icons.tsx';
import {
  TABS,
  UNAVAILABLE_MESSAGE,
  activeTab,
  isKeyboardOpen,
  shouldShowBottomNav,
  tabDirection,
  type TabKey,
} from '../lib/navigation.ts';
import { usePrototype } from '../state.tsx';

function useKeyboardOpen(): boolean {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const baseline = window.innerHeight;
    const onResize = () => setOpen(isKeyboardOpen(baseline, window.innerHeight));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  return open;
}

/**
 * Persistent ZaUI bottom bar (reference: vimid-loyalty `components/navigation.tsx`). Rendered ONCE, outside
 * `AnimationRoutes`, so a route transition never duplicates it. The reference's raised navy "Liên hệ" button
 * becomes the TPA claim action; it is disabled until the current consent version is accepted.
 */
export function BottomNav() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const { canSubmit } = usePrototype();
  const keyboardOpen = useKeyboardOpen();
  const [notice, setNotice] = useState('');
  const barRef = useRef<HTMLElement>(null);
  const visible = shouldShowBottomNav(pathname, keyboardOpen);
  const active = activeTab(pathname);

  // zmp-ui marks the active item only with a class; expose it to assistive tech too.
  useEffect(() => {
    barRef.current?.querySelectorAll<HTMLButtonElement>('.zaui-bottom-navigation-item').forEach((b) => {
      if (b.classList.contains('zaui-bottom-navigation-item-active')) b.setAttribute('aria-current', 'page');
      else b.removeAttribute('aria-current');
    });
  });

  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(''), 3000);
    return () => clearTimeout(t);
  }, [notice]);

  useEffect(() => {
    document.body.classList.toggle('has-bottom-nav', visible);
  }, [visible]);

  if (!visible) return null;

  const go = (key: TabKey) => {
    if (key === pathname) return;
    navigate(key, { animate: true, direction: tabDirection(pathname, key) });
  };

  return (
    <nav ref={barRef} className="bottom-nav" aria-label="Điều hướng chính" data-testid="bottom-nav">
      {notice && (
        <p className="bottom-nav-notice" role="status" data-testid="nav-unavailable">
          {notice}
        </p>
      )}
      <BottomNavigation activeKey={active ?? undefined}>
        {TABS.map((t) =>
          t.raised ? (
            // Keeps the slot under the raised button (hidden from layout-free a11y tree via visibility).
            <BottomNavigation.Item key={t.key} itemKey={t.key} className="raised-slot" label="" />
          ) : (
            <BottomNavigation.Item
              key={t.key}
              itemKey={t.key}
              label={
                t.available ? t.label : (
                  <>
                    {t.label}
                    <span className="soon-badge"> Sắp có</span>
                  </>
                )
              }
              className={t.available ? undefined : 'unavailable'}
              icon={<SvgIcon name={t.icon} />}
              onClick={() => (t.available ? go(t.key) : setNotice(UNAVAILABLE_MESSAGE))}
            />
          ),
        )}
      </BottomNavigation>
      {TABS.filter((t) => t.raised).map((t) => (
        <div key={t.key} className="raised-action">
          <button
            type="button"
            className="raised-button"
            disabled={!canSubmit}
            aria-describedby={canSubmit ? undefined : 'raised-hint'}
            onClick={() => go(t.key)}
            data-testid="raised-action"
          >
            <SvgIcon name={t.icon} size={26} />
            <span className="sr-only">{t.label} mới</span>
          </button>
          <span className="raised-label" aria-hidden="true">{t.label}</span>
          {!canSubmit && (
            <span id="raised-hint" className="sr-only">Cần đồng ý xử lý dữ liệu trước khi gửi hồ sơ.</span>
          )}
        </div>
      ))}
    </nav>
  );
}
