import { randomUUID } from "node:crypto";

import {
  db,
  type PumpLaunchBuyerDbRow,
  type PumpLaunchSessionDbRow,
} from "./db.js";

function cleanSessionId(value: string): string {
  const sessionId = String(value ?? "").trim();

  if (!sessionId) {
    throw new Error("Launch session ID is empty.");
  }

  if (!/^[A-Za-z0-9._-]{1,96}$/.test(sessionId)) {
    throw new Error(
      "Launch session ID may contain only letters, numbers, dot, underscore, and dash.",
    );
  }

  return sessionId;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolvePromise) => setTimeout(resolvePromise, ms));
}

export function getPumpLaunchSession(
  sessionId: string,
): PumpLaunchSessionDbRow | null {
  return db.pumpLaunchSessionsV1
    .select()
    .where({
      sessionId: cleanSessionId(sessionId),
    })
    .get() as PumpLaunchSessionDbRow | null;
}

export function requirePumpLaunchSession(
  sessionId: string,
): PumpLaunchSessionDbRow {
  const session = getPumpLaunchSession(sessionId);

  if (!session) {
    throw new Error(`Pump launch session not found: ${sessionId}`);
  }

  return session;
}

function mergeManifest(row: PumpLaunchSessionDbRow): PumpLaunchSessionDbRow {
  return db.pumpLaunchSessionsV1.upsert(row, {
    on: "sessionId",

    merge: (table) => ({
      status: table.excluded("status"),

      buyerStatus: table.excluded("buyerStatus"),

      deploymentStatus: table.excluded("deploymentStatus"),

      mint: table.excluded("mint"),

      creator: table.excluded("creator"),

      mintKeypairPath: table.excluded("mintKeypairPath"),

      metadataUri: table.excluded("metadataUri"),

      tokenJson: table.excluded("tokenJson"),

      buyPlanJson: table.excluded("buyPlanJson"),

      buyerArgvJson: table.excluded("buyerArgvJson"),

      deployArgvJson: table.excluded("deployArgvJson"),

      fireToken: table.excluded("fireToken"),

      fireAcknowledgedToken: table.excluded("fireAcknowledgedToken"),

      abortReason: table.excluded("abortReason"),

      deploymentSignature: table.excluded("deploymentSignature"),

      armedPid: table.excluded("armedPid"),

      armedAtMs: table.excluded("armedAtMs"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),

      fireRequestedAtMs: table.excluded("fireRequestedAtMs"),

      fireAcknowledgedAtMs: table.excluded("fireAcknowledgedAtMs"),

      deploymentBroadcastAtMs: table.excluded("deploymentBroadcastAtMs"),

      completedAtMs: table.excluded("completedAtMs"),

      createdAtMs: table.keepFirst("createdAtMs"),

      updatedAtMs: table.excluded("updatedAtMs"),
    }),
  }) as PumpLaunchSessionDbRow;
}

export function writePumpLaunchManifest(input: {
  sessionId: string;
  mint: string;
  creator: string;
  mintKeypairPath: string;
  metadataUri: string;
  tokenJson: string;
  buyPlanJson: string;
  buyerArgvJson: string;
  deployArgvJson: string;
  force?: boolean;
}): PumpLaunchSessionDbRow {
  const sessionId = cleanSessionId(input.sessionId);

  const existing = getPumpLaunchSession(sessionId);

  if (existing && !input.force) {
    throw new Error(
      `Pump launch session ${sessionId} already exists. Pass --force to replace its manifest.`,
    );
  }

  const now = Date.now();

  const row: PumpLaunchSessionDbRow = {
    sessionId,

    status: "prepared",

    buyerStatus: "idle",

    deploymentStatus: "pending",

    mint: input.mint,

    creator: input.creator,

    mintKeypairPath: input.mintKeypairPath,

    metadataUri: input.metadataUri,

    tokenJson: input.tokenJson,

    buyPlanJson: input.buyPlanJson,

    buyerArgvJson: input.buyerArgvJson,

    deployArgvJson: input.deployArgvJson,

    fireToken: null,

    fireAcknowledgedToken: null,

    abortReason: null,

    deploymentSignature: null,

    armedPid: 0,

    armedAtMs: 0,

    heartbeatAtMs: 0,

    fireRequestedAtMs: 0,

    fireAcknowledgedAtMs: 0,

    deploymentBroadcastAtMs: 0,

    completedAtMs: 0,

    createdAtMs: existing?.createdAtMs ?? now,

    updatedAtMs: now,
  };

  if (!existing) {
    return db.pumpLaunchSessionsV1.insert(row) as PumpLaunchSessionDbRow;
  }

  return mergeManifest(row);
}

function updateSessionFields(
  sessionId: string,
  changes: Partial<PumpLaunchSessionDbRow>,
  merge: (table: any) => Record<string, unknown>,
): PumpLaunchSessionDbRow {
  const current = requirePumpLaunchSession(sessionId);

  const row: PumpLaunchSessionDbRow = {
    ...current,
    ...changes,
    sessionId: current.sessionId,
    updatedAtMs: Date.now(),
  };

  return db.pumpLaunchSessionsV1.upsert(row, {
    on: "sessionId",

    merge: (table) => ({
      ...merge(table),

      updatedAtMs: table.excluded("updatedAtMs"),
    }),
  }) as PumpLaunchSessionDbRow;
}

export function markPumpLaunchArming(
  sessionId: string,
): PumpLaunchSessionDbRow {
  return updateSessionFields(
    sessionId,
    {
      status: "arming",

      buyerStatus: "arming",

      armedPid: process.pid,

      heartbeatAtMs: Date.now(),

      abortReason: null,
    },
    (table) => ({
      status: table.excluded("status"),

      buyerStatus: table.excluded("buyerStatus"),

      armedPid: table.excluded("armedPid"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),

      abortReason: table.excluded("abortReason"),
    }),
  );
}

export function markPumpLaunchArmed(sessionId: string): PumpLaunchSessionDbRow {
  const now = Date.now();

  return updateSessionFields(
    sessionId,
    {
      status: "armed",

      buyerStatus: "armed",

      armedPid: process.pid,

      armedAtMs: now,

      heartbeatAtMs: now,

      fireToken: null,

      fireAcknowledgedToken: null,

      abortReason: null,
    },
    (table) => ({
      status: table.excluded("status"),

      buyerStatus: table.excluded("buyerStatus"),

      armedPid: table.excluded("armedPid"),

      armedAtMs: table.excluded("armedAtMs"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),

      fireToken: table.excluded("fireToken"),

      fireAcknowledgedToken: table.excluded("fireAcknowledgedToken"),

      abortReason: table.excluded("abortReason"),
    }),
  );
}

export function heartbeatPumpLaunchArm(
  sessionId: string,
): PumpLaunchSessionDbRow {
  return updateSessionFields(
    sessionId,
    {
      armedPid: process.pid,

      heartbeatAtMs: Date.now(),
    },
    (table) => ({
      armedPid: table.excluded("armedPid"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),
    }),
  );
}

export function requestPumpLaunchFire(
  sessionId: string,
  expectedMint: string,
): {
  session: PumpLaunchSessionDbRow;

  fireToken: string;
} {
  const current = requirePumpLaunchSession(sessionId);

  if (current.mint !== expectedMint) {
    throw new Error(
      `Session ${sessionId} expects mint ${current.mint}, not ${expectedMint}.`,
    );
  }

  if (current.buyerStatus !== "armed") {
    throw new Error(
      `Session ${sessionId} buyers are ${current.buyerStatus}, not armed.`,
    );
  }

  const fireToken = randomUUID();

  const session = updateSessionFields(
    sessionId,
    {
      status: "fire-requested",

      fireToken,

      fireAcknowledgedToken: null,

      fireRequestedAtMs: Date.now(),

      abortReason: null,
    },
    (table) => ({
      status: table.excluded("status"),

      fireToken: table.excluded("fireToken"),

      fireAcknowledgedToken: table.excluded("fireAcknowledgedToken"),

      fireRequestedAtMs: table.excluded("fireRequestedAtMs"),

      abortReason: table.excluded("abortReason"),
    }),
  );

  return {
    session,
    fireToken,
  };
}

export function acknowledgePumpLaunchFire(
  sessionId: string,
  fireToken: string,
): PumpLaunchSessionDbRow {
  const current = requirePumpLaunchSession(sessionId);

  if (current.fireToken !== fireToken) {
    throw new Error(
      `Session ${sessionId} fire token changed before acknowledgement.`,
    );
  }

  return updateSessionFields(
    sessionId,
    {
      status: "firing",

      buyerStatus: "firing",

      fireAcknowledgedToken: fireToken,

      fireAcknowledgedAtMs: Date.now(),

      heartbeatAtMs: Date.now(),
    },
    (table) => ({
      status: table.excluded("status"),

      buyerStatus: table.excluded("buyerStatus"),

      fireAcknowledgedToken: table.excluded("fireAcknowledgedToken"),

      fireAcknowledgedAtMs: table.excluded("fireAcknowledgedAtMs"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),
    }),
  );
}

export async function waitForPumpLaunchFire(
  sessionId: string,
  input: {
    pollMs?: number;
    signal?: AbortSignal;
  } = {},
): Promise<string> {
  const pollMs = Math.max(5, Math.trunc(input.pollMs ?? 15));

  while (!input.signal?.aborted) {
    const session = requirePumpLaunchSession(sessionId);

    if (
      session.status === "abort-requested" ||
      session.buyerStatus === "abort-requested"
    ) {
      throw new Error(
        session.abortReason || `Session ${sessionId} was aborted.`,
      );
    }

    if (
      session.fireToken &&
      session.fireToken !== session.fireAcknowledgedToken
    ) {
      return session.fireToken;
    }

    await sleep(pollMs);
  }

  throw new Error(`Session ${sessionId} arm process was aborted.`);
}

export async function waitForPumpLaunchFireAcknowledged(
  sessionId: string,
  fireToken: string,
  input: {
    timeoutMs?: number;
    pollMs?: number;
  } = {},
): Promise<PumpLaunchSessionDbRow> {
  const timeoutMs = Math.max(1, Math.trunc(input.timeoutMs ?? 500));

  const pollMs = Math.max(2, Math.trunc(input.pollMs ?? 5));

  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const session = requirePumpLaunchSession(sessionId);

    if (session.fireAcknowledgedToken === fireToken) {
      return session;
    }

    if (session.status === "abort-requested") {
      throw new Error(
        session.abortReason ||
          `Session ${sessionId} was aborted before FIRE acknowledgement.`,
      );
    }

    await sleep(pollMs);
  }

  throw new Error(
    `Session ${sessionId} did not acknowledge FIRE within ${timeoutMs}ms.`,
  );
}

export function markPumpDeploymentBroadcast(
  sessionId: string,
  signature: string,
): PumpLaunchSessionDbRow {
  return updateSessionFields(
    sessionId,
    {
      status: "deployment-broadcast",

      deploymentStatus: "broadcast",

      deploymentSignature: signature,

      deploymentBroadcastAtMs: Date.now(),
    },
    (table) => ({
      status: table.excluded("status"),

      deploymentStatus: table.excluded("deploymentStatus"),

      deploymentSignature: table.excluded("deploymentSignature"),

      deploymentBroadcastAtMs: table.excluded("deploymentBroadcastAtMs"),
    }),
  );
}

export function markPumpDeploymentConfirmed(
  sessionId: string,
  signature: string,
): PumpLaunchSessionDbRow {
  return updateSessionFields(
    sessionId,
    {
      deploymentStatus: "confirmed",

      deploymentSignature: signature,

      completedAtMs: Date.now(),
    },
    (table) => ({
      deploymentStatus: table.excluded("deploymentStatus"),

      deploymentSignature: table.excluded("deploymentSignature"),

      completedAtMs: table.excluded("completedAtMs"),
    }),
  );
}

export function requestPumpLaunchAbort(
  sessionId: string,
  reason: string,
): PumpLaunchSessionDbRow {
  return updateSessionFields(
    sessionId,
    {
      status: "abort-requested",

      buyerStatus: "abort-requested",

      deploymentStatus: "failed",

      abortReason: reason,
    },
    (table) => ({
      status: table.excluded("status"),

      buyerStatus: table.excluded("buyerStatus"),

      deploymentStatus: table.excluded("deploymentStatus"),

      abortReason: table.excluded("abortReason"),
    }),
  );
}

export function markPumpBuyerSessionComplete(
  sessionId: string,
  failed: number,
): PumpLaunchSessionDbRow {
  return updateSessionFields(
    sessionId,
    {
      buyerStatus: failed > 0 ? "partial-failure" : "completed",

      completedAtMs: Date.now(),
    },
    (table) => ({
      buyerStatus: table.excluded("buyerStatus"),

      completedAtMs: table.excluded("completedAtMs"),
    }),
  );
}

export function upsertPumpLaunchBuyer(
  input: Omit<PumpLaunchBuyerDbRow, "createdAtMs" | "updatedAtMs">,
): PumpLaunchBuyerDbRow {
  const existing = db.pumpLaunchBuyersV1
    .select()
    .where({
      buyerKey: input.buyerKey,
    })
    .get() as PumpLaunchBuyerDbRow | null;

  const now = Date.now();

  const row: PumpLaunchBuyerDbRow = {
    ...input,

    createdAtMs: existing?.createdAtMs ?? now,

    updatedAtMs: now,
  };

  return db.pumpLaunchBuyersV1.upsert(row, {
    on: "buyerKey",

    merge: (table) => ({
      sessionId: table.excluded("sessionId"),

      walletRef: table.excluded("walletRef"),

      address: table.excluded("address"),

      label: table.excluded("label"),

      selectedBps: table.excluded("selectedBps"),

      spendLamports: table.excluded("spendLamports"),

      reserveLamports: table.excluded("reserveLamports"),

      sender: table.excluded("sender"),

      strategy: table.excluded("strategy"),

      configJson: table.excluded("configJson"),

      status: table.excluded("status"),

      resultJson: table.excluded("resultJson"),

      error: table.excluded("error"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),

      createdAtMs: table.keepFirst("createdAtMs"),

      updatedAtMs: table.excluded("updatedAtMs"),
    }),
  }) as PumpLaunchBuyerDbRow;
}

export function setPumpLaunchBuyerResult(
  buyerKey: string,
  input: {
    status: string;
    resultJson?: string | null;
    error?: string | null;
  },
): PumpLaunchBuyerDbRow {
  const current = db.pumpLaunchBuyersV1
    .select()
    .where({
      buyerKey,
    })
    .get() as PumpLaunchBuyerDbRow | null;

  if (!current) {
    throw new Error(`Pump launch buyer not found: ${buyerKey}`);
  }

  const row: PumpLaunchBuyerDbRow = {
    ...current,

    status: input.status,

    resultJson: input.resultJson ?? null,

    error: input.error ?? null,

    heartbeatAtMs: Date.now(),

    updatedAtMs: Date.now(),
  };

  return db.pumpLaunchBuyersV1.upsert(row, {
    on: "buyerKey",

    merge: (table) => ({
      status: table.excluded("status"),

      resultJson: table.excluded("resultJson"),

      error: table.excluded("error"),

      heartbeatAtMs: table.excluded("heartbeatAtMs"),

      updatedAtMs: table.excluded("updatedAtMs"),
    }),
  }) as PumpLaunchBuyerDbRow;
}

export function listPumpLaunchBuyers(
  sessionId: string,
): PumpLaunchBuyerDbRow[] {
  return db.pumpLaunchBuyersV1
    .select()
    .where({
      sessionId: cleanSessionId(sessionId),
    })
    .orderBy("createdAtMs", "ASC")
    .all() as PumpLaunchBuyerDbRow[];
}

export function watchPumpLaunchAbort(
  sessionId: string,
  controller: AbortController,
  pollMs = 20,
): () => void {
  let stopped = false;

  const run = async () => {
    while (!stopped && !controller.signal.aborted) {
      const session = requirePumpLaunchSession(sessionId);

      if (
        session.status === "abort-requested" ||
        session.buyerStatus === "abort-requested"
      ) {
        controller.abort(session.abortReason ?? "deployment aborted");

        return;
      }

      await sleep(Math.max(5, pollMs));
    }
  };

  void run();

  return () => {
    stopped = true;
  };
}
