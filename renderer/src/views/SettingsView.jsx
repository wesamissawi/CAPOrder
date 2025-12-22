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
            Browse...
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
  const [appVersion, setAppVersion] = useState("");
  const [appName, setAppName] = useState("");
  const [isPackaged, setIsPackaged] = useState(false);

  const fileEntries = useMemo(() => {
    if (!summary?.files) return [];
    const labels = {
      orders_json: "orders.json",
      orders_json_bak: "orders.json.bak",
      outstanding_items: "outstanding_items.json",
      sage_ar_items: "sage_ar_items.json",
      cash_sales_items: "cash_sales_items.json",
      archived_bubbles: "archived_bubbles.json",
      archived_bubbles_bak: "archived_bubbles.json.bak",
    };
    return Object.entries(labels).map(([key, label]) => {
      const info = summary.files[key] || {};
      return { key, label, path: info.path || "", exists: Boolean(info.exists) };
    });
  }, [summary]);

  const sharedStatus = useMemo(() => {
    if (!sharedPath) return <span className="text-xs text-amber-600 font-semibold">Not set</span>;
    if (summary?.sharedConfigured && summary?.sharedExists === false) {
      return <span className="text-xs text-red-600 font-semibold">Missing / Invalid</span>;
    }
    if (validate.ok) return <span className="text-xs text-emerald-600 font-semibold">OK (writable)</span>;
    if (validate.error && validate.error !== "Not checked") {
      return <span className="text-xs text-amber-600 font-semibold">{validate.error}</span>;
    }
    return <span className="text-xs text-slate-500 font-semibold">Not checked</span>;
  }, [sharedPath, validate, summary]);

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
      } else {
        setValidate({ ok: false, error: "Not set" });
      }
      const ver = await api.getAppVersion?.();
      if (ver?.ok) {
        setAppVersion(ver.version || "");
        setAppName(ver.name || "");
        setIsPackaged(Boolean(ver.isPackaged));
      }
    } catch (e) {
      setError(e?.message || "Failed to load settings.");
    }
  }

  async function refreshSummary() {
    try {
      const res =
        (await api.getResolvedBusinessPaths?.()) ||
        (await api.getResolvedPathsSummary?.());
      if (res?.ok) setSummary(res.summary);
    } catch (e) {
      console.warn("[settings] failed to refresh summary", e);
    }
  }

  async function handleValidate(pathStr) {
    if (!pathStr) {
      setValidate({ ok: false, error: "Not set" });
      return;
    }
    try {
      const res = await api.validateSharedFolderWritable(pathStr);
      const next = res.ok ? { ok: true } : { ok: false, error: res.error || "Not writable" };
      setValidate(next);
      if (res.ok) {
        await refreshSummary();
      }
    } catch (e) {
      setValidate({ ok: false, error: e?.message || "Validation failed" });
    }
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
    setMigrateResults([]);
    try {
      const res = await api.migrateBusinessFilesToShared({ mode: migrateMode });
      if (!res?.ok) throw new Error(res?.error || "Migration failed.");
      setMigrateResults(res.results || []);
      const dest = res.sharedDir || sharedPath || "shared folder";
      setStatus(`Migration complete (${migrateMode}) -> ${dest}.`);
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
            {appVersion && (
              <p className="text-xs text-slate-400 mt-1">
                Version: {appName || "App"} {appVersion} ({isPackaged ? "packaged" : "dev"})
              </p>
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
          {summary?.sharedConfigured && summary.sharedExists === false && (
            <div className="text-sm text-red-600">
              Shared folder is missing or unavailable. Pick a reachable network/local folder and save the settings.
            </div>
          )}
          {error && <div className="text-sm text-red-600">{error}</div>}
          {status && <div className="text-sm text-emerald-600">{status}</div>}
          {fileEntries.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs uppercase tracking-wide text-slate-500">Business file locations</div>
              <div className="grid gap-3 sm:grid-cols-2">
                {fileEntries.map((entry) => (
                  <div key={entry.key} className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                    <div className="text-xs font-semibold text-slate-700">{entry.label}</div>
                    <div className="text-[11px] font-mono break-all text-slate-600">
                      {entry.path || "Not resolved"}
                    </div>
                    <div
                      className={`text-xs font-semibold ${entry.exists ? "text-emerald-600" : "text-red-600"}`}
                    >
                      {entry.exists ? "Exists" : "Missing"}
                    </div>
                  </div>
                ))}
              </div>
              {summary?.queueDir && (
                <div className="text-[11px] text-slate-500">
                  Queue folder (orders + outstanding):{" "}
                  <span className="font-mono break-all text-slate-700">{summary.queueDir}</span>
                </div>
              )}
            </div>
          )}
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
