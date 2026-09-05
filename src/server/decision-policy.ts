import type { PromptDecisionMode } from "../shared/contracts.ts";

export type DecisionActivity = "proposal" | "vote" | "legacy";

export type DecisionPolicy = {
  soloMs: number;
  repeatWinnerMs: number;
  repeatWinnerSupportVotes: number;
  votingMs: number;
  newIdeaGraceMs: number;
};

function finiteMs(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value);
  return Math.max(minimum, Number.isFinite(parsed) ? parsed : fallback);
}

function finiteCount(value: unknown, fallback: number, minimum: number) {
  const parsed = Number(value);
  return Math.max(
    minimum,
    Math.floor(Number.isFinite(parsed) ? parsed : fallback),
  );
}

export function decisionPolicyFromEnv(): DecisionPolicy {
  const legacyVotingBase = process.env.PUMPTV_VOTING_BASE_MS;
  const legacyVotingGuarantee = process.env.PUMPTV_VOTING_GUARANTEE_MS;
  return {
    soloMs: finiteMs(process.env.PUMPTV_SOLO_DECISION_MS, 20_000, 5_000),
    repeatWinnerMs: finiteMs(
      process.env.PUMPTV_REPEAT_WINNER_SOLO_MS,
      60_000,
      20_000,
    ),
    repeatWinnerSupportVotes: finiteCount(
      process.env.PUMPTV_REPEAT_WINNER_SUPPORT_VOTES,
      2,
      1,
    ),
    votingMs: finiteMs(
      process.env.PUMPTV_VOTING_WINDOW_MS ?? legacyVotingBase,
      20_000,
      8_000,
    ),
    newIdeaGraceMs: finiteMs(
      process.env.PUMPTV_VOTING_NEW_IDEA_GRACE_MS ?? legacyVotingGuarantee,
      10_000,
      5_000,
    ),
  };
}

export function nextDecisionDeadline(input: {
  now: number;
  previousDeadline: number;
  mode: PromptDecisionMode;
  firstArm: boolean;
  enteringVoting: boolean;
  activity: DecisionActivity;
  supportVotes?: number;
  policy: DecisionPolicy;
}) {
  const {
    now,
    previousDeadline,
    mode,
    firstArm,
    enteringVoting,
    activity,
    supportVotes = 0,
    policy,
  } = input;

  if (firstArm) {
    if (mode === "voting") return now + policy.votingMs;
    if (mode === "repeat") return now + policy.repeatWinnerMs;
    return now + policy.soloMs;
  }

  if (enteringVoting) {
    // The first challenger starts a fresh, full ballot. The existing solo
    // countdown is a latency-hiding window, not time that should be stolen
    // from a real vote.
    return now + policy.votingMs;
  }

  if (
    mode === "repeat" &&
    activity === "vote" &&
    supportVotes >= policy.repeatWinnerSupportVotes
  ) {
    // A recent winner can earn another consecutive episode early, but only
    // after enough independent connected wallets explicitly support the idea.
    // The worker owns the actual lock/trigger; setting the deadline to `now`
    // simply makes the persisted round immediately eligible.
    return now;
  }

  if (mode === "voting" && activity === "proposal") {
    // A genuinely new candidate arriving late must remain votable for a small
    // grace period. This can extend the deadline, but only proposal admission
    // can do it; moving votes never changes the clock.
    return Math.max(previousDeadline, now + policy.newIdeaGraceMs);
  }

  // Once a ballot is open, votes are information, not a timer-control surface.
  // Keeping the deadline stable makes the UI predictable and prevents activity
  // from creating surprising "locking" jumps.
  return previousDeadline;
}
