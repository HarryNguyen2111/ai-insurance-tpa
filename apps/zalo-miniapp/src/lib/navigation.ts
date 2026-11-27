/**
 * Primary bottom navigation for the prototype (issue #104).
 *
 * Structure follows the owner-selected reference (`vimid-loyalty/src/components/navigation.tsx`):
 * a persistent ZaUI `BottomNavigation` on top-level screens, a raised centre action, and the bar hidden on
 * focused/detail screens and while the virtual keyboard is open. Only routes this prototype implements are
 * navigable; anything else is shown as visibly unavailable instead of a fake screen.
 */

export type TabKey = '/home' | '/claims' | '/claims/new' | '/ecard' | 'profile';

export type Tab = {
  key: TabKey;
  label: string;
  /** Inline SVG icon (components/icons.tsx); no remote icon font. */
  icon: 'home' | 'list' | 'camera' | 'card' | 'user';
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

/** Screens that show the bar. Detail/form screens (FNOL, claim detail, EOB, consent) hide it so it can never
 * cover a submit button, the EOB or the OTP notice; they keep their own back button instead. */
export const BOTTOM_NAV_ROUTES: readonly string[] = ['/home', '/claims', '/ecard'];

export const UNAVAILABLE_MESSAGE = 'Chức năng Cá nhân chưa có trong bản thử nghiệm.';

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
  const tab = TABS.find((t) => t.available && !t.raised && t.key === pathname);
  return tab ? tab.key : null;
}

/** Transition direction for zmp-ui AnimationRoutes: moving right along the bar slides forward. */
export function tabDirection(from: string, to: TabKey): 'forward' | 'backward' {
  const i = TABS.findIndex((t) => t.key === from);
  const j = TABS.findIndex((t) => t.key === to);
  return i > j ? 'backward' : 'forward';
}
