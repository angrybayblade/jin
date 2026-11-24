"use client";
import { Plus, X } from "lucide-react";
import { useState } from "react";
import { Card, Choice, isObj, List, Num, type Obj, setIn, strs, Text, Tri } from "@/components/SettingsFields";
import { saveAgentSettings } from "@/lib/actions";
import type { HarnessSettingsFile } from "@/lib/daemon";

/**
 * Codex's, pi's and opencode's own settings on a machine: forms for what people change most,
 * and the file as text (TOML or JSON, comments included) for the rest. A save from the forms
 * changes only the keys they changed, so the rest of the file, comments too, stays as it is.
 */

type Set = (path: string[], value: unknown) => void;

/** MCP servers, whatever shape the agent keeps them in: listed, switched on and off, removed, added from a command or a URL. */
function Servers({
  entries,
  onToggle,
  onRemove,
  onAdd,
}: {
  entries: { name: string; what: string; on: boolean }[];
  onToggle?: (name: string, on: boolean) => void;
  onRemove: (name: string) => void;
  onAdd: (name: string, target: { url: string } | { command: string[] }) => void;
}) {
  const [name, setName] = useState("");
  const [target, setTarget] = useState("");
  const add = () => {
    const n = name.trim();
    const t = target.trim();
    if (!n || !t) return;
    onAdd(n, /^https?:\/\//.test(t) ? { url: t } : { command: t.split(/\s+/) });
    setName("");
    setTarget("");
  };
  return (
    <div className="field cs-list">
      {entries.length === 0 && <p className="meta">No MCP servers of yours. jin passes its own tools with each launch.</p>}
      {entries.map((e) => (
        <div className={`cs-row ${onToggle ? "is-server" : "is-server-plain"}`} key={e.name}>
          {onToggle && (
            <span className="live-switch" title={e.on ? "On" : "Off"}>
              <input type="checkbox" checked={e.on} aria-label={`${e.name} on`} onChange={() => onToggle(e.name, !e.on)} />
              <span className="live-switch-track" />
            </span>
          )}
          <span className="mono cs-server-name">{e.name}</span>
          <span className="mono meta cs-server-what" title={e.what}>
            {e.what}
          </span>
          <button type="button" className="button quiet icon-only small" aria-label={`Remove ${e.name}`} onClick={() => onRemove(e.name)}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="cs-row is-new-server">
        <input className="mono" value={name} placeholder="name" spellCheck={false} onChange={(e) => setName(e.target.value.replace(/[^\w-]/g, ""))} aria-label="Server name" />
        <input className="mono" value={target} placeholder="command and arguments, or https:// URL" spellCheck={false} onChange={(e) => setTarget(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} aria-label="Command or URL" />
        <button type="button" className="button quiet icon-only small" aria-label="Add server" disabled={!name.trim() || !target.trim()} onClick={add}>
          <Plus size={13} />
        </button>
      </div>
      <p className="meta">Environment, headers and other options: edit them in the file below.</p>
    </div>
  );
}

const without = (o: Obj, k: string) => Object.fromEntries(Object.entries(o).filter(([x]) => x !== k));

// ---- Codex: ~/.codex/config.toml

function CodexForms({ draft, set }: { draft: Obj; set: Set }) {
  const sww = isObj(draft.sandbox_workspace_write) ? draft.sandbox_workspace_write : {};
  const servers = isObj(draft.mcp_servers) ? draft.mcp_servers : {};
  const projects = isObj(draft.projects) ? draft.projects : {};
  return (
    <>
      <Card title="Model">
        <div className="cs-grid">
          <Text label="Model" value={draft.model} onChange={(v) => set(["model"], v)} placeholder="Codex's default" />
          <Text label="Reasoning effort" value={draft.model_reasoning_effort} onChange={(v) => set(["model_reasoning_effort"], v)} placeholder="the model's default" suggestions={["minimal", "low", "medium", "high", "xhigh"]} />
          <Choice label="Reasoning summary" value={draft.model_reasoning_summary} options={["auto", "concise", "detailed", "none"]} onChange={(v) => set(["model_reasoning_summary"], v)} hint="auto" />
          <Choice label="Verbosity" value={draft.model_verbosity} options={["low", "medium", "high"]} onChange={(v) => set(["model_verbosity"], v)} hint="medium" />
          <Choice label="Web search" value={draft.web_search} options={["disabled", "cached", "indexed", "live"]} onChange={(v) => set(["web_search"], v)} hint="Codex's default" />
          <Text label="Model provider" value={draft.model_provider} onChange={(v) => set(["model_provider"], v)} placeholder="openai" mono />
        </div>
      </Card>

      <Card title="Sandbox and approvals" hint="for codex in a plain shell">
        <div className="cs-grid">
          {isObj(draft.approval_policy) ? (
            <label className="field">
              <span>Approvals</span>
              <span className="meta">granular · edit it in the file below</span>
            </label>
          ) : (
            <Choice
              label="Approvals"
              value={draft.approval_policy}
              options={[
                { id: "untrusted", label: "Ask unless trusted (untrusted)" },
                { id: "on-request", label: "When Codex asks (on-request)" },
                { id: "never", label: "Never ask (never)" },
              ]}
              onChange={(v) => set(["approval_policy"], v)}
              hint="Codex's default"
            />
          )}
          <Choice
            label="Sandbox"
            value={draft.sandbox_mode}
            options={[
              { id: "read-only", label: "Read only" },
              { id: "workspace-write", label: "Workspace write" },
              { id: "danger-full-access", label: "Full access (no sandbox)" },
            ]}
            onChange={(v) => set(["sandbox_mode"], v)}
            hint="Codex's default"
          />
          <Tri label="Network in the workspace-write sandbox" value={sww.network_access} onChange={(v) => set(["sandbox_workspace_write", "network_access"], v)} hint="off" />
        </div>
        <List label="More writable directories" items={strs(sww.writable_roots)} onChange={(v) => set(["sandbox_workspace_write", "writable_roots"], v)} placeholder="/Users/me/notes" />
        <p className="meta">jin&apos;s Codex tabs and chats always run in the workspace-write sandbox with the network off and ask first, and pass the task&apos;s rules as developer instructions, whatever this file says.</p>
      </Card>

      <Card title="MCP servers" hint="[mcp_servers]">
        <Servers
          entries={Object.entries(servers).map(([name, s]) => {
            const o = isObj(s) ? s : {};
            return { name, what: typeof o.url === "string" ? o.url : [o.command, ...strs(o.args)].filter(Boolean).join(" "), on: o.enabled !== false };
          })}
          onToggle={(name, on) => set(["mcp_servers", name, "enabled"], on ? undefined : false)}
          onRemove={(name) => set(["mcp_servers"], without(servers, name))}
          onAdd={(name, t) => set(["mcp_servers", name], "url" in t ? { url: t.url } : { command: t.command[0], ...(t.command.length > 1 ? { args: t.command.slice(1) } : {}) })}
        />
      </Card>

      {Object.keys(projects).length > 0 && (
        <Card title="Projects" hint="folders Codex trusts or not">
          <div className="field cs-list">
            {Object.entries(projects).map(([path, p]) => (
              <div className="cs-row is-project" key={path}>
                <span className="mono cs-server-what" title={path}>
                  {path.replace(/^\/(Users|home)\/[^/]+/, "~")}
                </span>
                <select value={isObj(p) && typeof p.trust_level === "string" ? p.trust_level : ""} onChange={(e) => set(["projects", path, "trust_level"], e.target.value || undefined)} aria-label={`Trust for ${path}`}>
                  <option value="">Not set</option>
                  <option value="trusted">Trusted</option>
                  <option value="untrusted">Untrusted</option>
                </select>
                <button type="button" className="button quiet icon-only small" aria-label={`Forget ${path}`} onClick={() => set(["projects"], without(projects, path))}>
                  <X size={13} />
                </button>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}

// ---- pi: ~/.pi/agent/settings.json

function PiForms({ draft, set }: { draft: Obj; set: Set }) {
  const compaction = isObj(draft.compaction) ? draft.compaction : {};
  const retry = isObj(draft.retry) ? draft.retry : {};
  return (
    <>
      <Card title="Model">
        <div className="cs-grid">
          <Text label="Provider" value={draft.defaultProvider} onChange={(v) => set(["defaultProvider"], v)} placeholder="picked automatically" mono suggestions={["anthropic", "openai", "openai-codex", "google", "openrouter"]} />
          <Text label="Model" value={draft.defaultModel} onChange={(v) => set(["defaultModel"], v)} placeholder="picked automatically" mono />
          <Choice label="Thinking" value={draft.defaultThinkingLevel} options={["off", "minimal", "low", "medium", "high", "xhigh", "max"]} onChange={(v) => set(["defaultThinkingLevel"], v)} hint="medium" />
          <Tri label="Hide thinking in the transcript" value={draft.hideThinkingBlock} onChange={(v) => set(["hideThinkingBlock"], v)} hint="off" />
        </div>
        <List label="Models to pick from and cycle through" items={strs(draft.enabledModels)} onChange={(v) => set(["enabledModels"], v)} placeholder="anthropic/claude-*" />
      </Card>

      <Card title="Tools" hint="plain names replace the defaults; +name adds, -name removes">
        <List label="Tools at startup" items={strs(draft.defaultTools)} onChange={(v) => set(["defaultTools"], v)} placeholder="+grep" />
      </Card>

      <Card title="Extensions, skills and prompts" hint="files or directories">
        <List label="Extensions" items={strs(draft.extensions)} onChange={(v) => set(["extensions"], v)} placeholder="~/pi/my-extension.ts" />
        <List label="Skills" items={strs(draft.skills)} onChange={(v) => set(["skills"], v)} placeholder="~/skills" />
        <List label="Prompt templates" items={strs(draft.prompts)} onChange={(v) => set(["prompts"], v)} placeholder="~/prompts" />
        <div className="cs-grid">
          <Tri label="Skills as /skill:name commands" value={draft.enableSkillCommands} onChange={(v) => set(["enableSkillCommands"], v)} hint="on" />
        </div>
        <p className="meta">jin loads its own extension with each launch to check every tool call; it is not in this file. MCP servers live in mcp.json beside this file.</p>
      </Card>

      <Card title="Compaction and retries">
        <div className="cs-grid">
          <Tri label="Compact automatically" value={compaction.enabled} onChange={(v) => set(["compaction", "enabled"], v)} hint="on" />
          <Num label="Tokens kept for the reply" value={compaction.reserveTokens} onChange={(v) => set(["compaction", "reserveTokens"], v)} placeholder="16384" />
          <Num label="Recent tokens kept as they are" value={compaction.keepRecentTokens} onChange={(v) => set(["compaction", "keepRecentTokens"], v)} placeholder="20000" />
          <Tri label="Retry failed requests" value={retry.enabled} onChange={(v) => set(["retry", "enabled"], v)} hint="on" />
          <Num label="Retries" value={retry.maxRetries} onChange={(v) => set(["retry", "maxRetries"], v)} placeholder="3" />
        </div>
      </Card>

      <Card title="Other">
        <div className="cs-grid">
          <Text label="Theme" value={draft.theme} onChange={(v) => set(["theme"], v)} placeholder="system" />
          <Choice
            label="Projects without a decision"
            value={draft.defaultProjectTrust}
            options={[
              { id: "ask", label: "Ask" },
              { id: "always", label: "Trust" },
              { id: "never", label: "Do not trust" },
            ]}
            onChange={(v) => set(["defaultProjectTrust"], v)}
            hint="ask"
          />
          <Text label="Shell" value={draft.shellPath} onChange={(v) => set(["shellPath"], v)} placeholder="the platform's" mono />
          <Text label="Prefix for every shell command" value={draft.shellCommandPrefix} onChange={(v) => set(["shellCommandPrefix"], v)} mono />
          <Tri label="Install and update reports" value={draft.enableInstallTelemetry} onChange={(v) => set(["enableInstallTelemetry"], v)} hint="on" />
        </div>
      </Card>
    </>
  );
}

// ---- opencode: ~/.config/opencode/opencode.json(c)

type Rule = { action: string; resource: string; effect: string };

/** opencode's permission rules, in order: an action (a tool), a resource pattern, and what to do. */
function Rules({ rules, onChange }: { rules: Rule[]; onChange: (v: Rule[]) => void }) {
  const [action, setAction] = useState("");
  const [resource, setResource] = useState("");
  const [effect, setEffect] = useState("ask");
  const add = () => {
    if (!action.trim()) return;
    onChange([...rules, { action: action.trim(), resource: resource.trim() || "*", effect }]);
    setAction("");
    setResource("");
  };
  const put = (i: number, r: Partial<Rule>) => onChange(rules.map((x, j) => (j === i ? { ...x, ...r } : x)));
  return (
    <div className="field cs-list">
      {rules.map((r, i) => (
        <div className="cs-row is-rule" key={`${i}:${r.action}:${r.resource}`}>
          <input className="mono" defaultValue={r.action} aria-label="Action" spellCheck={false} onBlur={(e) => e.target.value.trim() && e.target.value.trim() !== r.action && put(i, { action: e.target.value.trim() })} />
          <input className="mono" defaultValue={r.resource} aria-label="Resource" spellCheck={false} onBlur={(e) => e.target.value.trim() !== r.resource && put(i, { resource: e.target.value.trim() || "*" })} />
          <select value={r.effect} onChange={(e) => put(i, { effect: e.target.value })} aria-label="Effect">
            <option value="allow">allow</option>
            <option value="ask">ask</option>
            <option value="deny">deny</option>
          </select>
          <button type="button" className="button quiet icon-only small" aria-label="Remove rule" onClick={() => onChange(rules.filter((_, j) => j !== i))}>
            <X size={13} />
          </button>
        </div>
      ))}
      <div className="cs-row is-rule">
        <input className="mono" value={action} placeholder="action: shell, edit, read…" spellCheck={false} onChange={(e) => setAction(e.target.value)} aria-label="New action" />
        <input className="mono" value={resource} placeholder="resource: git push*, *.env…" spellCheck={false} onChange={(e) => setResource(e.target.value)} onKeyDown={(e) => e.key === "Enter" && (e.preventDefault(), add())} aria-label="New resource" />
        <select value={effect} onChange={(e) => setEffect(e.target.value)} aria-label="New effect">
          <option value="allow">allow</option>
          <option value="ask">ask</option>
          <option value="deny">deny</option>
        </select>
        <button type="button" className="button quiet icon-only small" aria-label="Add rule" disabled={!action.trim()} onClick={add}>
          <Plus size={13} />
        </button>
      </div>
    </div>
  );
}

function OpencodeForms({ draft, set }: { draft: Obj; set: Set }) {
  const mcp = isObj(draft.mcp) ? draft.mcp : {};
  const servers = isObj(mcp.servers) ? mcp.servers : {};
  const rules = (Array.isArray(draft.permissions) ? draft.permissions : []).filter((r): r is Rule => isObj(r) && typeof r.action === "string" && typeof r.resource === "string" && typeof r.effect === "string");
  return (
    <>
      <Card title="Model">
        <div className="cs-grid">
          <Text label="Model" value={typeof draft.model === "string" ? draft.model : undefined} onChange={(v) => set(["model"], v)} placeholder="provider/model" mono />
          <Text label="Small model (titles and the like)" value={draft.small_model} onChange={(v) => set(["small_model"], v)} placeholder="provider/model" mono />
          <Text label="Default agent" value={draft.default_agent} onChange={(v) => set(["default_agent"], v)} placeholder="build" mono />
        </div>
        <List label="Only these providers" items={strs(draft.enabled_providers)} onChange={(v) => set(["enabled_providers"], v)} placeholder="openai" />
        <List label="Never these providers" items={strs(draft.disabled_providers)} onChange={(v) => set(["disabled_providers"], v)} placeholder="openrouter" />
      </Card>

      <Card title="Permissions" hint="rules in order: a tool, a pattern, and allow, ask or deny">
        <Rules rules={rules} onChange={(v) => set(["permissions"], v)} />
        <p className="meta">jin&apos;s plugin checks every tool call in jin&apos;s opencode tabs and chats as well, and asks before anything outward, whatever these rules say.</p>
      </Card>

      <Card title="MCP servers" hint="mcp.servers">
        <Servers
          entries={Object.entries(servers).map(([name, s]) => {
            const o = isObj(s) ? s : {};
            return { name, what: typeof o.url === "string" ? o.url : strs(o.command).join(" "), on: o.disabled !== true };
          })}
          onToggle={(name, on) => set(["mcp", "servers", name, "disabled"], on ? undefined : true)}
          onRemove={(name) => set(["mcp", "servers"], without(servers, name))}
          onAdd={(name, t) => set(["mcp", "servers", name], "url" in t ? { type: "remote", url: t.url } : { type: "local", command: t.command })}
        />
      </Card>

      <Card title="Instructions" hint="files or URLs every session reads">
        <List label="Instructions" items={strs(draft.instructions)} onChange={(v) => set(["instructions"], v)} placeholder="~/rules/AGENTS.md" />
      </Card>

      <Card title="Other">
        <div className="cs-grid">
          <Choice
            label="Sharing"
            value={draft.share}
            options={[
              { id: "manual", label: "When you share" },
              { id: "auto", label: "Every session" },
              { id: "disabled", label: "Never" },
            ]}
            onChange={(v) => set(["share"], v)}
            hint="manual"
          />
          <Choice
            label="Updates"
            value={draft.update}
            options={[
              { id: "notify", label: "Tell me" },
              { id: "auto", label: "Install them" },
              { id: "disable", label: "Off" },
            ]}
            onChange={(v) => set(["update"], v)}
            hint="opencode's default"
          />
          <Tri label="Snapshots for undo" value={draft.snapshots} onChange={(v) => set(["snapshots"], v)} hint="on" />
          <Text label="Shell" value={draft.shell} onChange={(v) => set(["shell"], v)} placeholder="the system's" mono />
        </div>
      </Card>
    </>
  );
}

const FORMS = { codex: CodexForms, pi: PiForms, opencode: OpencodeForms };
const LANGUAGE = { toml: "TOML", json: "JSON", jsonc: "JSON with comments" };

/** The editor for one agent's file on one machine; `onSaved` hands back the file as written (the caller reloads with it). */
export function AgentSettingsEditor({ initial, machine, name, label, onSaved }: { initial: HarnessSettingsFile; machine: string; name: string; label: string; onSaved: (file: HarnessSettingsFile) => void }) {
  const start = initial.settings ?? {};
  const [draft, setDraft] = useState<Obj>(start);
  const [text, setText] = useState(initial.text);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const broken = initial.settings === null;
  const formsDirty = JSON.stringify(draft) !== JSON.stringify(start);
  const textDirty = text !== initial.text;
  const dirty = formsDirty || textDirty;
  const Forms = FORMS[initial.agent];

  const set: Set = (path, value) => {
    setDraft((d) => setIn(d, path, value));
    setSavedAt(null);
  };
  const save = async () => {
    setBusy(true);
    setError(null);
    const r = await saveAgentSettings(machine, initial.agent, textDirty || broken ? { text } : { settings: draft }, initial.hash);
    setBusy(false);
    // A saved file has an `error` field too (null): a failure is a result without a hash.
    if (!("hash" in r)) return setError(r.error);
    setSavedAt(Date.now());
    onSaved(r);
  };
  const discard = () => {
    setDraft(start);
    setText(initial.text);
    setError(null);
  };

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
        {label}&apos;s own settings on {name}, read by jin&apos;s {label} tabs and chats there and by <span className="mono">{initial.agent}</span> in a plain shell. A save changes only what you changed and keeps the previous file as{" "}
        <span className="mono">{initial.path.split("/").pop()}.jin-backup</span>.
      </p>
      {error && <p className="machine-error">{error}</p>}
      {broken ? (
        <p className="machine-error">{initial.error} Fix it below, then save.</p>
      ) : (
        <fieldset className="cs-forms" disabled={textDirty} title={textDirty ? "You edited the file's text: save or discard it to use the forms" : undefined}>
          <Forms draft={draft} set={set} />
        </fieldset>
      )}

      <details className="md-card cs-raw" open={broken}>
        <summary className="md-card-head">
          <h3>The file as {LANGUAGE[initial.format]}</h3>
          <span className="meta">every key{initial.format === "json" ? "" : ", comments included"}</span>
        </summary>
        <div className="md-card-body">
          {formsDirty && <p className="meta">The forms&apos; changes are saved into this file as you see it here; save or discard them to edit the text.</p>}
          <textarea className="mono cs-raw-text" rows={18} spellCheck={false} value={text} disabled={formsDirty} placeholder={initial.exists ? undefined : `No file yet: the forms or text here create ${initial.path.split("/").pop()}.`} onChange={(e) => (setText(e.target.value), setSavedAt(null))} />
        </div>
      </details>
    </div>
  );
}
