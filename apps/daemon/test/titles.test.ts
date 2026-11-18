import { expect, test } from "bun:test";
import { cleanTitle, scriptedTitle } from "../src/titles";

test("a model's title is tidied to one short line, or dropped", () => {
  expect(cleanTitle("Review Sarah's rate limiting PR")).toBe("Review Sarah's rate limiting PR");
  expect(cleanTitle('Title: "Outdated task listing."\n\nextra')).toBe("Outdated task listing");
  expect(cleanTitle("\n  **Ligala's DM concerns**  ")).toBe("Ligala's DM concerns");
  expect(cleanTitle("")).toBeNull();
  expect(cleanTitle("x".repeat(120))).toBeNull();
});

test("the tests' stand-in titler names a chat from its first words", async () => {
  expect(await scriptedTitle("catch me up on everything today")).toBe("Catch me up on");
});
