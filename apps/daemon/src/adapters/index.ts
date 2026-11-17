import type { WorkspaceConfig } from "../config";
import { cwsProvider } from "./cws";
import { AdapterError, type WorkspaceAdapter, type WorkspaceProvider } from "./types";

/** The workspace providers jin knows. Adding a kind of workspace is adding one here. */
export const PROVIDERS: WorkspaceProvider[] = [cwsProvider];

/** Older configs name cws by its old name. */
const ALIASES: Record<string, string> = { composio: "cws" };
export const providerId = (id: string) => ALIASES[id] ?? id;

export function provider(id: string): WorkspaceProvider {
  const p = PROVIDERS.find((x) => x.id === providerId(id));
  if (!p) throw new AdapterError(`unknown workspace provider ${id} (known: ${PROVIDERS.map((x) => x.id).join(", ")})`);
  return p;
}

export function createAdapter(config: WorkspaceConfig): WorkspaceAdapter {
  return provider(config.adapter).create(config);
}

export * from "./types";
export * from "./detect";
