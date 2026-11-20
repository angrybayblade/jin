import { expect, test } from "bun:test";
import { ChatSkills, skillContext, skillRefs } from "../src/chat-skills";

const known = [
  { name: "brief-me", description: "Brief the user visually", argumentHint: "" },
  { name: "review-platform", description: "Review a platform change", argumentHint: "--task <ID>" },
  { name: "launchdarkly:flag-create", description: "Create a flag", argumentHint: "" },
];

test("/skills are read from a message: after a space or at the start; not paths or URLs", () => {
  expect(skillRefs("/brief-me on PLEN-1, then /review-platform. see /Users/me/x and https://a.b/c")).toEqual(["brief-me", "review-platform"]);
  expect(skillRefs("use /launchdarkly:flag-create: now")).toEqual(["launchdarkly:flag-create"]);
  expect(skillRefs("a/b and src/thing")).toEqual([]);
});

test("a skill named first runs as Claude Code runs it; ones named later are told to the agent; unknown ones are text", () => {
  const lead = skillContext("/review-platform --task PLEN-1", known);
  expect(lead.used.map((s) => s.name)).toEqual(["review-platform"]);
  expect(lead.context).toBe("");
  const later = skillContext("look at PLEN-1 then /brief-me and /nope", known);
  expect(later.used.map((s) => s.name)).toEqual(["brief-me"]);
  expect(later.context).toBe("\n\n(The user named this skill: /brief-me (Brief the user visually). Run it with the Skill tool as part of this request.)");
  expect(skillContext("/Brief-Me then /launchdarkly:flag-create", known).context).toContain("/launchdarkly:flag-create (Create a flag)");
});

test("the list leaves out Claude Code's own commands and is cached per folder", async () => {
  let probes = 0;
  const s = new ChatSkills(async () => (probes++, [{ name: "clear", description: "", argumentHint: "", builtin: true }, { name: "zeta", description: "z", argumentHint: "" }, { name: "alpha", description: "a", argumentHint: "" }]));
  expect((await s.list("/ws")).map((x) => x.name)).toEqual(["alpha", "zeta"]);
  await s.list("/ws");
  expect(probes).toBe(1);
  await s.list("/ws", {}, true);
  await s.list("/other");
  expect(probes).toBe(3);
});
