import { BobRuleKind, type BobRule, type EnvironmentId, type ProjectId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { PlusIcon, XIcon } from "lucide-react";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { bobRuleValue } from "./BobRulesSection.logic";
import { useSettingsScope } from "./SettingsScopeContext";

const RULE_KINDS: ReadonlyArray<{
  readonly value: BobRuleKind;
  readonly label: string;
  readonly placeholder: string;
}> = [
  { value: "allow-command", label: "Run without asking", placeholder: "git commit" },
  { value: "ask-command", label: "Always ask", placeholder: "make deploy" },
  { value: "read", label: "Commands may read", placeholder: "~/.vercel" },
  { value: "write", label: "Commands may write in", placeholder: "~/Library/Caches/go-build" },
  { value: "private", label: "Keep private", placeholder: "~/notes" },
];
const EVERY_PROJECT = "every-project";
const isRuleKind = Schema.is(BobRuleKind);

/**
 * The user's permission rules for Bob on one environment, which every Bob instance there follows
 * outside Full access. Approval cards add rules too.
 */
export function BobRulesSection(props: {
  readonly environmentId: EnvironmentId;
  readonly projects: ReadonlyArray<{ readonly id: ProjectId; readonly title: string }>;
  readonly readOnly: boolean;
}) {
  const { environments } = useSettingsScope();
  const rules =
    environments.find((environment) => environment.environmentId === props.environmentId)
      ?.serverConfig?.settings.bobRules ?? [];
  const update = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: false });
  const [kind, setKind] = useState<BobRuleKind>("allow-command");
  const [value, setValue] = useState("");
  const [where, setWhere] = useState<string>(EVERY_PROJECT);
  const [error, setError] = useState<string | null>(null);
  const kindOf = (rule: BobRuleKind) => RULE_KINDS.find((entry) => entry.value === rule);
  const projectOf = (id: string | undefined) => props.projects.find((project) => project.id === id);
  const whereOf = (rule: BobRule) => {
    const project =
      rule.projectId === undefined
        ? undefined
        : (projectOf(rule.projectId)?.title ?? "a removed project");
    if (rule.threadId !== undefined) {
      // The id's end, which tells imported threads (`import:bob:…`) apart too.
      const thread = `Thread …${rule.threadId.slice(-8)}`;
      return project ? `${thread} in ${project}` : thread;
    }
    return project ?? "Every project";
  };

  // Adds and removals apply to the rules as saved, so they never undo another change.
  const save = async (changes: {
    readonly add?: ReadonlyArray<BobRule>;
    readonly remove?: ReadonlyArray<BobRule>;
  }) => {
    const result = await update({
      environmentId: props.environmentId,
      input: {
        patch: {
          bobRuleChanges: {
            ...(changes.add ? { add: [...changes.add] } : {}),
            ...(changes.remove ? { remove: [...changes.remove] } : {}),
          },
        },
      },
    });
    if (result._tag === "Failure") {
      toastManager.add({ type: "error", title: "Bob's permission rules were not saved" });
    }
  };
  const add = () => {
    const draft = bobRuleValue(kind, value);
    if ("error" in draft) {
      setError(draft.error);
      return;
    }
    const projectId = projectOf(where)?.id;
    const rule: BobRule = {
      kind,
      value: draft.value,
      ...(projectId ? { projectId } : {}),
    };
    if (
      rules.some(
        (saved) =>
          saved.kind === rule.kind &&
          saved.value === rule.value &&
          saved.projectId === rule.projectId &&
          saved.threadId === undefined,
      )
    ) {
      setError("That rule is already saved.");
      return;
    }
    setValue("");
    setError(null);
    void save({ add: [rule] });
  };

  return (
    <div className="px-3 py-3 sm:px-4">
      <p className="mb-3 text-xs text-muted-foreground">
        Outside Full access, for every Bob instance on this environment. Commands that run without
        asking run outside the sandbox. Keep private stops commands and Bob&apos;s edits, not
        Bob&apos;s own reads. Approval cards add rules here too, for a thread, a project or every
        project.
      </p>
      {rules.length > 0 ? (
        <ul className="mb-3 divide-y divide-border rounded-md border border-border">
          {rules.map((rule) => (
            <li
              key={`${rule.kind}\0${rule.projectId ?? ""}\0${rule.threadId ?? ""}\0${rule.value}`}
              className="flex items-center gap-2 px-2 py-1 text-xs"
            >
              <span className="w-36 shrink-0 text-muted-foreground">
                {kindOf(rule.kind)?.label}
              </span>
              <code className="min-w-0 flex-1 truncate font-mono">{rule.value}</code>
              <span className="max-w-40 shrink-0 truncate text-muted-foreground">
                {whereOf(rule)}
              </span>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label="Remove rule"
                disabled={props.readOnly}
                onClick={() => void save({ remove: [rule] })}
              >
                <XIcon />
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <div className="w-44">
          <Select
            value={kind}
            onValueChange={(next) => {
              if (isRuleKind(next)) setKind(next);
            }}
          >
            <SelectTrigger size="xs" aria-label="Rule">
              <SelectValue>{kindOf(kind)?.label}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              {RULE_KINDS.map((entry) => (
                <SelectItem key={entry.value} value={entry.value}>
                  {entry.label}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <div className="min-w-40 flex-1">
          <Input
            size="sm"
            value={value}
            placeholder={kindOf(kind)?.placeholder}
            aria-label="Command or path"
            disabled={props.readOnly}
            onChange={(event) => setValue(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") add();
            }}
          />
        </div>
        <div className="w-40">
          <Select
            value={where}
            onValueChange={(next) => {
              if (typeof next === "string") setWhere(next);
            }}
          >
            <SelectTrigger size="xs" aria-label="Where it applies">
              <SelectValue>{projectOf(where)?.title ?? "Every project"}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="start" alignItemWithTrigger={false}>
              <SelectItem value={EVERY_PROJECT}>Every project</SelectItem>
              {props.projects.map((project) => (
                <SelectItem key={project.id} value={project.id}>
                  {project.title}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        </div>
        <Button size="xs" variant="outline" disabled={props.readOnly} onClick={add}>
          <PlusIcon />
          Add
        </Button>
      </div>
      {error ? <p className="mt-2 text-xs text-destructive">{error}</p> : null}
    </div>
  );
}
