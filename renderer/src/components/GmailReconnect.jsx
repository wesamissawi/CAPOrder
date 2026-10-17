import React, { useState } from "react";
import api from "../api";

// Google answers a dead refresh token with `invalid_grant` ("Token has been
// expired or revoked"); gmail.auth.js says "Gmail is not connected" when there
// is none at all. Either way the fix is the same consent flow Settings runs,
// so any Gmail-step error that looks like one of these gets a Reconnect button
// right where the error is shown, instead of a trip into Settings.
const GMAIL_AUTH_ERROR =
  /invalid[_ ]grant|invalid[_ ]token|invalid (authentication )?credentials|expired or revoked|gmail is not connected|refresh token|unauthorized_client/i;

export function isGmailAuthError(message) {
  return typeof message === "string" && GMAIL_AUTH_ERROR.test(message);
}

// Opens Google's consent page in the browser (vendor:connect-gmail, the same
// handler Settings' "Reconnect Gmail" uses) and saves the new refresh token.
// `onReconnected` lets the caller clear the stale error once it worked.
export default function GmailReconnectButton({ onReconnected, className = "" }) {
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [failed, setFailed] = useState(false);

  async function handleClick() {
    if (busy) return;
    setBusy(true);
    setFailed(false);
    setNote("Finish signing in in the browser window that just opened…");
    try {
      const res = await api.connectGmail?.();
      if (res?.ok) {
        setNote(res.emailAddress ? `Reconnected as ${res.emailAddress}. Run the check again.` : "Gmail reconnected. Run the check again.");
        onReconnected?.(res);
      } else {
        setFailed(true);
        setNote(res?.error || "Reconnect failed.");
      }
    } catch (e) {
      setFailed(true);
      setNote(e?.message || "Reconnect failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className={`mt-2 flex flex-wrap items-center gap-2 ${className}`}>
      <button
        type="button"
        onClick={handleClick}
        disabled={busy}
        title="Sign in to Gmail again (same as Settings → Reconnect Gmail)"
        className="px-3 py-1 rounded-full text-xs font-semibold border border-red-300 bg-white text-red-700 hover:bg-red-100 disabled:opacity-60"
      >
        {busy ? "Waiting for Google…" : "Reconnect Gmail"}
      </button>
      {note && <span className={`text-xs ${failed ? "text-red-700" : "text-slate-600"}`}>{note}</span>}
    </div>
  );
}
