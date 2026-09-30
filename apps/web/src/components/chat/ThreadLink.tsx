import type { ScopedThreadRef } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import type { ReactNode } from "react";

import { useEnvironmentPresentation } from "../../state/presentation";
import { buildThreadRouteParams } from "../../threadRoutes";

/**
 * Another thread named inline, such as the one a check-in waits on or the one that sent a
 * message: a link to it while its environment is connected, and plain text otherwise.
 */
export function ThreadLink({ thread, children }: { thread: ScopedThreadRef; children: ReactNode }) {
  const { presentation } = useEnvironmentPresentation(thread.environmentId);
  if (presentation?.connection.phase !== "connected") return <>{children}</>;
  return (
    <Link
      to="/$environmentId/$threadId"
      params={buildThreadRouteParams(thread)}
      className="underline decoration-dotted underline-offset-2 hover:decoration-solid focus-visible:decoration-solid"
    >
      {children}
    </Link>
  );
}
