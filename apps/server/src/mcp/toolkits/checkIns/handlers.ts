import type { ThreadCheckIn } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as CheckInScheduler from "../../../checkIns/CheckInScheduler.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { CheckInsToolkit } from "./tools.ts";

function summaryOf(checkIn: ThreadCheckIn) {
  return {
    checkInId: checkIn.id,
    note: checkIn.note,
    nextAt: checkIn.nextAt,
    repeatEveryMinutes: checkIn.repeatEveryMinutes,
    endsAt: checkIn.endsAt,
    waitingForIdle: checkIn.dueSince !== null,
  };
}

const make = Effect.gen(function* () {
  const scheduler = yield* CheckInScheduler.CheckInScheduler;
  const scope = McpInvocationContext.requireMcpCapability("check-ins");

  return CheckInsToolkit.of({
    schedule_check_in: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const checkIn = yield* scheduler.schedule({
          threadId,
          note: input.note,
          inMinutes: input.inMinutes,
          repeatEveryMinutes: input.repeatEveryMinutes ?? null,
        });
        return summaryOf(checkIn);
      }),
    list_scheduled: () =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        const checkIns = yield* scheduler.list(threadId);
        return { checkIns: checkIns.map(summaryOf) };
      }),
    cancel_check_in: (input) =>
      Effect.gen(function* () {
        const { threadId } = yield* scope;
        // An agent may cancel only its own thread's check-ins.
        const cancelled = yield* scheduler.cancel(input.checkInId, threadId);
        return { cancelled };
      }),
  });
});

export const CheckInsToolkitHandlersLive = CheckInsToolkit.toLayer(make);
