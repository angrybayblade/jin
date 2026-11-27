// jin in a native window. The installed app (scripts/release-local.sh) runs the build in
// ~/.jin/release/app: it starts jin's daemon and web server from there when they are not
// already running, and leaves them running when the window closes (Claude Code sessions
// live in the daemon). In development, JIN_URL points the window at a running dev server
// and JIN_SERVICES=0 leaves the services to you.
import { dlopen, FFIType, ptr } from "bun:ffi";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import Electrobun, { ApplicationMenu, BrowserWindow, Utils } from "electrobun/main";

const HOME = process.env["JIN_HOME"] ?? join(homedir(), ".jin");
const APP = process.env["JIN_APP_DIR"] ?? join(HOME, "release", "app");
const WEB_PORT = Number(process.env["JIN_WEB_PORT"] ?? 3917);
const URL = process.env["JIN_URL"] ?? `http://127.0.0.1:${WEB_PORT}`;
const MANAGE = process.env["JIN_SERVICES"] !== "0" && !process.env["JIN_URL"];

// WebKit needs an Edit menu for copy and paste to reach the page (the terminal pastes through it).
ApplicationMenu.setApplicationMenu([
  {
    label: "jin",
    submenu: [{ role: "about" }, { type: "divider" }, { role: "hide" }, { role: "hideOthers" }, { role: "showAll" }, { type: "divider" }, { role: "quit" }],
  },
  {
    label: "Edit",
    submenu: [{ role: "undo" }, { role: "redo" }, { type: "divider" }, { role: "cut" }, { role: "copy" }, { role: "paste" }, { role: "selectAll" }],
  },
  { label: "View", submenu: [{ role: "toggleFullScreen" }] },
  { label: "Window", submenu: [{ role: "minimize" }, { role: "zoom" }, { type: "divider" }, { role: "bringAllToFront" }] },
]);

// ---------------------------------------------------------------- services

/** An app opened from Finder gets a bare PATH; jin's daemon needs yours (gh, claude, git, node, the workspace's tools). */
function loginPath(): string {
  const shell = process.env["SHELL"] || "/bin/zsh";
  const r = Bun.spawnSync([shell, "-lc", 'printf "%s" "$PATH"'], { stderr: "ignore" });
  const found = r.exitCode === 0 ? r.stdout.toString().trim() : "";
  const extra = [join(homedir(), ".bun/bin"), join(homedir(), ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"];
  return [...new Set([...found.split(":"), ...extra].filter(Boolean))].join(":");
}

const answers = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(1500) })
    .then((r) => r.status < 500)
    .catch(() => false);

/** Start a long-lived service in the background, detached from this app, logging to ~/.jin/logs. */
function startDetached(name: string, cmd: string[], cwd: string, env: Record<string, string>) {
  const logs = join(HOME, "logs");
  mkdirSync(logs, { recursive: true });
  // sh runs it under nohup in the background: the service outlives the window.
  Bun.spawn(["/bin/sh", "-c", `nohup "$@" >> "${join(logs, `${name}.log`)}" 2>&1 &`, "sh", ...cmd], { cwd, env, stdio: ["ignore", "ignore", "ignore"] });
  console.log(`started ${name}: ${cmd.join(" ")}`);
}

async function ensureServices(): Promise<string | null> {
  if (!existsSync(join(APP, "apps", "daemon", "src", "main.ts"))) return `jin is not installed in ${APP}; run scripts/release-local.sh in jin's repo`;
  const path = loginPath();
  const env = { ...process.env, PATH: path, JIN_HOME: HOME, NODE_ENV: "production" } as Record<string, string>;
  // Never hand a parent Claude Code session's variables to the daemon's agents.
  for (const k of Object.keys(env)) if (k.startsWith("CLAUDE_CODE_") || k === "CLAUDECODE") delete env[k];
  const bun = [join(homedir(), ".bun/bin/bun"), "/opt/homebrew/bin/bun"].find(existsSync) ?? process.execPath;
  const daemonPort = Number(process.env["JIN_PORT"] ?? 7317);
  if (!(await answers(`http://127.0.0.1:${daemonPort}/health`))) startDetached("daemon", [bun, join(APP, "apps/daemon/src/main.ts")], APP, env);
  // The web server's own health check: the home page can be slow while another machine's tunnel comes back.
  const web = `${URL}/healthz`;
  if (!(await answers(web)) && !(await answers(URL))) startDetached("web", [bun, "run", "start", "-p", String(WEB_PORT)], join(APP, "apps/web"), env);
  for (let i = 0; i < 120; i++) {
    if ((await answers(`http://127.0.0.1:${daemonPort}/health`)) && ((await answers(web)) || (await answers(URL)))) return null;
    await Bun.sleep(250);
  }
  return `jin did not start in 30s; see ${join(HOME, "logs")}`;
}

// ---------------------------------------------------------------- window

// jin draws its own title bar: the panes' top bars move the window, and the window
// buttons sit in the sidebar's top bar (?shell=desktop tells the page).
const win = new BrowserWindow({
  title: "jin",
  url: MANAGE ? "views://mainview/index.html" : `${URL}/?shell=desktop`,
  frame: { width: 1512, height: 940, x: 80, y: 60 },
  titleBarStyle: "hiddenInset",
  trafficLightOffset: { x: 14, y: Number(process.env["JIN_TRAFFIC_Y"] ?? 4) },
  renderer: "native",
});

// ---------------------------------------------------------------- jin:// links

/** The page a jin:// link names (jin://open?path=/t/ENG-1), as a URL in this window; null for anything else. */
export function linkTarget(link: string, base = URL): string | null {
  try {
    const u = new globalThis.URL(link);
    if (u.protocol !== "jin:") return null;
    const path = u.searchParams.get("path") ?? "/";
    if (!path.startsWith("/") || path.startsWith("//")) return null; // only places in jin
    const at = new globalThis.URL(path, base);
    at.searchParams.set("shell", "desktop");
    return at.toString();
  } catch {
    return null;
  }
}

let ready = !MANAGE;
let pending: string | null = null;
/** Bring the window up on a page (a notification was clicked); before jin has started, once it has. */
function openAt(target: string) {
  if (!ready) {
    pending = target;
    return;
  }
  win.webview.loadURL(target);
  win.show();
  win.activate();
}
Electrobun.events.on("open-url", (e: any) => {
  const target = linkTarget(String(e?.data?.url ?? ""));
  if (target) openAt(target);
});

if (MANAGE) {
  void ensureServices().then((problem) => {
    if (problem) console.error(problem);
    // Load jin either way: its pages say what is not answering, where a stuck "Starting jin…" says nothing.
    ready = true;
    win.webview.loadURL(pending ?? `${URL}/?shell=desktop`);
    pending = null;
  });
}

// Electrobun's typings leave out two webview events it does send (a new window asked for, a message from the page).
const onWebview = win.webview.on.bind(win.webview) as unknown as (event: string, handler: (e: any) => void) => void;

// Links to other sites open in your default browser: the window is jin, not a browser.
function openExternal(url: unknown) {
  if (typeof url !== "string" || !/^(https?|mailto):/i.test(url)) return;
  Bun.spawn(["open", url], { stdio: ["ignore", "ignore", "ignore"] });
}
// A page asking for a new window (a link with target=_blank that slipped past the page's own handling).
// jin's own pages (⌘-click on one of its links) open in this window, never the browser.
onWebview("new-window-open", (e: any) => {
  const d = e?.data?.detail;
  const url = typeof d === "string" ? d : d?.url;
  if (typeof url === "string" && url.startsWith(`${URL}/`)) {
    const at = new globalThis.URL(url);
    at.searchParams.set("shell", "desktop");
    return win.webview.loadURL(at.toString());
  }
  openExternal(url);
});

// Double-clicking jin's title bar does what the system setting says (Desktop & Dock →
// "Double-click a window's title bar to"): zoom by default, or minimize, or nothing.
const doubleClickAction = () => {
  const r = Bun.spawnSync(["defaults", "read", "-g", "AppleActionOnDoubleClick"]);
  return r.exitCode === 0 ? r.stdout.toString().trim() : "Maximize";
};
onWebview("host-message", (e: any) => {
  // The page's message arrives as an object (older builds sent a JSON string).
  let m = e?.data?.detail as { type?: string } | string | undefined;
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return;
    }
  }
  if (typeof m === "object" && m?.type === "jin:open-external") return openExternal((m as { url?: string }).url);
  // A copy from the page (a terminal program's OSC 52): the webview may not write the clipboard itself then.
  if (typeof m === "object" && m?.type === "jin:clipboard-write") {
    const text = (m as { text?: unknown }).text;
    if (typeof text === "string" && text.length <= 16 * 1024 * 1024) Utils.clipboardWriteText(text);
    return;
  }
  if (typeof m === "object" && m?.type === "jin:window-buttons") return showWindowButtons((m as { visible?: boolean }).visible !== false);
  if (typeof m !== "object" || m?.type !== "jin:title-bar-double-click" || win.isFullScreen()) return;
  const action = doubleClickAction();
  if (action === "Minimize") win.minimize();
  else if (action === "Maximize" || action === "Fill") toggleZoom();
});

// Zoom fills the screen; the next double-click puts the window back where it was. jin keeps
// the frame itself because isMaximized() does not report a zoomed window reliably.
type Frame = { x: number; y: number; width: number; height: number };
let beforeZoom: Frame | null = null;
let zoomed: Frame | null = null;
const same = (a: Frame | null, b: Frame | null) => !!a && !!b && Math.abs(a.x - b.x) + Math.abs(a.y - b.y) + Math.abs(a.width - b.width) + Math.abs(a.height - b.height) < 4;
function toggleZoom() {
  const now = win.getFrame();
  if (beforeZoom && same(now, zoomed)) {
    const f = beforeZoom;
    beforeZoom = zoomed = null;
    win.setFrame(f.x, f.y, f.width, f.height);
    return;
  }
  beforeZoom = now;
  win.maximize();
  setTimeout(() => (zoomed = win.getFrame()), 300);
}

// The collapsed sidebar has no room for the window buttons: the page asks for them to go and
// come back. The page's layout follows the attribute set here, so a page in an older window keeps
// its gap for the buttons.
let buttonsShown = true;
const hideButtons = windowButtonsHider();
function showWindowButtons(show: boolean) {
  buttonsShown = show;
  if (!hideButtons) return;
  hideButtons(!show);
  win.webview.executeJavascript(`document.documentElement.toggleAttribute("data-window-buttons-hidden", ${!show})`);
}

/**
 * Hide or show the window's close, minimize and zoom buttons: [[win standardWindowButton:n]
 * setHidden:], through the Objective-C runtime (Electrobun has no API for it; moving them out of
 * the window does not work, they stop at its corner). AppKit wants the main thread, and
 * performSelectorOnMainThread cannot pass a BOOL, so each call goes as an NSInvocation.
 */
function windowButtonsHider(): ((hidden: boolean) => void) | null {
  if (process.platform !== "darwin") return null;
  try {
    const objc = "/usr/lib/libobjc.A.dylib";
    const { symbols: rt } = dlopen(objc, {
      objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
      sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
    });
    const send0 = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
    const sendP = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
    const sendU = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.u64], returns: FFIType.ptr } }).symbols.objc_msgSend;
    const sendPI = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.i64], returns: FFIType.void } }).symbols.objc_msgSend;
    const sendMain = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void } }).symbols.objc_msgSend;
    const c = (s: string) => ptr(Buffer.from(`${s}\0`));
    const sel = (s: string) => rt.sel_registerName(c(s));
    const NSInvocation = rt.objc_getClass(c("NSInvocation"));
    const setHidden = sel("setHidden:");
    if (!NSInvocation) return null;
    // Kept alive: NSInvocation copies the argument, but only when it is set.
    const flag = new Uint8Array(1);
    return (hidden: boolean) => {
      const window = win.ptr;
      if (!window) return;
      flag[0] = hidden ? 1 : 0;
      for (const n of [0, 1, 2]) {
        const button = sendU(window, sel("standardWindowButton:"), n);
        if (!button) continue;
        const signature = sendP(button, sel("methodSignatureForSelector:"), setHidden);
        const inv = sendP(NSInvocation, sel("invocationWithMethodSignature:"), signature);
        if (!inv) continue;
        sendP(inv, sel("setSelector:"), setHidden);
        sendP(inv, sel("setTarget:"), button);
        sendPI(inv, sel("setArgument:atIndex:"), ptr(flag), 2);
        send0(inv, sel("retainArguments"));
        sendMain(inv, sel("performSelectorOnMainThread:withObject:waitUntilDone:"), sel("invoke"), null, false);
      }
    };
  } catch (err) {
    console.error(`cannot hide the window buttons: ${err}`);
    return null;
  }
}

// Tell the page when the window enters or leaves full screen (the window buttons go away).
const syncFullScreen = () => win.webview.executeJavascript(`document.documentElement.toggleAttribute("data-fullscreen", ${win.isFullScreen()})`);
win.on("resize", () =>
  setTimeout(() => {
    syncFullScreen();
    // Leaving full screen can bring the buttons back.
    if (!buttonsShown) hideButtons?.(true);
  }, 60),
);
win.webview.on("dom-ready", syncFullScreen);

// ---------------------------------------------------------------- Dock badge

/**
 * The Dock icon's badge: NSApp.dockTile.badgeLabel, through the Objective-C runtime (Electrobun
 * has no API for it), set on the main thread. Null when the runtime is not there.
 */
function dockBadge(): ((label: string) => void) | null {
  if (process.platform !== "darwin") return null;
  try {
    const objc = "/usr/lib/libobjc.A.dylib";
    const { symbols: rt } = dlopen(objc, {
      objc_getClass: { args: [FFIType.cstring], returns: FFIType.ptr },
      sel_registerName: { args: [FFIType.cstring], returns: FFIType.ptr },
    });
    // objc_msgSend, typed once per shape it is called with.
    const send0 = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
    const sendP = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr], returns: FFIType.ptr } }).symbols.objc_msgSend;
    const sendMain = dlopen(objc, { objc_msgSend: { args: [FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.bool], returns: FFIType.void } }).symbols.objc_msgSend;
    const c = (s: string) => ptr(Buffer.from(`${s}\0`));
    const sel = (s: string) => rt.sel_registerName(c(s));
    const app = send0(rt.objc_getClass(c("NSApplication")), sel("sharedApplication"));
    const tile = send0(app, sel("dockTile"));
    const NSString = rt.objc_getClass(c("NSString"));
    if (!app || !tile || !NSString) return null;
    let last = "";
    return (label: string) => {
      if (label === last) return;
      last = label;
      const str = sendP(NSString, sel("stringWithUTF8String:"), c(label));
      sendMain(tile, sel("performSelectorOnMainThread:withObject:waitUntilDone:"), sel("setBadgeLabel:"), str, false);
    };
  } catch (err) {
    console.error(`no Dock badge: ${err}`);
    return null;
  }
}

/** How many Claude Code sessions wait on you, plus approvals waiting, from this machine's daemon. */
async function waitingOnYou(): Promise<number> {
  try {
    const d = JSON.parse(readFileSync(join(HOME, "daemon.json"), "utf8")) as { host: string; port: number; token: string };
    const get = (path: string) => fetch(`http://${d.host}:${d.port}${path}`, { headers: { authorization: `Bearer ${d.token}` }, signal: AbortSignal.timeout(2000) }).then((r) => (r.ok ? r.json() : []));
    const [terminals, approvals] = (await Promise.all([get("/api/terminals"), get("/api/approvals?state=pending")])) as [{ kind: string; status: string }[], unknown[]];
    return terminals.filter((t) => t.kind === "agent" && t.status === "waiting").length + approvals.length;
  } catch {
    return 0;
  }
}

const badge = dockBadge();
if (badge) {
  const update = async () => {
    const n = process.env["JIN_BADGE"] ?? (await waitingOnYou()); // JIN_BADGE: show a fixed label (to check the badge)
    badge(String(n) === "0" ? "" : String(n));
  };
  void update();
  setInterval(() => void update(), 3000);
}

console.log(`jin window: ${URL}${MANAGE ? ` (services from ${APP})` : ""}`);
