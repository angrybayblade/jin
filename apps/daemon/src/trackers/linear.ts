import type { IssueDetails, IssueTracker } from "./types";

/** Linear: ids like ENG-123, pages at linear.app/<workspace>/issue/ENG-123. */
export function linearTracker(deps: { lookup?: (id: string) => Promise<IssueDetails | null> } = {}): IssueTracker {
  // The workspace's slug, learned from any Linear link jin sees (an issue's page needs it).
  let org: string | null = null;
  const ID = /^([A-Za-z][A-Za-z0-9]*-\d+)$/;
  return {
    id: "linear",
    label: "Linear",
    noun: "Linear issue",
    idHint: "ENG-123",
    parseId: (text) => ID.exec(text.trim())?.[1]?.toUpperCase() ?? null,
    parseUrl: (u) => (u.hostname === "linear.app" ? (/\/issue\/([A-Z][A-Z0-9]*-\d+)/i.exec(u.pathname)?.[1]?.toUpperCase() ?? null) : null),
    urlOf: (id) => (org ? `https://linear.app/${org}/issue/${id}` : null),
    learn: (url) => {
      org ??= /linear\.app\/([\w-]+)\/issue\//.exec(url)?.[1] ?? null;
    },
    lookup: deps.lookup,
    howToRead: (id) => `the Linear tools: the issue ${id} and its comments`,
    howToClose: "with the Linear tools: if the issue is not Done, Completed or Canceled, move it to Done and add a one-line comment linking the merged pull requests",
  };
}
