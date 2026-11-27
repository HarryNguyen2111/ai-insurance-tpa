/**
 * Primary bottom navigation for the prototype (issue #104).
 *
 * Structure follows the owner-selected reference (`vimid-loyalty/src/components/navigation.tsx`):
 * a persistent ZaUI `BottomNavigation` on top-level screens, a raised centre action, and the bar hidden on
 * focused/detail screens and while the virtual keyboard is open. Only routes this prototype implements are
 * navigable; anything else is shown as visibly unavailable instead of a fake screen.
 */

export type TabKey =
  | '/home' | '/claims' | '/claims/new' | '/ecard' | 'profile'
  | '/hub' | 'utilities' | '/hub/activity' | '/hub/personal';

export type Tab = {
  key: TabKey;
  label: string;
  /** Inline SVG icon (components/icons.tsx); no remote icon font. */
  icon: 'home' | 'list' | 'camera' | 'card' | 'user' | 'grid' | 'activity';
  /** false → visibly unavailable; tapping explains why and never navigates. */
  available: boolean;
  /** The raised centre action (reference "Liên hệ" button, adapted to the TPA claim action). */
  raised?: boolean;
};

export const TABS: readonly Tab[] = [
  { key: '/home', label: 'Trang chủ', icon: 'home', available: true },
  { key: '/claims', label: 'Hồ sơ', icon: 'list', available: true },
  { key: '/claims/new', label: 'Gửi hồ sơ', icon: 'camera', available: true, raised: true },
  { key: '/ecard', label: 'Thẻ BH', icon: 'card', available: true },
  { key: 'profile', label: 'Cá nhân', icon: 'user', available: false },
];

/**
 * Hub (user-centric shell, issue #106) bar: the proposed Home / Utilities / Activity / Personal. It is shown on
 * the hub and Loyalty360 screens; the TPA service keeps its own contextual bar above (unchanged #104 routes).
 * "Tiện ích" (future Mini App utilities) is visibly unavailable, never a fake service.
 */
export const HUB_TABS: readonly Tab[] = [
  { key: '/hub', label: 'Trang chủ', icon: 'home', available: true },
  { key: 'utilities', label: 'Tiện ích', icon: 'grid', available: false },
  { key: '/hub/activity', label: 'Hoạt động', icon: 'activity', available: true },
  { key: '/hub/personal', label: 'Cá nhân', icon: 'user', available: true },
];

export const HUB_ROUTES: readonly string[] = ['/hub', '/loyalty', '/hub/activity', '/hub/personal'];

/** Screens that show the bar. Detail/form screens (FNOL, claim detail, EOB, consent) hide it so it can never
 * cover a submit button, the EOB or the OTP notice; they keep their own back button instead. */
export const BOTTOM_NAV_ROUTES: readonly string[] = ['/home', '/claims', '/ecard', ...HUB_ROUTES];

export const UNAVAILABLE_MESSAGE = 'Chức năng Cá nhân chưa có trong bản thử nghiệm.';
export const HUB_UNAVAILABLE_MESSAGE = 'Tiện ích khác của Mini App chưa có trong bản thử nghiệm.';

/** Which bar a route uses: hub/Loyalty360 screens get the hub bar, TPA screens keep the #104 bar. */
export function tabsFor(pathname: string): readonly Tab[] {
  return HUB_ROUTES.includes(pathname) ? HUB_TABS : TABS;
}

/** Reference heuristic: the webview shrinks by > 160 px when the soft keyboard opens. */
export const KEYBOARD_THRESHOLD_PX = 160;

export function isKeyboardOpen(baselineHeight: number, currentHeight: number): boolean {
  return currentHeight + KEYBOARD_THRESHOLD_PX < baselineHeight;
}

export function shouldShowBottomNav(pathname: string, keyboardOpen: boolean): boolean {
  return !keyboardOpen && BOTTOM_NAV_ROUTES.includes(pathname);
}

/** Active tab for the current path; null when the path is not a tab root (bar hidden anyway). */
export function activeTab(pathname: string): TabKey | null {
  // Loyalty360 is a service opened from the hub home, so the hub "Trang chủ" stays current there.
  const path = pathname === '/loyalty' ? '/hub' : pathname;
  const tab = tabsFor(pathname).find((t) => t.available && !t.raised && t.key === path);
  return tab ? tab.key : null;
}

/** Transition direction for zmp-ui AnimationRoutes: moving right along the bar slides forward. */
export function tabDirection(from: string, to: TabKey): 'forward' | 'backward' {
  const tabs = tabsFor(from);
  const i = tabs.findIndex((t) => t.key === from);
  const j = tabs.findIndex((t) => t.key === to);
  return i > j ? 'backward' : 'forward';
}
