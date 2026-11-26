/**
 * Zalo runtime adapter with a browser dev fallback.
 *
 * Inside the Zalo app the native bridge (`ZaloJavaScriptInterface` on Android, `ZJSBridge`/webkit
 * handlers on iOS) exists and `zmp-sdk` is lazy-loaded. In a plain browser (local dev, CI, Playwright)
 * every capability is SIMULATED and labelled as such — no real permission, identity or file transfer.
 */
export type RuntimeKind = 'zalo' | 'browser';

type MaybeZaloWindow = {
  ZaloJavaScriptInterface?: unknown;
  ZJSBridge?: unknown;
  navigator?: { userAgent?: string };
  location?: { search?: string };
};

export function detectRuntime(win: MaybeZaloWindow | undefined = globalThis as MaybeZaloWindow): RuntimeKind {
  if (!win) return 'browser';
  if (new URLSearchParams(win.location?.search ?? '').get('runtime') === 'browser') return 'browser';
  if (win.ZaloJavaScriptInterface !== undefined || win.ZJSBridge !== undefined) return 'zalo';
  return 'browser';
}

export type CameraResult = { granted: boolean; simulated: boolean };

/**
 * In Zalo: `zmp-sdk` `requestCameraPermission`. In the browser: returns the simulated choice the user
 * picked on screen, so the denial path can be exercised deterministically without a real camera prompt.
 */
export async function requestCamera(runtime: RuntimeKind, simulatedChoice: boolean): Promise<CameraResult> {
  if (runtime === 'zalo') {
    const sdk = await import('zmp-sdk');
    try {
      const res = await sdk.requestCameraPermission();
      return { granted: res.userAllow, simulated: false };
    } catch {
      return { granted: false, simulated: false };
    }
  }
  return { granted: simulatedChoice, simulated: true };
}

export async function openPermissionSettings(runtime: RuntimeKind): Promise<boolean> {
  if (runtime !== 'zalo') return false;
  const sdk = await import('zmp-sdk');
  await sdk.openPermissionSetting();
  return true;
}
