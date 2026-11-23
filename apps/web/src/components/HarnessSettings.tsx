"use client";
import { ChevronDown, ChevronRight, LoaderCircle } from "lucide-react";
import { useEffect, useState } from "react";
import { AgentPicker } from "@/components/AgentPicker";
import { ClaudeSettingsEditor } from "@/components/ClaudeSettings";
import { getClaudeSettings, listAgents } from "@/lib/actions";
import type { AgentId, ClaudeSettingsFile, MachineAgents } from "@/lib/daemon";

/** Where each harness keeps its own settings on a machine (jin adds its hooks per launch and leaves these files alone). */
const CONFIG: Record<AgentId, string> = {
  claude: "~/.claude/settings.json",
  codex: "~/.codex/config.toml",
  pi: "~/.pi/agent/settings.json",
  opencode: "~/.config/opencode/opencode.json",
};

/**
 * A machine's coding agents: which one new sessions start, and a settings card for each harness
 * installed there. Claude Code's settings are edited here; the others show where their own
 * settings live on that machine.
 */
export function HarnessSettings({ machine, name }: { machine: string; name: string }) {
  const [agents, setAgents] = useState<MachineAgents | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listAgents(machine).then((a) => {
      if (!live) return;
      if ("error" in a) setError(a.error);
      else setAgents(a);
    });
    return () => {
      live = false;
    };
  }, [machine]);
  const installed = agents?.agents.filter((a) => a.installed) ?? [];
  return (
    <>
      <AgentPicker machine={machine} name={name} />
      {error && <p className="machine-error">Could not read {name}&apos;s agents: {error}</p>}
      {!agents && !error && (
        <p className="meta">
          <LoaderCircle size={12} className="spin" /> Looking for agents on {name}…
        </p>
      )}
      {installed.map((a) =>
        a.id === "claude" ? (
          <ClaudeSection key={a.id} machine={machine} name={name} />
        ) : (
          <section key={a.id} className="md-card">
            <div className="md-card-head is-static">
              <h3>{a.label}</h3>
              <span className="meta">{[a.version, a.problem ? "not supported here" : agents?.default === a.id ? "the machine's agent" : null].filter(Boolean).join(" · ")}</span>
            </div>
            <div className="md-card-body">
              <p className="meta">
                Its settings are its own: <span className="mono">{CONFIG[a.id]}</span> on {name}. jin passes its hooks, tools and the task&apos;s rules with each launch and does not edit that file
                {a.id === "codex" ? " (apart from trusting jin's hooks, a hooks.state entry)" : ""}.
              </p>
              {a.problem && <p className="machine-error">{a.problem}</p>}
            </div>
          </section>
        ),
      )}
    </>
  );
}

/** Claude Code's settings on a machine, loaded when opened. */
function ClaudeSection({ machine, name }: { machine: string; name: string }) {
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<ClaudeSettingsFile | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open || file) return;
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
  }, [open, file, machine]);
  return (
    <section className="md-card">
      <button type="button" className="md-card-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
        <h3>Claude Code</h3>
        <span className="meta">settings for jin&apos;s chats and terminals on {name}</span>
      </button>
      {open && (
        <div className="md-card-body">
          {error && <p className="machine-error">{error}</p>}
          {!file && !error && (
            <p className="meta">
              <LoaderCircle size={12} className="spin" /> Reading Claude Code&apos;s settings on {name}…
            </p>
          )}
          {file && <ClaudeSettingsEditor key={file.hash} initial={file} machine={machine} name={name} onSaved={setFile} />}
        </div>
      )}
    </section>
  );
}
