"use client";
import { Eye, EyeOff, Plus, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { saveClaudeSettings } from "@/lib/actions";
import type { ClaudeSettingsFile } from "@/lib/daemon";

/**
 * Claude Code's user settings (~/.claude/settings.json) on a machine: forms for what people
 * change most, and the whole file as JSON for the rest. jin's chats and terminals read this
 * file, and so does `claude` started in a plain shell.
 */

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

const MODES = [
  { id: "default", label: "Ask (default)" },
  { id: "acceptEdits", label: "Accept edits" },
  { id: "plan", label: "Plan" },
  { id: "auto", label: "Auto" },
  { id: "dontAsk", label: "Don't ask" },
  { id: "bypassPermissions", label: "Bypass permissions" },
];
const MODELS = ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-1", "opus", "sonnet", "haiku"];
const HOOK_EVENTS = ["PreToolUse", "PostToolUse", "UserPromptSubmit", "Notification", "Stop", "SubagentStop", "SessionStart", "SessionEnd", "PreCompact"];
/** Events whose hooks take a matcher (a tool name or pattern). */
const MATCHED = new Set(["PreToolUse", "PostToolUse", "PreCompact", "SessionStart", "Notification"]);

/** `settings` with `path` set to `value`; an empty value removes the key, and an object it empties. */
function setIn(settings: Obj, path: string[], value: unknown): Obj {
  const [k, ...rest] = path;
  const next = { ...settings };
  if (rest.length) {
    const inner = setIn(isObj(next[k!]) ? (next[k!] as Obj) : {}, rest, value);
    if (Object.keys(inner).length) next[k!] = inner;
    else delete next[k!];
  } else if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || (isObj(value) && Object.keys(value).length === 0)) delete next[k!];
  else next[k!] = value;
  return next;
}
const strs = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

function Card({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>{title}</h3>
        {hint && <span className="meta">{hint}</span>}
      </div>
      <div className="md-card-body">{children}</div>
    </section>
  );
}

/** true / false / not set: absent is not the same as false (Claude Code's own default applies). */
function Tri({ label, value, onChange, hint }: { label: string; value: unknown; onChange: (v: boolean | undefined) => void; hint?: string }) {
  return (
    <label className="field">
      <span>{label}</span>
      <select value={value === true ? "on" : value === false ? "off" : ""} onChange={(e) => onChange(e.target.value === "on" ? true : e.target.value === "off" ? false : undefined)}>
        <option value="">Not set{hint ? ` (${hint})` : ""}</option>
        <option value="on">On</option>
        <option value="off">Off</option>
      </select>
    </label>
  );
}

/** A list of strings: edit in place, remove, add with Enter. */
function List({ label, items, onChange, placeholder, mono = true }: { label: string; items: string[]; onChange: (v: string[]) => void; placeholder: string; mono?: boolean }) {
  const [add, setAdd] = useState("");
  const commit = () => {
    const v = add.trim();
    if (v && !items.includes(v)) onChange([...items, v]);
    setAdd("");
  };
  return (
    <div className="field cs-list">
      <span>
        {label} <span className="cs-count">{items.length || ""}</span>
      </span>
      {items.map((it, i) => (
        <div className="cs-row" key={`${i}:${it}`}>
          <input className={mono ? "mono" : undefined} defaultValue={it} spellCheck={false} onBlur={(e) => e.target.value.trim() !== it && onChange(items.map((x, j) => (j === i ? e.target.value.trim() : x)).filter(Boolean))} />
          <button type="button" className="button quiet icon-only small" aria-label={`Remove ${it}`} onClick={() => onChange(items.filter((_, j) => j !== i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="cs-row">
        <input
          className={mono ? "mono" : undefined}
          value={add}
          spellCheck={false}
          placeholder={placeholder}
          onChange={(e) => setAdd(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              commit();
            }
          }}
          onBlur={commit}
        />
        <button type="button" className="button quiet icon-only small" aria-label="Add" disabled={!add.trim()} onClick={commit}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

/** Environment variables: values hidden until you ask (they are often tokens). */
function Env({ env, onChange }: { env: Obj; onChange: (v: Obj) => void }) {
  const [shown, setShown] = useState<string[]>([]);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const entries = Object.entries(env).map(([k, v]) => [k, typeof v === "string" ? v : String(v)] as const);
  const add = () => {
    const k = name.trim();
    if (!k) return;
    onChange({ ...env, [k]: value });
    setName("");
    setValue("");
  };
  return (
    <div className="field cs-list">
      {entries.map(([k, v]) => (
        <div className="cs-row is-env" key={k}>
          <input className="mono" value={k} readOnly aria-label="Name" />
          <input className="mono" type={shown.includes(k) ? "text" : "password"} defaultValue={v} spellCheck={false} autoComplete="off" aria-label={`Value of ${k}`} onBlur={(e) => e.target.value !== v && onChange({ ...env, [k]: e.target.value })} />
          <button type="button" className="button quiet icon-only small" aria-label={shown.includes(k) ? "Hide" : "Show"} onClick={() => setShown((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]))}>
            {shown.includes(k) ? <EyeOff size={13} /> : <Eye size={13} />}
          </button>
          <button
            type="button"
            className="button quiet icon-only small"
            aria-label={`Remove ${k}`}
            onClick={() => {
              const { [k]: _, ...rest } = env;
              onChange(rest);
            }}
          >
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="cs-row is-env">
        <input className="mono" value={name} placeholder="NAME" spellCheck={false} onChange={(e) => setName(e.target.value.replace(/\s/g, ""))} aria-label="New name" />
        <input className="mono" type="password" value={value} placeholder="value" autoComplete="off" onChange={(e) => setValue(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} aria-label="New value" />
        <button type="button" className="button quiet icon-only small" aria-label="Add" disabled={!name.trim()} onClick={add}>
          <Plus size={13} />
        </button>
        <span />
      </div>
    </div>
  );
}

type HookGroup = { matcher?: string; hooks: Obj[] };

/** Hooks by event: each a matcher and a command. Other hook types are shown and kept; edit them in the JSON. */
function Hooks({ hooks, onChange }: { hooks: Obj; onChange: (v: Obj) => void }) {
  const [event, setEvent] = useState("PreToolUse");
  const [matcher, setMatcher] = useState("");
  const [command, setCommand] = useState("");
  const groups = (e: string): HookGroup[] => (Array.isArray(hooks[e]) ? (hooks[e] as HookGroup[]) : []);
  const put = (e: string, gs: HookGroup[]) => onChange(gs.length ? { ...hooks, [e]: gs } : Object.fromEntries(Object.entries(hooks).filter(([k]) => k !== e)));
  const events = [...new Set([...HOOK_EVENTS.filter((e) => groups(e).length), ...Object.keys(hooks)])];
  const add = () => {
    if (!command.trim()) return;
    put(event, [...groups(event), { ...(MATCHED.has(event) && matcher.trim() ? { matcher: matcher.trim() } : {}), hooks: [{ type: "command", command: command.trim() }] }]);
    setCommand("");
    setMatcher("");
  };
  return (
    <div className="cs-hooks">
      {events.length === 0 && <p className="meta">No hooks of yours. jin adds its own to its runs; they are not in this file.</p>}
      {events.map((e) => (
        <div key={e} className="cs-hook-event">
          <h4>{e}</h4>
          {groups(e).map((g, gi) =>
            (Array.isArray(g.hooks) ? g.hooks : []).map((h, hi) => (
              <div className="cs-row is-hook" key={`${gi}.${hi}`}>
                <span className="cs-matcher mono" title="Matcher">
                  {g.matcher || "any"}
                </span>
                {h.type === "command" ? (
                  <input
                    className="mono"
                    defaultValue={String(h.command ?? "")}
                    spellCheck={false}
                    aria-label="Command"
                    onBlur={(ev) => {
                      const v = ev.target.value.trim();
                      if (v === h.command) return;
                      put(e, groups(e).map((x, i) => (i === gi ? { ...x, hooks: x.hooks.map((y, j) => (j === hi ? { ...y, command: v } : y)) } : x)));
                    }}
                  />
                ) : (
                  <span className="meta">a {String(h.type)} hook · edit it in the JSON below</span>
                )}
                <button
                  type="button"
                  className="button quiet icon-only small"
                  aria-label="Remove hook"
                  onClick={() =>
                    put(
                      e,
                      groups(e)
                        .map((x, i) => (i === gi ? { ...x, hooks: x.hooks.filter((_, j) => j !== hi) } : x))
                        .filter((x) => x.hooks.length),
                    )
                  }
                >
                  <X size={13} />
                </button>
              </div>
            )),
          )}
        </div>
      ))}
      <div className="cs-row is-new-hook">
        <select value={event} onChange={(e) => setEvent(e.target.value)} aria-label="Event">
          {HOOK_EVENTS.map((e) => (
            <option key={e}>{e}</option>
          ))}
        </select>
        <input className="mono" value={matcher} placeholder={MATCHED.has(event) ? "matcher: Bash, Edit|Write…" : "no matcher"} disabled={!MATCHED.has(event)} onChange={(e) => setMatcher(e.target.value)} aria-label="Matcher" />
        <input className="mono" value={command} placeholder="command to run" spellCheck={false} onChange={(e) => setCommand(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} aria-label="Command" />
        <button type="button" className="button quiet icon-only small" aria-label="Add hook" disabled={!command.trim()} onClick={add}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

export function ClaudeSettingsPage({ initial, machine, machines }: { initial: ClaudeSettingsFile; machine: string; machines: { id: string; label: string }[] }) {
  const router = useRouter();
  const start = initial.settings ?? {};
  const [draft, setDraft] = useState<Obj>(start);
  const [raw, setRaw] = useState(initial.settings ? JSON.stringify(start, null, 2) : initial.text);
  const [rawError, setRawError] = useState<string | null>(initial.error);
  const [rawDirty, setRawDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const broken = initial.settings === null;
  const dirty = rawDirty || JSON.stringify(draft) !== JSON.stringify(start);

  const set = (path: string[], value: unknown) => {
    const next = setIn(draft, path, value);
    setDraft(next);
    setRaw(JSON.stringify(next, null, 2));
    setRawDirty(false);
    setRawError(null);
    setSavedAt(null);
  };
  const parseRaw = (): Obj | null => {
    try {
      const v = JSON.parse(raw) as unknown;
      if (!isObj(v)) throw new Error("the settings must be a JSON object");
      return v;
    } catch (e) {
      setRawError((e as Error).message);
      return null;
    }
  };
  const applyRaw = () => {
    const v = parseRaw();
    if (!v) return;
    setDraft(v);
    setRaw(JSON.stringify(v, null, 2));
    setRawDirty(false);
    setRawError(null);
  };
  const save = async () => {
    const settings = rawDirty || broken ? parseRaw() : draft;
    if (!settings) return;
    setBusy(true);
    setError(null);
    const r = await saveClaudeSettings(machine, settings, initial.hash);
    setBusy(false);
    if ("error" in r) return setError(r.error);
    setSavedAt(Date.now());
    router.refresh();
  };
  const discard = () => {
    setDraft(start);
    setRaw(initial.settings ? JSON.stringify(start, null, 2) : initial.text);
    setRawDirty(false);
    setRawError(initial.error);
    setError(null);
  };

  const perms = isObj(draft.permissions) ? draft.permissions : {};
  const plugins = isObj(draft.enabledPlugins) ? draft.enabledPlugins : {};

  return (
    <div className="machines claude-settings">
      <header className="pane-header">
        <div className="pane-title">
          <span className="pane-name">Claude Code</span>
          <span className="meta mono">{initial.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</span>
        </div>
        <div className="pane-actions">
          {machines.length > 1 && (
            <label className="field cs-machine">
              <select value={machine} onChange={(e) => router.push(e.target.value === "local" ? "/claude" : `/claude?m=${encodeURIComponent(e.target.value)}`)} aria-label="Machine">
                {machines.map((m) => (
                  <option key={m.id} value={m.id}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {dirty && (
            <button type="button" className="button quiet small" onClick={discard} disabled={busy}>
              Discard
            </button>
          )}
          <button type="button" className="button small primary" onClick={() => void save()} disabled={busy || !dirty}>
            {busy ? "Saving…" : savedAt && !dirty ? "Saved" : "Save"}
          </button>
        </div>
      </header>
      <div className="machines-body is-single" data-scroll="y">
        <main className="machines-main">
          <article className="machine-detail is-wide">
            <p className="meta">
              Read by jin&apos;s chats and terminals on {machine === "local" ? "this machine" : machines.find((m) => m.id === machine)?.label}, and by <span className="mono">claude</span> in a plain shell there. New runs pick up a change; running ones keep what they started with. The previous file is kept as <span className="mono">settings.json.jin-backup</span>.
            </p>
            {error && <p className="machine-error">{error}</p>}
            {broken ? (
              <p className="machine-error">{initial.error} Fix it below, then save.</p>
            ) : (
              <>
                <Card title="Model">
                  <div className="cs-grid">
                    <label className="field">
                      <span>Model</span>
                      <input list="cs-models" value={String(draft.model ?? "")} placeholder="Claude Code's default" spellCheck={false} onChange={(e) => set(["model"], e.target.value.trim())} />
                      <datalist id="cs-models">
                        {MODELS.map((m) => (
                          <option key={m} value={m} />
                        ))}
                      </datalist>
                    </label>
                    <label className="field">
                      <span>Output style</span>
                      <input value={String(draft.outputStyle ?? "")} placeholder="default" spellCheck={false} onChange={(e) => set(["outputStyle"], e.target.value.trim())} />
                    </label>
                  </div>
                  <p className="meta">jin&apos;s chats pick their model in the composer; this is what terminals and new Claude Code sessions start with.</p>
                </Card>

                <Card title="Permissions" hint="rules like Bash(git push:*), Read(./secrets/**), mcp__slack">
                  <div className="cs-grid">
                    <label className="field">
                      <span>Default mode</span>
                      <select value={String(perms.defaultMode ?? "")} onChange={(e) => set(["permissions", "defaultMode"], e.target.value || undefined)}>
                        <option value="">Not set (ask)</option>
                        {MODES.map((m) => (
                          <option key={m.id} value={m.id}>
                            {m.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                  <List label="Allow" items={strs(perms.allow)} onChange={(v) => set(["permissions", "allow"], v)} placeholder="Bash(npm test:*)" />
                  <List label="Ask" items={strs(perms.ask)} onChange={(v) => set(["permissions", "ask"], v)} placeholder="Bash(git push:*)" />
                  <List label="Deny" items={strs(perms.deny)} onChange={(v) => set(["permissions", "deny"], v)} placeholder="Read(./.env)" />
                  <List label="More directories Claude may work in" items={strs(perms.additionalDirectories)} onChange={(v) => set(["permissions", "additionalDirectories"], v)} placeholder="~/Workspace/notes" />
                  <p className="meta">In jin&apos;s chats, an allow rule lets a tool run without coming to jin&apos;s approvals. Deny rules hold everywhere.</p>
                </Card>

                <Card title="Environment" hint="set for every Claude Code session">
                  <Env env={isObj(draft.env) ? draft.env : {}} onChange={(v) => set(["env"], v)} />
                </Card>

                <Card title="Hooks" hint="commands Claude Code runs on its events">
                  <Hooks hooks={isObj(draft.hooks) ? draft.hooks : {}} onChange={(v) => set(["hooks"], v)} />
                  <div className="cs-grid">
                    <Tri label="Turn off all hooks" value={draft.disableAllHooks} onChange={(v) => set(["disableAllHooks"], v)} hint="off" />
                  </div>
                </Card>

                <Card title="MCP servers and plugins">
                  <div className="cs-grid">
                    <Tri label="Approve every project's .mcp.json servers" value={draft.enableAllProjectMcpServers} onChange={(v) => set(["enableAllProjectMcpServers"], v)} hint="off" />
                    <Tri label="Turn off claude.ai connectors" value={draft.disableClaudeAiConnectors} onChange={(v) => set(["disableClaudeAiConnectors"], v)} hint="off" />
                  </div>
                  <List label="Approved .mcp.json servers" items={strs(draft.enabledMcpjsonServers)} onChange={(v) => set(["enabledMcpjsonServers"], v)} placeholder="server name" />
                  <List label="Rejected .mcp.json servers" items={strs(draft.disabledMcpjsonServers)} onChange={(v) => set(["disabledMcpjsonServers"], v)} placeholder="server name" />
                  {Object.keys(plugins).length > 0 && (
                    <div className="field cs-list">
                      <span>Plugins</span>
                      {Object.entries(plugins).map(([id, on]) => (
                        <label className="cs-toggle" key={id}>
                          <span className="live-switch">
                            <input type="checkbox" checked={on === true} onChange={() => set(["enabledPlugins"], { ...plugins, [id]: on !== true })} />
                            <span className="live-switch-track" />
                          </span>
                          <span className="mono">{id}</span>
                        </label>
                      ))}
                    </div>
                  )}
                </Card>

                <Card title="Other">
                  <div className="cs-grid">
                    <Tri label="Co-authored-by line in commits" value={draft.includeCoAuthoredBy} onChange={(v) => set(["includeCoAuthoredBy"], v)} hint="on" />
                    <Tri label="Respect .gitignore in file search" value={draft.respectGitignore} onChange={(v) => set(["respectGitignore"], v)} hint="on" />
                    <label className="field">
                      <span>Keep chat history (days)</span>
                      <input
                        type="number"
                        min={0}
                        value={typeof draft.cleanupPeriodDays === "number" ? draft.cleanupPeriodDays : ""}
                        placeholder="30"
                        onChange={(e) => set(["cleanupPeriodDays"], e.target.value === "" ? undefined : Math.max(0, Math.floor(Number(e.target.value))))}
                      />
                    </label>
                  </div>
                </Card>
              </>
            )}

            <details className="md-card cs-raw" open={broken}>
              <summary className="md-card-head">
                <h3>All settings as JSON</h3>
                <span className="meta">every key, including ones without a form above</span>
              </summary>
              <div className="md-card-body">
                <textarea
                  className="mono cs-raw-text"
                  rows={18}
                  spellCheck={false}
                  value={raw}
                  onChange={(e) => {
                    setRaw(e.target.value);
                    setRawDirty(true);
                    setRawError(null);
                    setSavedAt(null);
                  }}
                />
                {rawError && <p className="machine-error">{rawError}</p>}
                {rawDirty && !broken && (
                  <div className="hook-actions">
                    <span className="hook-spacer" />
                    <button type="button" className="button small" onClick={applyRaw}>
                      Apply to the forms
                    </button>
                  </div>
                )}
              </div>
            </details>
          </article>
        </main>
      </div>
    </div>
  );
}
