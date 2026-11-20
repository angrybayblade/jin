import type { IssueDetails, IssueTracker } from "./types";

/** GitHub Issues: ids like owner/repo#123 (or repo#123 within the workspace's owners), read with gh. */
export function githubTracker(deps: { owners: () => string[]; lookup?: (id: string) => Promise<IssueDetails | null> }): IssueTracker {
  const ID = /^(?:([\w.-]+)\/)?([\w.-]+)#(\d+)$/;
  const full = (text: string): string | null => {
    const m = ID.exec(text.trim());
    if (!m) return null;
    const owner = m[1] ?? deps.owners()[0];
    return owner ? `${owner}/${m[2]}#${m[3]}`.toLowerCase() : null;
  };
  return {
    id: "github",
    label: "GitHub Issues",
    noun: "GitHub issue",
    idHint: "repo#123",
    parseId: full,
    parseUrl: (u) => {
      const m = u.hostname === "github.com" ? /^\/([\w.-]+)\/([\w.-]+)\/issues\/(\d+)/.exec(u.pathname) : null;
      return m ? `${m[1]}/${m[2]}#${m[3]}`.toLowerCase() : null;
    },
    urlOf: (id) => {
      const m = /^([\w.-]+)\/([\w.-]+)#(\d+)$/.exec(id);
      return m ? `https://github.com/${m[1]}/${m[2]}/issues/${m[3]}` : null;
    },
    lookup: deps.lookup,
    howToRead: (id) => `gh: \`gh issue view ${id.replace(/^([^#]+)#(\d+)$/, "$2 -R $1")} --comments\``,
    howToClose: "with gh: if the issue is open, close it with a one-line comment linking the merged pull requests (`gh issue close <n> -R <owner/repo> -c …`)",
  };
}
