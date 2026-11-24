"use client";
import { LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { ClaudeSettingsEditor } from "@/components/ClaudeSettings";
import { getClaudeSettings, listAgents, setDefaultAgent } from "@/lib/actions";
import type { AgentId, ClaudeSettingsFile, MachineAgents } from "@/lib/daemon";

/**
 * A machine's coding agents, split the way its page is: the main column picks one (and marks the
 * machine's default), the side panel shows and configures the one picked.
 */

type Agent = MachineAgents["agents"][number];

/** Where each harness keeps its own settings on a machine (jin adds its hooks per launch and leaves these files alone). */
const CONFIG: Record<AgentId, string> = {
  claude: "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  pi: "~/.pi/agent/settings.json",
  opencode: "~/.config/opencode/opencode.json",
};

/** A machine's agents, loaded once for its page (once it can answer); `pick` is the one its side panel shows (the default until another is picked). */
export function useMachineAgents(machine: string, enabled = true) {
  const [agents, setAgents] = useState<MachineAgents | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<AgentId | null>(null);
  useEffect(() => {
    let live = true;
    setAgents(null);
    setError(null);
    setPicked(null);
    if (!enabled) return;
    void listAgents(machine).then((a) => {
      if (!live) return;
      if ("error" in a) setError(a.error);
      else setAgents(a);
    });
    return () => {
      live = false;
    };
  }, [machine, enabled]);
  const pick = picked ?? agents?.default ?? null;
  const makeDefault = useCallback(
    async (id: AgentId): Promise<string | null> => {
      const r = await setDefaultAgent(id, machine);
      if ("error" in r) return r.error;
      setAgents(r);
      return null;
    },
    [machine],
  );
  return { agents, error, pick, setPick: setPicked, makeDefault };
}

/** The main column's card: one tab per agent; picking one opens it in the side panel (the default carries a mark). */
export function AgentSelector({ agents, error, pick, onPick, name }: { agents: MachineAgents | null; error: string | null; pick: AgentId | null; onPick: (id: AgentId) => void; name: string }) {
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Coding agent</h3>
        <span className="meta">pick one to see and change its settings</span>
      </div>
      <div className="md-card-body">
        {!agents && !error && (
          <p className="meta">
            <LoaderCircle size={12} className="spin" /> Looking for agents on {name}…
          </p>
        )}
        {error && <p className="machine-error">Could not read {name}&apos;s agents: {error}</p>}
        {agents && (
          <div className="agent-tabs" role="tablist" aria-label="Coding agents">
            {agents.agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="tab"
                aria-selected={pick === a.id}
                className={`agent-tab ${pick === a.id ? "is-picked" : ""} ${!a.installed ? "is-missing" : ""}`}
                onClick={() => onPick(a.id)}
                title={!a.installed ? `${a.label} is not installed on ${name}` : (a.problem ?? undefined)}
              >
                {a.label}
                {agents.default === a.id && <span className="machine-pill is-home">default</span>}
                {a.installed && a.problem && <span className="meta">not supported</span>}
                {!a.installed && <span className="meta">not installed</span>}
              </button>
            ))}
          </div>
        )}
        <p className="meta">
          New tabs, task chats and agent rooms on {name} start the default. jin checks every tool call whichever runs, and asks before anything outward: Claude Code, pi and opencode in their own prompt, Codex
          through its sandbox. jin&apos;s chat and desks stay on Claude.
        </p>
      </div>
    </section>
  );
}

/** The side panel: a title, what it is, its actions, and the settings of whatever the main column picked. */
export function SidePanel({ title, badge, meta, actions, children }: { title: string; badge?: React.ReactNode; meta?: string; actions?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="machine-side-col">
      <aside className="machine-side" aria-label={title}>
        <header className="md-head">
          <div className="md-title">
            <div className="md-name">
              <h2>{title}</h2>
              {badge}
            </div>
            {meta && <span className="meta">{meta}</span>}
          </div>
          {actions && <div className="md-actions">{actions}</div>}
        </header>
        {children}
      </aside>
    </div>
  );
}

/** One agent in the side panel: whether it is the default (and making it so), and its settings. */
export function AgentPanel({ agent, isDefault, machine, name, makeDefault }: { agent: Agent; isDefault: boolean; machine: string; name: string; makeDefault: (id: AgentId) => Promise<string | null> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => setError(null), [agent.id]);
  const meta = !agent.installed ? `not installed on ${name}` : isDefault ? `what new sessions on ${name} start` : `installed on ${name}`;
  return (
    <SidePanel
      title={agent.label}
      badge={agent.installed && agent.version ? <span className="machine-pill">{agent.version}</span> : undefined}
      meta={meta}
      actions={
        isDefault ? (
          <span className="machine-pill is-home">default</span>
        ) : (
          <button
            type="button"
            className="button small"
            disabled={busy || !agent.installed || Boolean(agent.problem)}
            title={!agent.installed ? `${agent.label} is not installed on ${name}` : (agent.problem ?? `New tabs, task chats and rooms on ${name} start ${agent.label}`)}
            onClick={async () => {
              setBusy(true);
              setError(await makeDefault(agent.id));
              setBusy(false);
            }}
          >
            {busy ? <LoaderCircle size={12} className="spin" /> : null} Use for new sessions
          </button>
        )
      }
    >
      {error && <p className="machine-error">{error}</p>}
      {agent.installed && agent.problem && <p className="machine-error">{agent.problem}</p>}
      {!agent.installed && <p className="meta">{agent.label} is not installed on {name}. Install it there, then it can run jin&apos;s sessions.</p>}
      {agent.installed &&
        (agent.id === "claude" ? (
          <ClaudeSettingsCard machine={machine} name={name} />
        ) : (
          <section className="md-card">
            <div className="md-card-head is-static">
              <h3>Settings</h3>
              <span className="meta mono">{CONFIG[agent.id]}</span>
            </div>
            <div className="md-card-body">
              <p className="meta">
                {agent.label} keeps its own settings in <span className="mono">{CONFIG[agent.id]}</span> on {name}. jin passes its hooks, tools and the task&apos;s rules with each launch and does not edit that
                file{agent.id === "codex" ? " (apart from trusting jin's hooks, a hooks.state entry)" : ""}.
              </p>
            </div>
          </section>
        ))}
    </SidePanel>
  );
}

/** Claude Code's settings file on a machine, in the side panel (its sections laid out flat there). */
function ClaudeSettingsCard({ machine, name }: { machine: string; name: string }) {
  const [file, setFile] = useState<ClaudeSettingsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (file) return;
    let live = true;
    void getClaudeSettings(machine).then((r) => {
      if (!live) return;
      // The file itself has an `error` field (null when it parses): a read is a failure only without a hash.
      if ("hash" in r) setFile(r);
      else setError(r.error);
    });
    return () => {
      live = false;
    };
  }, [file, machine]);
  if (error) return <p className="machine-error">{error}</p>;
  if (!file)
    return (
      <p className="meta">
        <LoaderCircle size={12} className="spin" /> Reading Claude Code&apos;s settings on {name}…
      </p>
    );
  return <ClaudeSettingsEditor key={file.hash} initial={file} machine={machine} name={name} onSaved={setFile} />;
}
