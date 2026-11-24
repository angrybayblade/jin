"use client";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { saveClaudeSettings } from "@/lib/actions";
import type { ClaudeSettingsFile } from "@/lib/daemon";
import { Card, Env, isObj, List, type Obj, setIn, strs, Tri } from "@/components/SettingsFields";

/**
 * Claude Code's user settings (~/.claude/settings.json) on a machine: forms for what people
 * change most, and the whole file as JSON for the rest. jin's chats and terminals read this
 * file, and so does `claude` started in a plain shell.
 */

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

/** The editor for one machine's file; `onSaved` hands back the file as written (the caller reloads with it). */
export function ClaudeSettingsEditor({ initial, machine, name, onSaved }: { initial: ClaudeSettingsFile; machine: string; name: string; onSaved: (file: ClaudeSettingsFile) => void }) {
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
    // A saved file has an `error` field too (null): a failure is a result without a hash.
    if (!("hash" in r)) return setError(r.error);
    setSavedAt(Date.now());
    onSaved(r);
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
    <div className="claude-settings">
      <div className="cs-bar">
        <span className="meta mono">{initial.path.replace(/^\/(Users|home)\/[^/]+/, "~")}</span>
        <span className="hook-spacer" />
        {dirty && (
          <button type="button" className="button quiet small" onClick={discard} disabled={busy}>
            Discard
          </button>
        )}
        <button type="button" className="button small primary" onClick={() => void save()} disabled={busy || !dirty}>
          {busy ? "Saving…" : savedAt && !dirty ? "Saved" : "Save"}
        </button>
      </div>
            <p className="meta">
              Read by jin&apos;s chats and terminals on {name}, and by <span className="mono">claude</span> in a plain shell there. New runs pick up a change; running ones keep what they started with. The previous file is kept as <span className="mono">settings.json.jin-backup</span>.
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
    </div>
  );
}
