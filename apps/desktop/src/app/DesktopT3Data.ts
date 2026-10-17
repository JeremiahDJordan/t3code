// @effect-diagnostics nodeBuiltinImport:off - The first-start copy runs before Electron is ready or any runtime exists.
/**
 * Z6 Code's own data folders, copied from T3 Code's on the first start
 * (`@t3tools/shared/t3DataMigration`), and the user's way to remove T3's afterwards.
 */
import type { DesktopT3DataState } from "@t3tools/contracts";
import {
  type T3DataPaths,
  markT3CleanupPromptAnswered,
  readT3DataState,
  removeT3Data,
} from "@t3tools/shared/t3DataCleanup";
import {
  T3_DESKTOP_USER_DATA_DIRNAME,
  Z6_DESKTOP_USER_DATA_DIRNAME,
  defaultT3Home,
  defaultZ6Home,
  migrateDesktopUserDataFromT3,
  migrateHomeFromT3,
} from "@t3tools/shared/t3DataMigration";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Electron from "electron";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopEnvironment from "./DesktopEnvironment.ts";
import { makeComponentLogger } from "./DesktopObservability.ts";

const { logInfo, logWarning } = makeComponentLogger("desktop-t3-data");

/**
 * Copy T3 Code's home and Electron profile to Z6's missing ones, before anything reads them.
 * Called first thing in `main.ts`. A T3 Code still running blocks the copy, so Z6 quits with an
 * explanation rather than start empty and never copy.
 */
export function migrateOnFirstStart(): void {
  // Development keeps its own state, as before.
  if (process.env.VITE_DEV_SERVER_URL?.trim()) return;
  try {
    const homeDirectory = NodeOS.homedir();
    if (!process.env.T3CODE_HOME?.trim()) {
      migrateHomeFromT3({
        t3Home: defaultT3Home(homeDirectory),
        z6Home: defaultZ6Home(homeDirectory),
      });
    }
    const appData = Electron.app.getPath("appData");
    migrateDesktopUserDataFromT3({
      t3UserData: NodePath.join(appData, T3_DESKTOP_USER_DATA_DIRNAME),
      z6UserData: NodePath.join(appData, Z6_DESKTOP_USER_DATA_DIRNAME),
    });
  } catch (error) {
    Electron.dialog.showErrorBox(
      "Z6 Code could not copy T3 Code's data",
      error instanceof Error ? error.message : String(error),
    );
    Electron.app.exit(1);
  }
}

export class DesktopT3Data extends Context.Service<
  DesktopT3Data,
  {
    readonly state: Effect.Effect<DesktopT3DataState>;
    /** Asks first, moves T3's folders to the Trash, and shows what it removed and kept. */
    readonly remove: Effect.Effect<DesktopT3DataState>;
    /** Once, after the first start that copied T3's data: Keep, or remove it now. */
    readonly promptAfterMigration: Effect.Effect<void>;
  }
>()("@t3tools/desktop/app/DesktopT3Data") {}

const describeKind = (kind: "home" | "desktop-user-data") =>
  kind === "home" ? "projects, threads and settings" : "app profile";

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const environment = yield* DesktopEnvironment.DesktopEnvironment;
  const dialog = yield* ElectronDialog.ElectronDialog;
  const path = environment.path;
  const paths: T3DataPaths = {
    z6Home: environment.baseDir,
    z6UserData: environment.isDevelopment
      ? undefined
      : path.join(environment.appDataDirectory, Z6_DESKTOP_USER_DATA_DIRNAME),
  };

  const readState = Effect.sync(() => readT3DataState(paths));
  const state = readState.pipe(
    Effect.map((current): DesktopT3DataState => ({
      locations: current.locations.map(({ kind, path }) => ({ kind, path })),
      lastCleanup: current.lastCleanup ?? null,
    })),
  );

  const run = Effect.gen(function* () {
    const result = yield* Effect.tryPromise(() =>
      removeT3Data({
        ...paths,
        homeDirectory: environment.homeDirectory,
        t3UserData: path.join(environment.appDataDirectory, T3_DESKTOP_USER_DATA_DIRNAME),
        trash: (target) => Electron.shell.trashItem(target),
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed({
          status: "refused" as const,
          reason: `The cleanup stopped: ${error.cause instanceof Error ? error.cause.message : String(error.cause)}`,
        }),
      ),
    );
    if (result.status === "nothing") return;
    if (result.status === "refused") {
      yield* logWarning("t3 data removal refused", { reason: result.reason });
      yield* dialog
        .showMessageBox({
          type: "warning",
          message: "T3 Code's old data was not removed",
          detail: result.reason,
        })
        .pipe(Effect.ignore);
      return;
    }
    yield* logInfo("t3 data moved to trash", {
      removed: result.removed.length,
      kept: result.kept.length,
    });
    const lines = [
      ...(result.removed.length > 0
        ? ["Moved to the Trash:", ...result.removed.map((item) => `  ${item}`)]
        : []),
      ...(result.kept.length > 0
        ? ["", "Kept:", ...result.kept.map((item) => `  ${item.path}: ${item.reason}`)]
        : []),
    ];
    yield* dialog
      .showMessageBox({
        type: "info",
        message: "T3 Code's old data was cleaned up",
        detail: lines.join("\n").trim(),
      })
      .pipe(Effect.ignore);
  });

  const remove = Effect.gen(function* () {
    const current = yield* readState;
    if (current.locations.length === 0) return yield* state;
    const { response } = yield* dialog
      .showMessageBox({
        type: "question",
        buttons: ["Cancel", "Move to Trash"],
        defaultId: 0,
        cancelId: 0,
        message: "Move T3 Code's old data to the Trash?",
        detail: [
          ...current.locations.map(
            (location) => `${location.path} (${describeKind(location.kind)})`,
          ),
          "",
          "T3 Code will start empty afterwards. Worktrees Z6 Code still uses, or with uncommitted changes, are kept.",
        ].join("\n"),
      })
      .pipe(Effect.orElseSucceed(() => ({ response: 0, checkboxChecked: false })));
    if (response === 1) yield* run;
    return yield* state;
  }).pipe(Effect.withSpan("desktop.t3Data.remove"));

  const promptAfterMigration = Effect.gen(function* () {
    const current = yield* readState;
    if (!current.promptPending) return;
    const { response } = yield* dialog
      .showMessageBox({
        type: "question",
        buttons: ["Keep", "Move to Trash"],
        defaultId: 0,
        cancelId: 0,
        message: "Z6 Code copied your T3 Code data",
        detail: [
          "Z6 Code now keeps its own copy and no longer uses T3 Code's folders:",
          "",
          ...current.locations.map(
            (location) => `${location.path} (${describeKind(location.kind)})`,
          ),
          "",
          "Keep them if you still use T3 Code. You can remove them later in Settings.",
        ].join("\n"),
      })
      .pipe(Effect.orElseSucceed(() => ({ response: 0, checkboxChecked: false })));
    yield* Effect.sync(() => markT3CleanupPromptAnswered(paths));
    if (response === 1) yield* run;
  }).pipe(
    Effect.catchDefect((defect) => logWarning("t3 data prompt failed", { defect: String(defect) })),
    Effect.withSpan("desktop.t3Data.promptAfterMigration"),
  );

  return DesktopT3Data.of({ state, remove, promptAfterMigration });
});

export const layer = Layer.effect(DesktopT3Data, make);
