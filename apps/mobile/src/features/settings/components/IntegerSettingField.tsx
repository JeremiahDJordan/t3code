import { useState } from "react";

import { AppTextInput } from "../../../components/AppText";

/**
 * A whole number within bounds, saved when editing ends. Anything else snaps
 * back to the saved value. A mixed selection (null) shows empty.
 */
export function IntegerSettingField(props: {
  readonly value: number | null;
  readonly min: number;
  readonly max: number;
  readonly accessibilityLabel: string;
  readonly disabled?: boolean;
  readonly onValueChange: (value: number) => void;
}) {
  const [draft, setDraft] = useState<string | null>(null);
  const commit = () => {
    if (draft === null) return;
    setDraft(null);
    if (props.disabled) return;
    // Validate the whole input; decimals and trailing text must not become a number.
    const text = draft.trim();
    const parsed = /^\d+$/.test(text) ? Number(text) : Number.NaN;
    if (
      Number.isInteger(parsed) &&
      parsed >= props.min &&
      parsed <= props.max &&
      parsed !== props.value
    ) {
      props.onValueChange(parsed);
    }
  };
  return (
    <AppTextInput
      className="min-h-10 w-20 rounded-xl px-3 py-2 text-center text-base"
      keyboardType="number-pad"
      returnKeyType="done"
      value={draft ?? (props.value === null ? "" : String(props.value))}
      placeholder={props.value === null ? "Mixed" : undefined}
      onChangeText={setDraft}
      onBlur={commit}
      onSubmitEditing={commit}
      accessibilityLabel={props.accessibilityLabel}
      accessibilityHint={`A whole number from ${props.min} to ${props.max}`}
      editable={!props.disabled}
    />
  );
}
