/**
 * Layout preferences, per browser: sidebar width and collapse, each page's split between its
 * two panes, and whether its right pane is shown. Stored in localStorage and applied to <html>
 * as CSS variables and data attributes (an inline script in the root layout applies them
 * before first paint, so nothing jumps). Not a client module: the server renders LAYOUT_BOOT;
 * the functions touch the DOM and are only called in the browser.
 */
export interface Layout {
  sidebarW?: number;
  sidebarCollapsed?: boolean;
  split?: Record<string, number>; // percent of the work area taken by the left pane
  asideHidden?: Record<string, boolean>;
}

const KEY = "jin-layout";

export function readLayout(): Layout {
  try {
    return JSON.parse(localStorage.getItem(KEY) ?? "{}") as Layout;
  } catch {
    return {};
  }
}

export function applyLayout(l: Layout) {
  const r = document.documentElement;
  if (l.sidebarW) r.style.setProperty("--sidebar-w", `${l.sidebarW}px`);
  else r.style.removeProperty("--sidebar-w");
  if (l.sidebarCollapsed) r.dataset.sidebar = "collapsed";
  else delete r.dataset.sidebar;
  for (const [k, v] of Object.entries(l.split ?? {})) r.style.setProperty(`--split-${k}`, `${v}%`);
  for (const [k, hidden] of Object.entries(l.asideHidden ?? {})) {
    if (hidden) r.setAttribute(`data-aside-${k}`, "hidden");
    else r.removeAttribute(`data-aside-${k}`);
  }
}

export function updateLayout(patch: (l: Layout) => Layout) {
  const next = patch(readLayout());
  try {
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {}
  applyLayout(next);
  window.dispatchEvent(new Event("jin-layout"));
}

/** Inline, before first paint (kept tiny and dependency-free). */
/** In jin's desktop window (Electrobun), jin draws the title bar: html[data-shell="desktop"]. */
const SHELL_BOOT = `try{var d=document.documentElement;if(window.__electrobun||window.__electrobunWindowId!=null||/[?&]shell=desktop/.test(location.search)){d.dataset.shell="desktop";sessionStorage.setItem("jin-shell","desktop")}else if(sessionStorage.getItem("jin-shell")==="desktop")d.dataset.shell="desktop"}catch(e){}`;

export const LAYOUT_BOOT = SHELL_BOOT + `try{var l=JSON.parse(localStorage.getItem("${KEY}")||"{}"),r=document.documentElement;if(l.sidebarW)r.style.setProperty("--sidebar-w",l.sidebarW+"px");if(l.sidebarCollapsed)r.dataset.sidebar="collapsed";for(var k in l.split||{})r.style.setProperty("--split-"+k,l.split[k]+"%");for(var a in l.asideHidden||{})if(l.asideHidden[a])r.setAttribute("data-aside-"+a,"hidden")}catch(e){}`;

export type Density = "compact" | "comfortable";
export const DENSITY_COOKIE = "jin-density";

export function setDensity(d: Density) {
  document.documentElement.dataset.density = d;
  document.cookie = `${DENSITY_COOKIE}=${d}; path=/; max-age=31536000; samesite=lax`;
}
