"use client";
import { Check, ChevronDown } from "lucide-react";
import { useEffect, useState } from "react";
import { modelChoices } from "@/app/actions";
import type { Effort, ModelChoices, RunChoice, Session } from "@/lib/daemon";
import { openContextMenu } from "./ContextMenu";

/**
 * The model and effort a chat runs with, picked in the composer. A chat keeps its own; a new
 * chat starts with the last one picked here (remembered in this browser), else jin's default.
 */

const FALLBACK: ModelChoices = {
  models: [
    { id: "claude-opus-5-5", label: "Opus 5.5" },
    { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
    { id: "claude-haiku-5-5", label: "Haiku 5.5" },
    { id: "claude-fable-5-1", label: "Fable 5.1" },
  ],
  efforts: ["low", "medium", "high", "xhigh", "max"],
  default: { model: "claude-opus-5-5" },
};
const EFFORT_LABEL: Record<Effort, string> = { low: "Low", medium: "Medium", high: "High", xhigh: "Extra high", max: "Max" };
const LAST = "jin.composer.choice";

let loaded: Promise<ModelChoices> | null = null;
const choices = () => (loaded ??= modelChoices().catch(() => ((loaded = null), FALLBACK)));

type Picked = { model?: string; effort?: Effort };
const remembered = (): Picked => {
  try {
    return JSON.parse(localStorage.getItem(LAST) ?? "{}") as Picked;
  } catch {
    return {};
  }
};
const remember = (c: Picked) => {
  try {
    localStorage.setItem(LAST, JSON.stringify(c));
  } catch {}
};

/** The choice for this chat, and the two buttons to change it. */
export function useModelChoice(session: Session | null) {
  const [list, setList] = useState<ModelChoices>(FALLBACK);
  const [choice, setChoice] = useState<Picked>({});

  useEffect(() => {
    void choices().then(setList);
  }, []);
  // An open chat shows what it runs with; a new one what was picked last.
  useEffect(() => {
    setChoice(session ? { model: session.model ?? undefined, effort: session.effort ?? undefined } : remembered());
  }, [session?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const pick = (c: Picked) => {
    const next = { ...choice, ...c };
    setChoice(next);
    remember(next);
  };
  const model = choice.model ?? list.default.model;
  const modelLabel = list.models.find((m) => m.id === model)?.label ?? model.replace(/^claude-/, "");

  const open = (e: React.MouseEvent<HTMLButtonElement>, items: { label: string; on: boolean; run: () => void }[]) => {
    const r = e.currentTarget.getBoundingClientRect();
    openContextMenu({ clientX: r.left, clientY: r.top - 4, preventDefault: () => e.preventDefault() }, items.map((i) => ({ label: i.label, icon: i.on ? Check : undefined, run: i.run })), { above: true });
  };

  const buttons = (
    <div className="model-picker">
      <button
        type="button"
        className="model-button"
        aria-label={`Model: ${modelLabel}`}
        onClick={(e) => open(e, list.models.map((m) => ({ label: m.label, on: m.id === model, run: () => pick({ model: m.id }) })))}
      >
        {modelLabel}
        <ChevronDown size={12} />
      </button>
      <button
        type="button"
        className="model-button"
        aria-label={`Effort: ${choice.effort ? EFFORT_LABEL[choice.effort] : "default"}`}
        onClick={(e) =>
          open(e, [
            { label: "Default", on: !choice.effort, run: () => pick({ effort: undefined }) },
            ...list.efforts.map((x) => ({ label: EFFORT_LABEL[x], on: x === choice.effort, run: () => pick({ effort: x }) })),
          ])
        }
      >
        {choice.effort ? EFFORT_LABEL[choice.effort] : "Default effort"}
        <ChevronDown size={12} />
      </button>
    </div>
  );

  // Sent with each message: the chat keeps it for the ones after.
  return { choice: { model, effort: choice.effort ?? "default" } satisfies RunChoice, buttons };
}
