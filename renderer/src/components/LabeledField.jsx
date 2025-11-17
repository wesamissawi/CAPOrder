// src/components/LabeledField.jsx
import React from "react";

export default function LabeledField({ label, children, className = "" }) {
  return (
    <div className={className}>
      <label className="block text-xs text-slate-500">{label}</label>
      {children}
    </div>
  );
}
