// src/components/Card.jsx
import React from "react";

export default function Card({ children, className = "", ...rest }) {
  return (
    <div
      className={
        "rounded-2xl shadow-lg p-3 sm:p-4 bg-white/90 backdrop-blur border border-slate-200 " +
        className
      }
      {...rest}
    >
      {children}
    </div>
  );
}
