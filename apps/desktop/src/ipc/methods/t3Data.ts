import { DesktopT3DataStateSchema } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopT3Data from "../../app/DesktopT3Data.ts";
import * as IpcChannels from "../channels.ts";
import { makeIpcMethod } from "../DesktopIpc.ts";

export const getT3DataState = makeIpcMethod({
  channel: IpcChannels.T3_DATA_GET_STATE_CHANNEL,
  payload: Schema.Void,
  result: DesktopT3DataStateSchema,
  handler: Effect.fn("desktop.ipc.t3Data.getState")(function* () {
    return yield* (yield* DesktopT3Data.DesktopT3Data).state;
  }),
});

export const removeT3Data = makeIpcMethod({
  channel: IpcChannels.T3_DATA_REMOVE_CHANNEL,
  payload: Schema.Void,
  result: DesktopT3DataStateSchema,
  handler: Effect.fn("desktop.ipc.t3Data.remove")(function* () {
    return yield* (yield* DesktopT3Data.DesktopT3Data).remove;
  }),
});
