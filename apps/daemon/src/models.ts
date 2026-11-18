import { HttpError } from "./http";

/** The Claude models and effort levels a chat can run with (picked in the composer). */
export const MODELS = [
  { id: "claude-opus-5-5", label: "Opus 5.5" },
  { id: "claude-sonnet-5-5", label: "Sonnet 5.5" },
  { id: "claude-haiku-5-5", label: "Haiku 5.5" },
  { id: "claude-fable-5-1", label: "Fable 5.1" },
] as const;

/** Effort levels, lowest first; a model that lacks one runs at the nearest it has. */
export const EFFORTS = ["low", "medium", "high", "xhigh", "max"] as const;
export type Effort = (typeof EFFORTS)[number];

/** A model and effort asked for with a message; unknown ones are refused, absent ones left as they are, effort "default" clears it. */
export function readChoice(b: { model?: unknown; effort?: unknown }): { model?: string; effort?: Effort | null } {
  const out: { model?: string; effort?: Effort | null } = {};
  if (b.model != null && b.model !== "") {
    if (typeof b.model !== "string" || !/^claude-[\w.-]+$/.test(b.model)) throw new HttpError(400, "model must be a Claude model id");
    out.model = b.model;
  }
  if (b.effort === "default") out.effort = null;
  else if (b.effort != null && b.effort !== "") {
    if (!EFFORTS.includes(b.effort as Effort)) throw new HttpError(400, `effort must be one of ${EFFORTS.join(", ")}`);
    out.effort = b.effort as Effort;
  }
  return out;
}
