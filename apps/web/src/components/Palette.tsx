"use client";
import { splitPath, taskHref } from "@/lib/paths";
import {
  ArrowRight,
  Bell,
  File,
  GitCompare,
  Inbox,
  Layers,
  Monitor,
  Moon,
  PanelLeft,
  PanelRight,
  Plus,
  RefreshCw,
  Rows3,
  Search,
  SquareTerminal,
  Sun,
  type LucideIcon,
} from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { collectGithub, findFiles, searchFiles, testNotification } from "@/app/actions";
import type { Task } from "@/lib/daemon";
import { fuzzy } from "@/lib/fuzzy";
import { setDensity, updateLayout } from "@/lib/layout";
import { openFileInEditor, openNewTaskDialog, useTabs, type TabEntry } from "@/lib/tabs";
import { setAppTheme } from "@/lib/theme";
import { ThermalMark } from "./ThermalMark";

type Mode = "commands" | "files" | "search" | "tabs";

interface Item {
  id: string;
  title: string;
  detail?: string;
  icon?: LucideIcon;
  mark?: "claude";
  run: () => void | Promise<void>;
}

const PLACEHOLDER: Record<Mode, string> = {
  commands: "Type a command or a task…",
  files: "Find a file in this task…",
  search: "Search text in this task's files…",
  tabs: "Switch to an open tab…",
};

const isMac = () => typeof navigator !== "undefined" && /Mac/.test(navigator.platform);

/**
 * The command palette (⌘K), file finder (⌘P), search in files (⌘⇧F) and tab switcher (⌘E;
 * Ctrl+Tab in the desktop app). In the switcher, keep ⌘ held and press E again to move down,
 * release to switch, as with Ctrl+Tab in an editor. ">" switches to commands, "#" to search.
 */
export function Palette({ tasks }: { tasks: (Task & { machine: string; machineLabel: string })[] }) {
  const router = useRouter();
  const path = usePathname();
  const at = splitPath(path);
  const taskId = at.path.startsWith("/t/") ? decodeURIComponent(at.path.slice(3).split("/")[0]!) : null;
  const several = new Set(tasks.map((t) => t.machine)).size > 1;
  const pageId = taskId ? "task" : path.startsWith("/desk") ? "desk" : "home";
  const tabs = useTabs();
  const [mode, setMode] = useState<Mode | null>(null);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [remote, setRemote] = useState<Item[]>([]);
  const [loading, setLoading] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const held = useRef(false); // opened with ⌘E and ⌘ still held: releasing it switches
  const latest = useRef(0); // only the newest finder/search answer may replace the results

  const close = useCallback(() => {
    setMode(null);
    setQuery("");
    setIndex(0);
    setRemote([]);
    held.current = false;
  }, []);

  const openMode = useCallback((m: Mode) => {
    setMode(m);
    setQuery("");
    setRemote([]);
    setIndex(m === "tabs" ? 1 : 0); // the switcher starts on the previous tab
  }, []);

  // Focus the input in the same frame the palette appears, so fast typing is not lost to the editor.
  useLayoutEffect(() => {
    if (mode) input.current?.focus();
  }, [mode]);

  // ---------------------------------------------------------------- commands

  const commands = useMemo<Item[]>(() => {
    const go = (href: string) => () => router.push(href);
    const items: Item[] = [{ id: "go:home", title: "Go to Jin", detail: "your orchestrator", icon: Layers, run: go("/") }];
    for (const t of tasks.filter((x) => x.state === "ready")) items.push({ id: `go:task:${t.machine}:${t.id}`, title: `${t.id} ${t.title ?? t.slug}`, detail: `task · ${t.repos.join(", ")}${several ? ` · ${t.machineLabel}` : ""}`, icon: ArrowRight, run: go(taskHref(t.machine, t.id)) });
    items.push({ id: "go:desk", title: "Go to the desk", detail: "activity and your desk agent", icon: Inbox, run: go("/desk") });
    items.push({ id: "task:new", title: "New task…", detail: "⌘⇧N", icon: Plus, run: openNewTaskDialog });
    items.push({ id: "notify:test", title: "Send a test notification", detail: "desktop notification and sound", icon: Bell, run: () => void testNotification() });
    if (taskId) {
      items.push(
        { id: "task:claude", title: "New Claude Code session", detail: taskId, icon: Plus, run: () => void window.dispatchEvent(new CustomEvent("jin:new-tab", { detail: { taskId, kind: "claude" } })) },
        { id: "task:shell", title: "New terminal", detail: taskId, icon: SquareTerminal, run: () => void window.dispatchEvent(new CustomEvent("jin:new-tab", { detail: { taskId, kind: "shell" } })) },
        { id: "task:find", title: "Find file…", detail: "⌘P", icon: File, run: () => openMode("files") },
        { id: "task:search", title: "Search in files…", detail: "⌘⇧F", icon: Search, run: () => openMode("search") },
        { id: "task:diff", title: "Show changes", detail: "the task's diff as a tab", icon: GitCompare, run: () => void window.dispatchEvent(new CustomEvent("jin:show-pane-tab", { detail: { taskId, tab: "diff" } })) },
      );
    }
    items.push(
      { id: "tabs", title: "Switch tab…", detail: "⌘E", icon: ArrowRight, run: () => openMode("tabs") },
      {
        id: "feed:github",
        title: "Refresh GitHub",
        detail: "reviews, failing checks, mentions",
        icon: RefreshCw,
        run: async () => {
          await collectGithub();
          router.refresh();
        },
      },
      { id: "view:sidebar", title: "Toggle sidebar", detail: "⌘B", icon: PanelLeft, run: () => updateLayout((l) => ({ ...l, sidebarCollapsed: !l.sidebarCollapsed })) },
      { id: "view:aside", title: "Toggle side pane", icon: PanelRight, run: () => updateLayout((l) => ({ ...l, asideHidden: { ...l.asideHidden, [pageId]: !l.asideHidden?.[pageId] } })) },
      { id: "theme:light", title: "Theme: light", icon: Sun, run: () => setAppTheme("light") },
      { id: "theme:dark", title: "Theme: dark", icon: Moon, run: () => setAppTheme("dark") },
      { id: "theme:system", title: "Theme: follow the system", icon: Monitor, run: () => setAppTheme("system") },
      { id: "density:compact", title: "Density: compact", icon: Rows3, run: () => setDensity("compact") },
      { id: "density:comfortable", title: "Density: comfortable", icon: Rows3, run: () => setDensity("comfortable") },
    );
    return items;
  }, [tasks, taskId, pageId, router, openMode]);

  // ---------------------------------------------------------------- tabs (most recent first)

  const tabItems = useMemo<Item[]>(() => {
    const ordered = [...tabs].sort((a, b) => b.lastActive - a.lastActive);
    const icon = (t: TabEntry): Pick<Item, "icon" | "mark"> => (t.group === "claude" ? { mark: "claude" } : { icon: t.group === "shell" ? SquareTerminal : File });
    const items: Item[] = ordered.map((t) => ({ id: `tab:${t.id}`, title: t.label, detail: t.detail, ...icon(t), run: t.activate }));
    // Other tasks follow the open tabs.
    for (const t of tasks.filter((x) => x.state === "ready" && !(x.id === taskId && x.machine === at.machine))) items.push({ id: `tab:task:${t.machine}:${t.id}`, title: t.id, detail: `${t.title ?? t.slug}${several ? ` · ${t.machineLabel}` : ""}`, icon: ArrowRight, run: () => router.push(taskHref(t.machine, t.id)) });
    return items;
  }, [tabs, tasks, taskId, router]);

  // ---------------------------------------------------------------- results

  const q = mode === "commands" ? query.replace(/^>\s*/, "") : mode === "search" ? query.replace(/^#\s*/, "") : query;
  const local = useMemo<Item[]>(() => {
    if (mode === "commands" || mode === "tabs") {
      const pool = mode === "commands" ? commands : tabItems;
      if (!q.trim()) return pool;
      return pool
        .map((it) => ({ it, s: fuzzy(q, `${it.title} ${it.detail ?? ""}`) }))
        .filter((x) => x.s !== null)
        .sort((a, b) => b.s! - a.s!)
        .map((x) => x.it);
    }
    if (mode === "files" && !taskId) {
      return tasks
        .filter((t) => t.state === "ready")
        .map((t) => ({ id: `go:task:${t.machine}:${t.id}`, title: `${t.id} ${t.title ?? t.slug}`, detail: "open a task to find its files", icon: ArrowRight, run: () => router.push(taskHref(t.machine, t.id)) }))
        .filter((it) => fuzzy(q, it.title) !== null);
    }
    return [];
  }, [mode, q, commands, tabItems, taskId, tasks, router]);

  // Files and search ask the daemon (debounced).
  useEffect(() => {
    if (!mode || !taskId || (mode !== "files" && mode !== "search")) return;
    const seq = ++latest.current;
    if (mode === "search" && q.trim().length < 2) {
      setRemote([]);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(
      async () => {
        try {
          let items: Item[];
          if (mode === "files") {
            const found = await findFiles(taskId, q);
            items = found.map((f) => ({ id: `file:${f.path}`, title: f.path.slice(f.path.lastIndexOf("/") + 1), detail: f.path, icon: File, run: () => openFileInEditor(taskId, f.path) }));
          } else {
            const hits = await searchFiles(taskId, q);
            items = hits.map((h) => ({ id: `hit:${h.path}:${h.line}`, title: h.text || "(blank line)", detail: `${h.path}:${h.line}`, icon: Search, run: () => openFileInEditor(taskId, h.path, h.line) }));
          }
          if (seq !== latest.current) return; // a newer query is on its way
          setRemote(items);
          setIndex(0);
        } catch {
          if (seq === latest.current) setRemote([]);
        } finally {
          if (seq === latest.current) setLoading(false);
        }
      },
      mode === "files" ? 60 : 180,
    );
    return () => clearTimeout(timer);
  }, [mode, q, taskId]);

  const results = mode === "files" && taskId ? remote : mode === "search" ? remote : local;
  const clamped = Math.min(index, Math.max(0, results.length - 1));

  const choose = useCallback(
    (it: Item | undefined) => {
      if (!it) return;
      const keepOpen = it.id === "task:find" || it.id === "task:search" || it.id === "tabs";
      if (!keepOpen) close();
      void it.run();
    },
    [close],
  );

  // ---------------------------------------------------------------- keyboard

  useEffect(() => {
    const mod = (e: KeyboardEvent) => (isMac() ? e.metaKey : e.ctrlKey);
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      let m: Mode | null = null;
      if (mod(e) && !e.shiftKey && !e.altKey && k === "k") m = "commands";
      else if (mod(e) && !e.shiftKey && !e.altKey && k === "p") m = "files";
      else if (mod(e) && e.shiftKey && !e.altKey && k === "f") m = "search";
      else if ((mod(e) && !e.altKey && k === "e") || (e.ctrlKey && k === "tab")) m = "tabs";
      if (!m) return;
      // Before the terminal and Monaco see it (Monaco uses ⌘K as a chord prefix).
      e.preventDefault();
      e.stopPropagation();
      if (m === "tabs") {
        held.current = true;
        if (mode === "tabs") setIndex((i) => (e.shiftKey ? i - 1 : i + 1));
        else openMode("tabs");
        return;
      }
      if (mode === m) close();
      else openMode(m);
    };
    const up = (e: KeyboardEvent) => {
      // Releasing ⌘ (or Ctrl) after ⌘E switches to the highlighted tab.
      if (held.current && mode === "tabs" && (e.key === "Meta" || e.key === "Control")) {
        held.current = false;
        choose(results[clamped]);
      }
    };
    window.addEventListener("keydown", down, true);
    window.addEventListener("keyup", up, true);
    return () => {
      window.removeEventListener("keydown", down, true);
      window.removeEventListener("keyup", up, true);
    };
  }, [mode, openMode, close, choose, results, clamped]);

  // Keep the highlighted row in view.
  useEffect(() => {
    list.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
  }, [clamped, mode]);

  if (!mode) return null;

  const onInputKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setIndex((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setIndex((i) => Math.max(i - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(results[clamped]);
    } else if (e.key === "Escape") {
      e.preventDefault();
      close();
    }
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" role="dialog" aria-label="Command palette" onMouseDown={(e) => e.stopPropagation()}>
        <div className="palette-input">
          <span className="palette-mode">{mode === "commands" ? "⌘K" : mode === "files" ? "⌘P" : mode === "search" ? "⌘⇧F" : "⌘E"}</span>
          <input
            ref={input}
            value={query}
            placeholder={PLACEHOLDER[mode]}
            onChange={(e) => {
              const v = e.target.value;
              // ">" for commands and "#" for search, from any mode.
              if (mode !== "commands" && v.startsWith(">")) {
                setMode("commands");
                setQuery(v);
              } else if (mode !== "search" && v.startsWith("#") && taskId) {
                setMode("search");
                setQuery(v);
              } else setQuery(v);
              setIndex(0);
            }}
            onKeyDown={onInputKey}
            aria-label={PLACEHOLDER[mode]}
            spellCheck={false}
          />
          {loading && <ThermalMark size={16} state="working" />}
        </div>
        <ul ref={list} className="palette-list" role="listbox" data-scroll="y">
          {results.length === 0 ? (
            <li className="palette-empty">{mode === "search" && q.trim().length < 2 ? "Type at least two characters" : loading ? "Searching…" : "Nothing found"}</li>
          ) : (
            results.map((it, i) => {
              const Icon = it.icon;
              return (
                <li key={it.id} role="option" aria-selected={i === clamped} className={`palette-item ${i === clamped ? "is-selected" : ""}`} onMouseMove={() => setIndex(i)} onClick={() => choose(it)}>
                  <span className="palette-icon">{it.mark === "claude" ? <ThermalMark size={14} animated={false} /> : Icon ? <Icon size={14} /> : null}</span>
                  <span className="palette-title">{it.title}</span>
                  {it.detail && <span className="palette-detail">{it.detail}</span>}
                </li>
              );
            })
          )}
        </ul>
        <div className="palette-hints">
          <span>↑↓ move</span>
          <span>↵ open</span>
          <span>esc close</span>
          <span>&gt; commands</span>
          {taskId && <span># search</span>}
        </div>
      </div>
    </div>
  );
}
