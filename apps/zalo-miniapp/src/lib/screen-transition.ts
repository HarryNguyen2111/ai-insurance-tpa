/**
 * Class contract of zmp-ui `AnimationRoutes` (zmp-ui 1.11.15-2): each route is a `.zaui-routes-item`
 * inside `.zaui-routes`; react-transition-group adds `zaui-routes-{forward|backward|no-animation}-exit`
 * (and `-exit-active`) to the OUTGOING item while it animates out.
 */
export const ROUTES_SELECTOR = '.zaui-routes';
export const ITEM_CLASS = 'zaui-routes-item';
const EXIT = /^zaui-routes-(forward|backward|no-animation)-exit(-active)?$/;

export function isExitingScreen(className: string): boolean {
  const classes = className.split(/\s+/).filter(Boolean);
  return classes.includes(ITEM_CLASS) && classes.some((c) => EXIT.test(c));
}
