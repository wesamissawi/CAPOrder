// src/components/LabeledInput.jsx
import React from "react";
import LabeledField from "./LabeledField"; // adjust path if needed

export default function LabeledInput({
  label,
  className = "",
  inputClassName = "",
  ...inputProps
}) {
  return (
    <LabeledField label={label} className={className}>
      <input
        className={"w-full border rounded-lg p-2 " + inputClassName}
        {...inputProps}
      />
    </LabeledField>
  );
}
