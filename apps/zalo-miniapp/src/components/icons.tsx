/**
 * Minimal self-drawn stroke icons (24×24, currentColor). zmp-ui's <Icon> loads its glyph font from the Zalo
 * CDN (h5.zadn.vn), which would be an outbound third-party request in the browser fallback — the prototype
 * guarantees none (see e2e guard). These simple shapes are original to this repo; no asset is copied.
 */
export type IconName = 'home' | 'list' | 'camera' | 'card' | 'user' | 'info' | 'back' | 'shield' | 'chart' | 'file';

const PATHS: Record<IconName, string> = {
  home: 'M3 11.5 12 4l9 7.5M5.5 9.5V20h5v-5.5h3V20h5V9.5',
  list: 'M8 6h12M8 12h12M8 18h12M4 6h.01M4 12h.01M4 18h.01',
  camera: 'M4 8h3.5L9 5.5h6L16.5 8H20v11H4zM12 16.5a3.25 3.25 0 1 0 0-6.5 3.25 3.25 0 0 0 0 6.5',
  card: 'M3 6h18v12H3zM3 10h18M6.5 14.5h4',
  user: 'M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8M4.5 20.5c1.2-3.6 4-5.5 7.5-5.5s6.3 1.9 7.5 5.5',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18M12 11v5.5M12 7.5h.01',
  back: 'M15 5l-7 7 7 7',
  shield: 'M12 3l7.5 3v5.5c0 4.5-3.2 8.2-7.5 9.5-4.3-1.3-7.5-5-7.5-9.5V6zM8.75 12l2.25 2.25 4.25-4.5',
  chart: 'M4 20h16M7 16.5V11M12 16.5V6.5M17 16.5v-3.5',
  file: 'M6 3h8l4 4v14H6zM14 3v4h4M9 12h6M9 16h6',
};

export function SvgIcon({ name, size = 24 }: { name: IconName; size?: number }) {
  return (
    <svg
      className="svg-icon"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}
