"use client";
import { LoaderCircle } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { listAgents, setDefaultAgent } from "@/lib/actions";
import type { AgentId, MachineAgents } from "@/lib/daemon";

/**
 * Which coding agent new sessions start on a machine (Claude Code or Codex). Each runs with its
 * own setup and sign-in there; tabs already open keep the agent they started with.
 */
export function AgentPicker({ machine, name }: { machine?: string; name: string }) {
  const router = useRouter();
  const [agents, setAgents] = useState<MachineAgents | null>(null);
  const [busy, setBusy] = useState<AgentId | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    void listAgents(machine).then((a) => {
      if (!live) return;
      if ("error" in a) setError(`Could not read ${name}'s agents: ${a.error}`);
      else setAgents(a);
    });
    return () => {
      live = false;
    };
  }, [machine, name]);
  const pick = async (id: AgentId) => {
    setBusy(id);
    setError(null);
    const r = await setDefaultAgent(id, machine);
    setBusy(null);
    if ("error" in r) setError(r.error);
    else {
      setAgents(r);
      router.refresh();
    }
  };
  return (
    <section className="md-card">
      <div className="md-card-head is-static">
        <h3>Coding agent</h3>
        <span className="meta">what new sessions on {name} start</span>
      </div>
      <div className="md-card-body">
        {!agents && !error && (
          <p className="meta">
            <LoaderCircle size={12} className="spin" /> Looking for agents on {name}…
          </p>
        )}
        {agents && (
          <div className="agent-picker" role="radiogroup" aria-label="Coding agent">
            {agents.agents.map((a) => (
              <button
                key={a.id}
                type="button"
                role="radio"
                aria-checked={agents.default === a.id}
                className={`button small ${agents.default === a.id ? "primary" : "quiet"}`}
                disabled={!a.installed || Boolean(a.problem) || busy !== null}
                title={!a.installed ? `${a.label} is not installed on ${name}` : (a.problem ?? (a.version ? `${a.label} ${a.version}` : undefined))}
                onClick={() => agents.default !== a.id && void pick(a.id)}
              >
                {busy === a.id && <LoaderCircle size={12} className="spin" />} {a.label}
                {!a.installed && <span className="meta"> · not installed</span>}
                {a.installed && a.problem && <span className="meta"> · {a.version ?? "unknown version"}, not supported</span>}
              </button>
            ))}
          </div>
        )}
        <p className="meta">
          Each agent uses its own setup and sign-in on {name}; tabs and chats already open keep theirs. Whichever runs, jin checks every tool call and asks before anything outward: Claude Code, pi and
          opencode in their own prompt, Codex through its sandbox. A task&apos;s chats and agent rooms use it too; jin&apos;s chat and desks stay on Claude.
        </p>
        {agents?.agents
          .filter((a) => a.installed && a.problem)
          .map((a) => (
            <p key={a.id} className="meta">
              {a.label}: {a.problem}
            </p>
          ))}
        {error && <p className="machine-error">{error}</p>}
      </div>
    </section>
  );
}
