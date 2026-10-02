import { createCheckInEnvironmentAtoms } from "@t3tools/client-runtime/state/checkIns";

import { connectionAtomRuntime } from "../connection/runtime";

export const checkInEnvironment = createCheckInEnvironmentAtoms(connectionAtomRuntime);
