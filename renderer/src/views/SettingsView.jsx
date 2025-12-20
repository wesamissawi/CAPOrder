import React, { useEffect, useMemo, useState } from "react";
import api from "../api";
import Card from "../components/Card";

function PathRow({ label, value, onChange, readOnly, onBrowse, helper, status }) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <label className="text-xs uppercase tracking-wide text-slate-500">{label}</label>
        {status}
      </div>
      <div className="flex gap-2">
        <input
          className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono"
          value={value || ""}
          onChange={(e) => onChange && onChange(e.target.value)}
          readOnly={readOnly}
        />
        {onBrowse ? (
          <button
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white"
            onClick={onBrowse}
          >
            Browse…
          </button>
        ) : (
          <button
            className="px-3 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white"
            onClick={() => navigator.clipboard?.writeText(value || "")}
          >
            Copy
          </button>
        )}
      </div>
      {helper && <div className="text-xs text-slate-500">{helper}</div>}
    </div>
  );
}

export default function SettingsView() {
  const [sharedPath, setSharedPath] = useState("");
  const [instancePath, setInstancePath] = useState("");
  const [configPath, setConfigPath] = useState("");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [validate, setValidate] = useState({ ok: false, error: "Not checked" });
  const [migrateMode, setMigrateMode] = useState("copy");
  const [migrateResults, setMigrateResults] = useState([]);

  const sharedStatus = useMemo(() => {
    if (!sharedPath) return <span className="text-xs text-amber-600 font-semibold">Not set</span>;
    if (validate.ok) return <span className="text-xs text-emerald-600 font-semibold">Writable</span>;
    return <span className="text-xs text-red-600 font-semibold">{validate.error || "Invalid"}</span>;
  }, [sharedPath, validate]);

  async function load() {
    setError("");
    try {
      const res = await api.getAppConfig();
      if (!res?.ok) throw new Error(res?.error || "Failed to read app config.");
      setSharedPath(res.config?.sharedDataDir || "");
      setInstancePath(res.config?.instanceDataDir || "");
      setConfigPath(res.path || "");
      setStatus("");
      await refreshSummary();
      if (res.config?.sharedDataDir) {
        await handleValidate(res.config.sharedDataDir);
      }
    } catch (e) {
      setError(e?.message || "Failed to load settings.");
    }
  }

  async function refreshSummary() {
    const res = await api.getResolvedPathsSummary();
    if (res?.ok) setSummary(res.summary);
  }

  async function handleValidate(pathStr) {
    if (!pathStr) {
      setValidate({ ok: false, error: "Not set" });
      return;
    }
    const res = await api.validateSharedFolderWritable(pathStr);
    setValidate(res.ok ? { ok: true } : { ok: false, error: res.error });
  }

  async function handleSave() {
    setError("");
    setStatus("");
    try {
      const res = await api.setAppConfig({ sharedDataDir: sharedPath });
      if (!res?.ok) throw new Error(res?.error || "Failed to save app config.");
      setStatus("Saved.");
      await load();
    } catch (e) {
      setError(e?.message || "Failed to save settings.");
    }
  }

  async function handleBrowseShared() {
    const res = await api.chooseSharedFolderDialog();
    if (res?.ok && res.path) {
      setSharedPath(res.path);
      await handleValidate(res.path);
    }
  }

  async function handleMigrate() {
    setError("");
    setStatus("");
    try {
      const res = await api.migrateBusinessFilesToShared({ mode: migrateMode });
      if (!res?.ok) throw new Error(res?.error || "Migration failed.");
      setMigrateResults(res.results || []);
      setStatus(`Migration complete (${migrateMode}).`);
      await refreshSummary();
    } catch (e) {
      setError(e?.message || "Migration failed.");
    }
  }

  useEffect(() => {
    load();
  }, []);

  return (
    <div className="space-y-4">
      <Card>
        <div className="flex items-center justify-between gap-3">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Storage</h2>
            <p className="text-sm text-slate-500">
              Choose where business data is stored (shared) vs. machine data (instance).
            </p>
            {configPath && (
              <p className="text-xs text-slate-400 mt-1">Config file: {configPath}</p>
            )}
          </div>
          <div className="flex gap-2">
            <button
              className="px-4 py-2 rounded-full border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white"
              onClick={load}
            >
              Reload
            </button>
            <button
              className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold shadow hover:bg-indigo-700"
              onClick={handleSave}
            >
              Save
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-6">
          <PathRow
            label="Instance folder (per-computer, read-only)"
            value={instancePath}
            readOnly
            helper="Electron userData. Contains UI state, window bounds, and vendor sessions."
          />
          <PathRow
            label="Shared folder (business data)"
            value={sharedPath}
            onChange={(v) => setSharedPath(v)}
            onBrowse={handleBrowseShared}
            status={sharedStatus}
            helper="Orders, outstanding items, Sage queues, and archive live here."
          />
          {!sharedPath && (
            <div className="text-sm text-amber-600">
              Shared folder not set. Choose a network/local folder to enable shared data.
            </div>
          )}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {status && <div className="text-sm text-emerald-600">{status}</div>}
        </div>
      </Card>

      <Card>
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-slate-800">Migration</h3>
              <p className="text-sm text-slate-500">
                Copy or move existing business files from the instance folder into the shared folder.
              </p>
            </div>
            <div className="flex gap-2 items-center text-sm">
              <label className="font-semibold text-slate-700">Mode</label>
              <select
                className="rounded-lg border border-slate-200 px-2 py-1 text-sm"
                value={migrateMode}
                onChange={(e) => setMigrateMode(e.target.value)}
              >
                <option value="copy">Copy (safe)</option>
                <option value="move">Move</option>
              </select>
            </div>
          </div>
          <div className="flex gap-3">
            <button
              className="px-4 py-2 rounded-full bg-slate-800 text-white text-sm font-semibold shadow hover:bg-slate-900"
              onClick={handleMigrate}
              disabled={!sharedPath}
            >
              Run migration
            </button>
          </div>
          {migrateResults.length > 0 && (
            <div className="text-sm text-slate-600 space-y-1">
              {migrateResults.map((r, idx) => (
                <div key={idx}>
                  <span className="font-semibold">{r.name}</span>: {r.action}
                  {r.reason ? ` (${r.reason})` : ""}
                  {r.error ? ` (${r.error})` : ""}
                </div>
              ))}
            </div>
          )}
          {summary && (
            <div className="text-xs text-slate-500">
              Shared folder: {summary.sharedDir} | Instance: {summary.instanceDir}
            </div>
          )}
        </div>
      </Card>
    </div>
  );
}
