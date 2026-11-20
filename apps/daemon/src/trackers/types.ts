/**
 * The issue tracker contract: what jin needs from wherever a workspace's tasks get their issues
 * (Linear, GitHub Issues, …). jin's core knows nothing about any particular tracker: links,
 * @mentions, a new task's title and the agents' instructions all ask the workspace's tracker.
 *
 * A tracker's id is also the prefix of its issues' keys ("linear:ENG-12"), which is how a task's
 * issue matches the events that arrive about it.
 */
export interface IssueTracker {
  /** Its name in a workspace's config (`tracker: <id>`), and its keys' prefix. */
  readonly id: string;
  /** "Linear". */
  readonly label: string;
  /** What one issue is called in a sentence: "Linear issue". */
  readonly noun: string;
  /** What an id looks like, for a form's hint: "ENG-123". */
  readonly idHint: string;
  /** The id written in `text` ("eng-123" → "ENG-123"), or null when it is not one of this tracker's. */
  parseId(text: string): string | null;
  /** An issue's page → its id, or null when the URL is not one of this tracker's issues. */
  parseUrl(url: URL): string | null;
  /** The issue's page, when the tracker can say (Linear needs its workspace's slug: learned, see `learn`). */
  urlOf(id: string): string | null;
  /** A link seen anywhere (in the feed, a chat): what it teaches the tracker. */
  learn?(url: string): void;
  /** The issue as it is now, when the tracker can be reached; null when it is not found. */
  lookup?(id: string): Promise<IssueDetails | null>;
  /** For an agent: how to read the issue (its instructions name it). */
  howToRead(id: string): string;
  /** For an agent closing a task's issue (the "all PRs merged" hook): how to mark it done and say why. */
  howToClose: string;
}

export interface IssueDetails {
  title: string;
  url?: string | null;
  /** Its workflow state: "In Progress", "open". */
  state: string | null;
  assignee: string | null;
  /** Where it lives: a Linear team, a GitHub repo. */
  team: string | null;
}

/** What the app shows of a tracker (forms, labels). */
export interface TrackerView {
  id: string;
  label: string;
  noun: string;
  idHint: string;
}

export const trackerView = (t: IssueTracker): TrackerView => ({ id: t.id, label: t.label, noun: t.noun, idHint: t.idHint });
