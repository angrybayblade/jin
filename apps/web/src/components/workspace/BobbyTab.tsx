"use client";
import { ExternalLink, RotateCcw } from "lucide-react";
import { useEffect, useState } from "react";
import { bobbyEmbed } from "@/app/actions";
import { ThermalMark } from "../ThermalMark";

/**
 * A Bobby review inside a task tab. Bobby is started (with jin allowed to frame it) if it is not
 * running; when the running Bobby does not let jin frame it, the tab offers its own browser tab.
 */
export function BobbyTab({ pr }: { pr: string }) {
  const [state, setState] = useState<{ url: string; embeddable: boolean } | { error: string } | null>(null);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    setState(null);
    void bobbyEmbed(pr).then((r) => live && setState(r));
    return () => {
      live = false;
    };
  }, [pr, attempt]);

  if (!state)
    return (
      <div className="editor-empty">
        <ThermalMark size={24} state="working" /> Opening the review in Bobby…
      </div>
    );
  if ("error" in state)
    return (
      <div className="editor-empty">
        <p>{state.error}</p>
        <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
          <RotateCcw size={13} /> Try again
        </button>
      </div>
    );
  if (!state.embeddable)
    return (
      <div className="editor-empty">
        <p>This Bobby doesn&apos;t let jin show it inside a tab. Start Bobby with BOBBY_FRAME_ANCESTORS set to jin&apos;s address, or open the review in its own tab.</p>
        <button type="button" className="button" onClick={() => void window.open(state.url, "_blank", "noopener")}>
          <ExternalLink size={13} /> Open in Bobby
        </button>
      </div>
    );
  return <iframe className="bobby-frame" src={state.url} title={`Bobby review of ${pr}`} allow="clipboard-read; clipboard-write" />;
}
