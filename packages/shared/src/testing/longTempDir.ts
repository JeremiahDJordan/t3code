// @effect-diagnostics nodeBuiltinImport:off - runs once at test setup, outside any Effect runtime.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import { HostProcessPlatform } from "../hostProcess.ts";

// Tests compare temp paths with what git or realpath report, which is the canonical form, so
// the temp directory itself must be canonical. GitHub's Windows runners hand it out by its 8.3
// short name (C:\Users\RUNNER~1\...), and macOS under /var, a link to /private/var. Node reads
// TEMP/TMP (Windows) or TMPDIR on every os.tmpdir() call, so pointing them at the canonical
// form fixes every temp directory the suite makes.
try {
  const canonical = NodeFS.realpathSync.native(NodeOS.tmpdir());
  if (HostProcessPlatform.defaultValue() === "win32") {
    process.env.TEMP = canonical;
    process.env.TMP = canonical;
  } else {
    process.env.TMPDIR = canonical;
  }
} catch {
  // Leave the host's value alone if it cannot be resolved.
}
