/**
 * Which machine a page is on is part of its URL: this machine's pages are plain (/t/<id>),
 * another machine's are under /m/<machine>/ (/m/<machine>/t/<id>). There is no "current
 * machine" to pick: open any task and the app talks to the machine it is on.
 */
export const machinePrefix = (machine: string) => (machine === "local" ? "" : `/m/${machine}`);

/** A task's page, on the machine it is on. */
export const taskHref = (machine: string, taskId: string) => `${machinePrefix(machine)}/t/${encodeURIComponent(taskId)}`;

/** The machine a browser path is on, and the path without the /m/<machine> prefix. */
export function splitPath(path: string): { machine: string; path: string } {
  const m = /^\/m\/([a-z0-9-]+)(\/.*)?$/.exec(path);
  return m ? { machine: m[1]!, path: m[2] || "/" } : { machine: "local", path };
}
