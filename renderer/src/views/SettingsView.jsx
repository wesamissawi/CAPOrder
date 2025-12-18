import React, { useEffect, useState } from "react";
import api from "../api";
import Card from "../components/Card";

export default function SettingsView() {
  const [configText, setConfigText] = useState("{}");
  const [configPath, setConfigPath] = useState("");
  const [overrides, setOverrides] = useState({});
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");

  async function loadConfig() {
    setError("");
    setStatus("");
    try {
      const res = await api.readConfig();
      if (!res?.ok) throw new Error(res?.error || "Failed to read config.");
      setConfigText(JSON.stringify(res.raw || {}, null, 2));
      setOverrides(res.overrides || {});
      if (res.path) setConfigPath(res.path);
    } catch (e) {
      setError(e?.message || "Failed to load settings.");
    }
  }

  async function handleSave() {
    setError("");
    setStatus("");
    let next;
    try {
      next = JSON.parse(configText || "{}");
    } catch (e) {
      setError("Settings must be valid JSON.");
      return;
    }
    if (!next || typeof next !== "object" || Array.isArray(next)) {
      setError("Settings must be a JSON object.");
      return;
    }
    try {
      const res = await api.writeConfig(next);
      if (!res?.ok) throw new Error(res?.error || "Failed to save config.");
      setStatus("Saved.");
      await loadConfig();
    } catch (e) {
      setError(e?.message || "Failed to save settings.");
    }
  }

  useEffect(() => {
    loadConfig();
  }, []);

  const overrideKeys = Object.keys(overrides || {});

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Settings</h2>
            <p className="text-sm text-slate-500">
              Store runtime configuration locally. Use JSON with key/value pairs or nested objects.
            </p>
            {configPath && (
              <p className="text-xs text-slate-400 mt-1">File: {configPath}</p>
            )}
          </div>
          <button
            className="px-4 py-2 rounded-full border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white"
            onClick={loadConfig}
          >
            Reload
          </button>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <label className="text-xs uppercase tracking-wide text-slate-500">
            Configuration (JSON)
          </label>
          <textarea
            className="w-full min-h-[260px] rounded-xl border border-slate-200 p-3 text-sm font-mono"
            value={configText}
            onChange={(e) => setConfigText(e.target.value)}
          />
          {error && <div className="text-sm text-red-600">{error}</div>}
          {status && <div className="text-sm text-emerald-600">{status}</div>}
          <div className="flex justify-end gap-2">
            <button
              className="px-4 py-2 rounded-full bg-indigo-600 text-white font-semibold shadow hover:bg-indigo-700"
              onClick={handleSave}
            >
              Save Settings
            </button>
          </div>
        </div>
      </Card>

      {overrideKeys.length > 0 && (
        <Card>
          <div className="text-sm text-slate-600">
            Dev override keys (from process.env):{" "}
            <span className="font-semibold">
              {overrideKeys.join(", ")}
            </span>
          </div>
        </Card>
      )}
    </div>
  );
}
