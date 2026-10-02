import { CheckInRepeatLimitHours } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import { AppTextInput } from "../../../components/AppText";

const isRepeatLimit = Schema.is(CheckInRepeatLimitHours);

/** Hours a repeating check-in keeps going; commits whole hours in range on blur or Done. */
export function CheckInHoursField(props: {
  readonly value: number | null;
  readonly onValueChange: (value: number) => void;
  readonly disabled?: boolean;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    const text = (draft ?? "").trim();
    setDraft(null);
    if (props.disabled) return;
    const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (isRepeatLimit(parsed) && parsed !== props.value) props.onValueChange(parsed);
  };
  return (
    <AppTextInput
      className="min-h-10 w-20 rounded-xl px-3 py-2 text-center text-base"
      keyboardType="number-pad"
      returnKeyType="done"
      placeholder={props.value === null ? "Mixed" : undefined}
      value={draft ?? (props.value === null ? "" : String(props.value))}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      accessibilityLabel="Hours before a repeating check-in stops"
      editable={!props.disabled}
    />
  );
}
