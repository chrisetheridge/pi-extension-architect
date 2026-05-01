import { describe, expect, it } from "vitest";
import {
  buildPlanPath,
  parseArchitectCommandArgs,
  fallbackArchitectureOptions,
  heuristicClassify,
  buildArchitectEntryReason,
  normalizeConfig,
  parseArchitectureOptions,
  parseTaskType,
  shouldEnterArchitectMode,
  slugifyPlanName,
} from "../src/core.js";
import { buildProgressDots, centerBox, clampContentWidth } from "../src/ui-format.js";

describe("core helpers", () => {
  it("parses classifier JSON and fenced JSON", () => {
    expect(parseTaskType('{"taskType":"architectural"}')).toBe("architectural");
    expect(parseTaskType("```json\n{\"type\":\"trivial\"}\n```")).toBe("trivial");
  });

  it("falls back to keyword classification", () => {
    expect(heuristicClassify("Design a scalable task management system")).toBe("architectural");
    expect(heuristicClassify("Fix typo in README")).toBe("trivial");
    expect(heuristicClassify("Implement a button")).toBe("implementation");
  });

  it("honors ambiguous trigger config", () => {
    expect(shouldEnterArchitectMode("ambiguous", normalizeConfig({ autoTriggerAmbiguous: false }))).toBe(false);
    expect(shouldEnterArchitectMode("ambiguous", normalizeConfig({ autoTriggerAmbiguous: true }))).toBe(true);
  });

  it("parses architecture options from JSON", () => {
    const options = parseArchitectureOptions(`{
      "options": [
        {"id":"a","title":"Option A","summary":"simple","details":"simple details"},
        {"title":"Option B","summary":"scalable","details":"scalable details"}
      ]
    }`);

    expect(options).toHaveLength(2);
    expect(options[1]?.id).toBe("option-2");
  });

  it("generates stable plan paths", () => {
    expect(slugifyPlanName("Build: An Architect Mode Extension!")).toBe("build-an-architect-mode-extension");
    expect(buildPlanPath("/repo", "Build thing", new Date("2026-05-01T12:00:00Z"))).toBe(
      "/repo/.pi/architect/PLAN-build-thing-2026-05-01.md",
    );
  });

  it("has fallback options", () => {
    expect(fallbackArchitectureOptions().length).toBeGreaterThanOrEqual(2);
  });

  it("describes why architect mode opened", () => {
    expect(buildArchitectEntryReason("architectural", "automatic")).toContain("architectural");
    expect(buildArchitectEntryReason("implementation", "manual")).toContain("manually");
  });

  it("parses architect command toggles", () => {
    expect(parseArchitectCommandArgs("disable")).toBe("disable");
    expect(parseArchitectCommandArgs("off")).toBe("disable");
    expect(parseArchitectCommandArgs("enable")).toBe("enable");
    expect(parseArchitectCommandArgs("Build the login flow")).toBe("start");
  });

  it("formats bordered card layout helpers", () => {
    expect(buildProgressDots(4, 1, new Set([0]))).toEqual(["●", "●", "○", "○"]);
    expect(clampContentWidth(120)).toBe(96);
    expect(clampContentWidth(40)).toBe(36);
    expect(centerBox(20, 10)).toBe("     ");
  });
});
