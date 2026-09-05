import { describe, expect, test } from "bun:test";
import { nextDecisionDeadline } from "./decision-policy.ts";

const policy = {
  soloMs: 20_000,
  repeatWinnerMs: 60_000,
  repeatWinnerSupportVotes: 2,
  votingMs: 20_000,
  newIdeaGraceMs: 10_000,
};

describe("decision timer policy", () => {
  test("first solo idea gets twenty seconds", () => {
    expect(
      nextDecisionDeadline({
        now: 1_000,
        previousDeadline: 0,
        mode: "solo",
        firstArm: true,
        enteringVoting: false,
        activity: "proposal",
        policy,
      }),
    ).toBe(21_000);
  });

  test("immediately previous winner gets a longer solo fallback", () => {
    expect(
      nextDecisionDeadline({
        now: 1_000,
        previousDeadline: 0,
        mode: "repeat",
        firstArm: true,
        enteringVoting: false,
        activity: "proposal",
        policy,
      }),
    ).toBe(61_000);
  });

  test("one support vote does not let a repeat winner auto-fire early", () => {
    expect(
      nextDecisionDeadline({
        now: 12_000,
        previousDeadline: 61_000,
        mode: "repeat",
        firstArm: false,
        enteringVoting: false,
        activity: "vote",
        supportVotes: 1,
        policy,
      }),
    ).toBe(61_000);
  });

  test("enough independent support makes a repeat winner due immediately", () => {
    expect(
      nextDecisionDeadline({
        now: 12_000,
        previousDeadline: 61_000,
        mode: "repeat",
        firstArm: false,
        enteringVoting: false,
        activity: "vote",
        supportVotes: 2,
        policy,
      }),
    ).toBe(12_000);
  });

  test("a challenger still gives a repeat winner a fresh full ballot", () => {
    expect(
      nextDecisionDeadline({
        now: 15_000,
        previousDeadline: 61_000,
        mode: "voting",
        firstArm: false,
        enteringVoting: true,
        activity: "proposal",
        policy,
      }),
    ).toBe(35_000);
  });

  test("second independent idea starts a full voting window", () => {
    expect(
      nextDecisionDeadline({
        now: 16_000,
        previousDeadline: 21_000,
        mode: "voting",
        firstArm: false,
        enteringVoting: true,
        activity: "proposal",
        policy,
      }),
    ).toBe(36_000);
  });

  test("votes never shorten or extend the ballot", () => {
    expect(
      nextDecisionDeadline({
        now: 20_000,
        previousDeadline: 36_000,
        mode: "voting",
        firstArm: false,
        enteringVoting: false,
        activity: "vote",
        policy,
      }),
    ).toBe(36_000);
  });

  test("a late new candidate gets grace without shortening the ballot", () => {
    expect(
      nextDecisionDeadline({
        now: 31_000,
        previousDeadline: 36_000,
        mode: "voting",
        firstArm: false,
        enteringVoting: false,
        activity: "proposal",
        policy,
      }),
    ).toBe(41_000);
    expect(
      nextDecisionDeadline({
        now: 20_000,
        previousDeadline: 36_000,
        mode: "voting",
        firstArm: false,
        enteringVoting: false,
        activity: "proposal",
        policy,
      }),
    ).toBe(36_000);
  });
});
