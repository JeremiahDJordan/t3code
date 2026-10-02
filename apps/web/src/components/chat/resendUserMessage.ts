import {
  isAtomCommandInterrupted,
  runAtomCommand,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { OrchestrationMessage, ScopedThreadRef } from "@t3tools/contracts";
import { serializeLegacyContextMessage } from "@t3tools/shared/composerContextLegacySend";

import { newMessageId } from "../../lib/utils";
import { appAtomRegistry } from "../../rpc/atomRegistry";
import { readThreadShell } from "../../state/entities";
import { environmentServerConfigsAtom } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { toastManager } from "../ui/toast";

/**
 * Sends a user message's text and context again as a new turn with the thread's current model
 * and modes, for a turn its provider ended without replying. Its attachments are not sent again:
 * the provider already has them from the first time, as when the prompt is recalled and resent.
 * False when it was not sent, after saying why.
 */
export async function resendUserMessage(
  threadRef: ScopedThreadRef,
  message: Pick<OrchestrationMessage, "text" | "context">,
): Promise<boolean> {
  const { environmentId, threadId } = threadRef;
  const shell = readThreadShell(threadRef);
  if (!shell) return false;
  const { context } = message;
  // Servers from before inline context drop the records, so their turns carry them in the text.
  const inlineContext =
    appAtomRegistry.get(environmentServerConfigsAtom).get(environmentId)?.environment.capabilities
      .inlineMessageContext === true;
  const result = await runAtomCommand(
    appAtomRegistry,
    threadEnvironment.startTurn,
    {
      environmentId,
      input: {
        threadId,
        message: {
          messageId: newMessageId(),
          role: "user",
          text:
            context !== undefined && !inlineContext
              ? serializeLegacyContextMessage({ text: message.text, records: context.records })
              : message.text,
          attachments: [],
          ...(context !== undefined && inlineContext ? { context } : {}),
        },
        modelSelection: shell.modelSelection,
        runtimeMode: shell.runtimeMode,
        interactionMode: shell.interactionMode,
        createdAt: new Date().toISOString(),
      },
    },
    { reportFailure: false },
  );
  if (result._tag === "Failure") {
    if (!isAtomCommandInterrupted(result)) {
      const error = squashAtomCommandFailure(result);
      toastManager.add({
        type: "error",
        title: "Could not send the message again",
        description: error instanceof Error ? error.message : "Send it again from the composer.",
      });
    }
    return false;
  }
  return true;
}
