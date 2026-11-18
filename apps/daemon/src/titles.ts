import { query } from "@anthropic-ai/claude-agent-sdk";

/** A short title for a chat from its first message. */
export type Titler = (prompt: string, env?: Record<string, string>) => Promise<string | null>;

export const TITLE_MODEL = "claude-haiku-5-5";

const INSTRUCTIONS =
  "Write a title for a chat that starts with the message below: 2 to 6 words, sentence case, no quotes, no trailing period, naming what it is about (not 'Request to…' or 'Help with…'). Reply with the title only.";

/** Tidy what the model wrote: one line, no quotes or label, a sensible length; null if nothing usable. */
export function cleanTitle(raw: string): string | null {
  const line = raw
    .split("\n")
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return null;
  const t = line
    .replace(/^(title|chat title)\s*:\s*/i, "")
    .replace(/^["'“‘`*]+|["'”’`*]+$/g, "")
    .replace(/\.$/, "")
    .trim();
  return t && t.length <= 80 ? t : null;
}

/** Claude Haiku names the chat: one turn, no tools, the machine's Claude login (or the workspace's profile). */
export const haikuTitle: Titler = async (prompt, env = {}) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    let text = "";
    const q = query({
      prompt: `${INSTRUCTIONS}\n\n<message>\n${prompt.slice(0, 4000)}\n</message>`,
      options: {
        model: TITLE_MODEL,
        maxTurns: 1,
        settingSources: [],
        allowedTools: [],
        canUseTool: async () => ({ behavior: "deny", message: "no tools for a title" }),
        env: { ...process.env, ...env } as Record<string, string>,
        abortController: controller,
      },
    });
    for await (const m of q) {
      if (m.type === "result" && m.subtype === "success") text = m.result;
    }
    return cleanTitle(text);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
};

/** Tests: a deterministic stand-in (the first words, capitalised). */
export const scriptedTitle: Titler = async (prompt) => {
  const words = prompt.replace(/[^\w\s'-]/g, " ").trim().split(/\s+/).slice(0, 4);
  return words.length ? `${words[0]!.charAt(0).toUpperCase()}${words[0]!.slice(1)} ${words.slice(1).join(" ")}`.trim() : null;
};
