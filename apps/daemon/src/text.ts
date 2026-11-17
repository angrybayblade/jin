/**
 * One readable line from a message body: HTML comments and tags, markdown links, images,
 * code fences, checkboxes and escapes go; whitespace collapses; long text ends in an ellipsis.
 * Bots (review automations, CI) write a lot of markup that would otherwise show raw.
 */
export function oneLine(s: string, max = 200): string {
  const t = s
    // Slack: <@U123> is a person, <https://x|label> a link, <#C1|name> a channel.
    .replace(/<@([A-Z0-9_]+)>/g, "@$1")
    .replace(/<#[A-Z0-9]+\|([^>]+)>/g, "#$1")
    .replace(/<(https?:[^|>]+)\|([^>]+)>/g, "$2")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/g, " ")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(?:^|\s)(?:[-*]\s*)?\[[ xX]\](?=\s)/g, " ")
    .replace(/^\s*#{1,6}\s+/gm, "")
    .replace(/\\([`*_[\]()#>~|\\-])/g, "$1")
    .replace(/[`*]{1,3}/g, "")
    .replace(/\s+/g, " ")
    .trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}
