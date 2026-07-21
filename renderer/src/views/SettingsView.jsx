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
  const [sharedBubblePath, setSharedBubblePath] = useState("");
  const [sharedBubbleExists, setSharedBubbleExists] = useState(false);
  const [configPath, setConfigPath] = useState("");
  const [summary, setSummary] = useState(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const [validate, setValidate] = useState({ ok: false, error: "Not checked" });
  const [migrateMode, setMigrateMode] = useState("copy");
  const [migrateResults, setMigrateResults] = useState([]);
  const [ahkPath, setAhkPath] = useState("");
  const [ahkValid, setAhkValid] = useState(false);
  const [ahkStatus, setAhkStatus] = useState("Not set");
  const [sageTimeoutSeconds, setSageTimeoutSeconds] = useState(300);
  const [itemsReplaceAll, setItemsReplaceAll] = useState(true);
  const [updateStatus, setUpdateStatus] = useState("idle");
  const [updateMessage, setUpdateMessage] = useState("");
  const [updateVersion, setUpdateVersion] = useState("");
  const [lastChecked, setLastChecked] = useState("");
  const [appVersion, setAppVersion] = useState("");
  const [appName, setAppName] = useState("");
  const [isPackaged, setIsPackaged] = useState(false);
  const [worldUser, setWorldUser] = useState("");
  const [worldPass, setWorldPass] = useState("");
  const [transbecUser, setTransbecUser] = useState("");
  const [transbecPass, setTransbecPass] = useState("");
  const [transbecMaxPages, setTransbecMaxPages] = useState(1);
  const [cbkUser, setCbkUser] = useState("");
  const [cbkPass, setCbkPass] = useState("");
  const [tigerUser, setTigerUser] = useState("");
  const [tigerPass, setTigerPass] = useState("");
  const [bestbuyUser, setBestbuyUser] = useState("");
  const [bestbuyPass, setBestbuyPass] = useState("");
  const [proforceStore, setProforceStore] = useState("");
  const [proforceCustomer, setProforceCustomer] = useState("");
  const [proforcePass, setProforcePass] = useState("");
  const [epicorUser, setEpicorUser] = useState("");
  const [epicorPass, setEpicorPass] = useState("");
  const [gmailClientId, setGmailClientId] = useState("");
  const [gmailClientSecret, setGmailClientSecret] = useState("");
  const [transbecInvoiceSender, setTransbecInvoiceSender] = useState("");
  const [transbecInvoiceSubject, setTransbecInvoiceSubject] = useState("");
  const [bestbuyInvoiceSender, setBestbuyInvoiceSender] = useState("");
  const [bestbuyInvoiceSubject, setBestbuyInvoiceSubject] = useState("BESTBUY INVOICES FOR TODAY");
  const [bestbuyCreditInvoiceSender, setBestbuyCreditInvoiceSender] = useState("bestautosolution.ca");
  const [bestbuyCreditInvoiceSubject, setBestbuyCreditInvoiceSubject] = useState("invoice");
  const [cbkInvoiceSender, setCbkInvoiceSender] = useState("branch_05@cbkauto.com");
  const [cbkInvoiceSubject, setCbkInvoiceSubject] = useState("Invoice");
  const [transbecCreditInvoiceSender, setTransbecCreditInvoiceSender] = useState("donotreply@transbec.ca");
  const [transbecCreditInvoiceSubject, setTransbecCreditInvoiceSubject] = useState("Credit Memo");
  const [gmailConnected, setGmailConnected] = useState(false);
  const [gmailEmail, setGmailEmail] = useState("");
  const [gmailConnecting, setGmailConnecting] = useState(false);
  const [gmailStatusMsg, setGmailStatusMsg] = useState("");
  const [credStatus, setCredStatus] = useState("");
  const [credError, setCredError] = useState("");
  const [credSaving, setCredSaving] = useState(false);
  const [timeoutError, setTimeoutError] = useState("");
  const [invoicePrinter, setInvoicePrinter] = useState("");
  const [printerOptions, setPrinterOptions] = useState([]);
  const [printersLoading, setPrintersLoading] = useState(false);
  const [printersError, setPrintersError] = useState("");

  const fileEntries = useMemo(() => {
    if (!summary?.files) return [];
      const labels = {
        orders_json: "orders.json",
        orders_json_bak: "orders.json.bak",
        orders_index_json: "orders_index.json",
        orders_archive_json: "orders_archive.json",
        orders_archive_bak: "orders_archive.json.bak",
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

  async function refreshAhkStatus(pathStr) {
    try {
      const res = await api.validateAhkExePath?.(pathStr);
      const exists = Boolean(res?.exists);
      setAhkValid(exists);
      if (!pathStr) {
        setAhkStatus("Not set");
      } else {
        setAhkStatus(exists ? "OK (found)" : "Missing / Invalid");
      }
    } catch (e) {
      setAhkValid(false);
      setAhkStatus("Validation failed");
    }
  }

  async function load() {
    setError("");
    try {
      const res = await api.getAppConfig();
      if (!res?.ok) throw new Error(res?.error || "Failed to read app config.");
      setSharedPath(res.config?.sharedDataDir || "");
      setInstancePath(res.config?.instanceDataDir || "");
      setConfigPath(res.path || "");
      const incomingAhk = res.config?.ahkExePath || "";
      setAhkPath(incomingAhk);
      if (typeof res.config?.sageAhkTimeoutMs === "number") {
        setSageTimeoutSeconds(Math.round(res.config.sageAhkTimeoutMs / 1000));
      } else {
        setSageTimeoutSeconds(300);
      }
      setItemsReplaceAll(res.config?.itemsReplaceAll !== false);
      await refreshAhkStatus(incomingAhk);
      setStatus("");
      await refreshSummary();
      try {
        const bubbleRes = await api.readSharedBubbleData?.();
        if (bubbleRes?.path) {
          setSharedBubblePath(bubbleRes.path);
          setSharedBubbleExists(Boolean(bubbleRes.exists) || false);
        } else {
          setSharedBubblePath("");
          setSharedBubbleExists(false);
        }
      } catch (e) {
        setSharedBubblePath("");
        setSharedBubbleExists(false);
      }
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
      try {
        const credRes = await api.getConfig?.();
        if (credRes?.ok) {
          const cfg = credRes.config || {};
          setWorldUser(cfg.WORLD_USER || "");
          setWorldPass(cfg.WORLD_PASS || "");
          setTransbecUser(cfg.TRANSBEC_USER || "");
          setTransbecPass(cfg.TRANSBEC_PASS || "");
          const pagesRaw = Number(cfg.TRANSBEC_MAX_PAGES);
          setTransbecMaxPages(
            Number.isFinite(pagesRaw) && pagesRaw >= 1 ? Math.floor(pagesRaw) : 1
          );
          setCbkUser(cfg.CBK_USER || "");
          setCbkPass(cfg.CBK_PASS || "");
          setTigerUser(cfg.TIGER_USER || "");
          setTigerPass(cfg.TIGER_PASS || "");
          setBestbuyUser(cfg.BESTBUY_USER || "");
          setBestbuyPass(cfg.BESTBUY_PASS || "");
          setProforceStore(cfg.PROFORCE_STORE || "");
          setProforceCustomer(cfg.PROFORCE_CUSTOMER || "");
          setProforcePass(cfg.PROFORCE_PASS || "");
          setEpicorUser(cfg.EPICOR_USER || "");
          setEpicorPass(cfg.EPICOR_PASS || "");
          setGmailClientId(cfg.GMAIL_CLIENT_ID || "");
          setGmailClientSecret(cfg.GMAIL_CLIENT_SECRET || "");
          setTransbecInvoiceSender(cfg.TRANSBEC_INVOICE_SENDER || "");
          setTransbecInvoiceSubject(cfg.TRANSBEC_INVOICE_SUBJECT || "");
          setBestbuyInvoiceSender(cfg.BESTBUY_INVOICE_SENDER || "");
          setBestbuyInvoiceSubject(cfg.BESTBUY_INVOICE_SUBJECT || "BESTBUY INVOICES FOR TODAY");
          setBestbuyCreditInvoiceSender(cfg.BESTBUY_CREDIT_INVOICE_SENDER || "bestautosolution.ca");
          setBestbuyCreditInvoiceSubject(cfg.BESTBUY_CREDIT_INVOICE_SUBJECT || "invoice");
          setCbkInvoiceSender(cfg.CBK_INVOICE_SENDER || "branch_05@cbkauto.com");
          setCbkInvoiceSubject(cfg.CBK_INVOICE_SUBJECT || "Invoice");
          setTransbecCreditInvoiceSender(cfg.TRANSBEC_CREDIT_INVOICE_SENDER || "donotreply@transbec.ca");
          setTransbecCreditInvoiceSubject(cfg.TRANSBEC_CREDIT_INVOICE_SUBJECT || "Credit Memo");
          setInvoicePrinter(cfg.INVOICE_PRINTER || "");
          setCredStatus("");
          setCredError("");
          refreshGmailStatus();
          refreshPrinters();
        } else if (credRes?.error) {
          setCredError(credRes.error);
        }
      } catch (e) {
        setCredError(e?.message || "Failed to load credentials.");
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
    setTimeoutError("");
    try {
      const trimmedAhk = (ahkPath || "").trim();
      setAhkPath(trimmedAhk);
      const parsedTimeout = Number(sageTimeoutSeconds);
      if (!Number.isFinite(parsedTimeout)) {
        setTimeoutError("Timeout must be a number.");
        return;
      }
      if (parsedTimeout < 10) {
        setTimeoutError("Timeout must be at least 10 seconds.");
        return;
      }
      const nextTimeoutMs =
        Math.round(parsedTimeout * 1000);
      const res = await api.setAppConfig({
        sharedDataDir: sharedPath,
        ahkExePath: trimmedAhk,
        sageAhkTimeoutMs: nextTimeoutMs,
        itemsReplaceAll: Boolean(itemsReplaceAll),
      });
      if (!res?.ok) throw new Error(res?.error || "Failed to save app config.");
      setStatus("Saved.");
      await load();
    } catch (e) {
      setError(e?.message || "Failed to save settings.");
    }
  }

  async function handleSaveCreds() {
    try {
      setCredSaving(true);
      setCredStatus("");
      setCredError("");
      const res = await api.setConfig?.({
        WORLD_USER: worldUser || "",
        WORLD_PASS: worldPass || "",
        TRANSBEC_USER: transbecUser || "",
        TRANSBEC_PASS: transbecPass || "",
        TRANSBEC_MAX_PAGES:
          Number.isFinite(Number(transbecMaxPages)) && Number(transbecMaxPages) >= 1
            ? Math.floor(Number(transbecMaxPages))
            : 1,
        CBK_USER: cbkUser || "",
        CBK_PASS: cbkPass || "",
        TIGER_USER: tigerUser || "",
        TIGER_PASS: tigerPass || "",
        BESTBUY_USER: bestbuyUser || "",
        BESTBUY_PASS: bestbuyPass || "",
        PROFORCE_STORE: proforceStore || "",
        PROFORCE_CUSTOMER: proforceCustomer || "",
        PROFORCE_PASS: proforcePass || "",
        EPICOR_USER: epicorUser || "",
        EPICOR_PASS: epicorPass || "",
        GMAIL_CLIENT_ID: gmailClientId || "",
        GMAIL_CLIENT_SECRET: gmailClientSecret || "",
        TRANSBEC_INVOICE_SENDER: transbecInvoiceSender || "",
        TRANSBEC_INVOICE_SUBJECT: transbecInvoiceSubject || "",
        BESTBUY_INVOICE_SENDER: bestbuyInvoiceSender || "",
        BESTBUY_INVOICE_SUBJECT: bestbuyInvoiceSubject || "",
        BESTBUY_CREDIT_INVOICE_SENDER: bestbuyCreditInvoiceSender || "",
        BESTBUY_CREDIT_INVOICE_SUBJECT: bestbuyCreditInvoiceSubject || "",
        CBK_INVOICE_SENDER: cbkInvoiceSender || "",
        CBK_INVOICE_SUBJECT: cbkInvoiceSubject || "",
        TRANSBEC_CREDIT_INVOICE_SENDER: transbecCreditInvoiceSender || "",
        TRANSBEC_CREDIT_INVOICE_SUBJECT: transbecCreditInvoiceSubject || "",
        INVOICE_PRINTER: invoicePrinter || "",
      });
      if (res?.ok) {
        setCredStatus("Saved");
      } else {
        setCredError(res?.error || "Failed to save credentials.");
      }
    } catch (e) {
      setCredError(e?.message || "Failed to save credentials.");
    } finally {
      setCredSaving(false);
    }
  }

  async function refreshGmailStatus() {
    try {
      const res = await api.getGmailStatus?.();
      if (res?.ok) {
        setGmailConnected(Boolean(res.connected));
        setGmailEmail(res.emailAddress || "");
        if (!res.connected && res.reason === "error" && res.error) {
          setGmailStatusMsg(res.error);
        } else {
          setGmailStatusMsg("");
        }
      }
    } catch (e) {
      console.warn("[settings] gmail status failed", e);
    }
  }

  async function refreshPrinters() {
    setPrintersLoading(true);
    setPrintersError("");
    try {
      const res = await api.listPrinters?.();
      if (res?.ok) {
        setPrinterOptions(Array.isArray(res.printers) ? res.printers : []);
      } else {
        setPrintersError(res?.error || "Failed to list printers.");
      }
    } catch (e) {
      setPrintersError(e?.message || "Failed to list printers.");
    } finally {
      setPrintersLoading(false);
    }
  }

  async function handleConnectGmail() {
    setGmailConnecting(true);
    setGmailStatusMsg("");
    try {
      // Persist client id/secret/sender/subject first so connectGmail can read them.
      await handleSaveCreds();
      const res = await api.connectGmail?.();
      if (res?.ok) {
        setGmailConnected(true);
        setGmailEmail(res.emailAddress || "");
        setGmailStatusMsg(
          res.emailAddress ? `Connected as ${res.emailAddress}` : "Gmail connected."
        );
      } else {
        setGmailStatusMsg(res?.error || "Failed to connect Gmail.");
      }
    } catch (e) {
      setGmailStatusMsg(e?.message || "Failed to connect Gmail.");
    } finally {
      setGmailConnecting(false);
    }
  }

  async function handleBrowseShared() {
    const res = await api.chooseSharedFolderDialog();
    if (res?.ok && res.path) {
      setSharedPath(res.path);
      await handleValidate(res.path);
    }
  }

  async function handleBrowseAhk() {
    const res = await api.chooseAhkExePath?.();
    if (res?.ok && res.path) {
      setAhkPath(res.path);
      await refreshAhkStatus(res.path);
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

  async function handleCheckForUpdates() {
    try {
      setUpdateStatus("checking");
      setUpdateMessage("Checking for updates...");
      const res = await api.checkForUpdates?.();
      if (!res?.ok && res?.error) {
        setUpdateStatus("error");
        setUpdateMessage(res.error);
      }
    } catch (e) {
      setUpdateStatus("error");
      setUpdateMessage(e?.message || "Failed to check for updates.");
    }
  }

  async function handleRestartToUpdate() {
    try {
      await api.restartToUpdate?.();
    } catch (e) {
      setUpdateStatus("error");
      setUpdateMessage(e?.message || "Failed to restart to update.");
    }
  }

  useEffect(() => {
    load();
    const offUpdates = api.onUpdateStatus?.((payload) => {
      const status = payload?.status || "";
      setUpdateStatus(status);
      if (payload?.version) setUpdateVersion(payload.version);
      if (payload?.timestamp && status === "checking") setLastChecked(payload.timestamp);
      switch (status) {
        case "checking":
          setUpdateMessage("Checking for updates...");
          if (payload?.timestamp) setLastChecked(payload.timestamp);
          break;
        case "update-available":
          setUpdateMessage(`Update available${payload?.version ? ` (${payload.version})` : ""}`);
          break;
        case "update-not-available":
          setUpdateMessage("Up to date");
          setLastChecked(payload?.timestamp || new Date().toISOString());
          break;
        case "downloading":
          setUpdateMessage(`Downloading${payload?.percent ? ` ${payload.percent}%` : "..."}`);
          break;
        case "downloaded":
          setUpdateMessage(
            `Update downloaded${payload?.version ? ` (${payload.version})` : ""}. Restart to apply.`
          );
          setLastChecked(payload?.timestamp || new Date().toISOString());
          break;
        case "error":
          setUpdateMessage(payload?.error || "Update error.");
          break;
        default:
          break;
      }
    });
    return () => {
      offUpdates && offUpdates();
    };
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
        <div className="space-y-4">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">Scraper Credentials</h2>
              <p className="text-sm text-slate-500">
                Stored per-machine in app data. Used by World, Transbec, CBK, Tiger, BestBuy, Proforce, and Epicor scrapers.
              </p>
            </div>
            <div className="flex items-center gap-3">
              {credError && (
                <span className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-full px-3 py-1">
                  {credError}
                </span>
              )}
              {credStatus && !credError && (
                <span className="text-sm text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-3 py-1">
                  {credStatus}
                </span>
              )}
              <button
                type="button"
                onClick={handleSaveCreds}
                disabled={credSaving}
                className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-60"
              >
                {credSaving ? "Saving..." : "Save Credentials"}
              </button>
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">World Username</label>
              <input
                type="text"
                value={worldUser}
                onChange={(e) => setWorldUser(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">World Password</label>
              <input
                type="password"
                value={worldPass}
                onChange={(e) => setWorldPass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Transbec Username</label>
              <input
                type="text"
                value={transbecUser}
                onChange={(e) => setTransbecUser(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Transbec Password</label>
              <input
                type="password"
                value={transbecPass}
                onChange={(e) => setTransbecPass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Transbec Max Pages
              </label>
              <input
                type="number"
                min="1"
                step="1"
                value={transbecMaxPages}
                onChange={(e) => setTransbecMaxPages(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
              <div className="text-xs text-slate-500">
                How many order list pages to fetch each run.
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">CBK Username</label>
              <input
                type="text"
                value={cbkUser}
                onChange={(e) => setCbkUser(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">CBK Password</label>
              <input
                type="password"
                value={cbkPass}
                onChange={(e) => setCbkPass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Tiger Account #</label>
              <input
                type="text"
                value={tigerUser}
                onChange={(e) => setTigerUser(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Tiger Password</label>
              <input
                type="password"
                value={tigerPass}
                onChange={(e) => setTigerPass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">BestBuy Username</label>
              <input
                type="text"
                value={bestbuyUser}
                onChange={(e) => setBestbuyUser(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">BestBuy Password</label>
              <input
                type="password"
                value={bestbuyPass}
                onChange={(e) => setBestbuyPass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Proforce Store</label>
              <input
                type="text"
                value={proforceStore}
                onChange={(e) => setProforceStore(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Proforce Customer</label>
              <input
                type="text"
                value={proforceCustomer}
                onChange={(e) => setProforceCustomer(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Proforce Password</label>
              <input
                type="password"
                value={proforcePass}
                onChange={(e) => setProforcePass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Epicor Username</label>
              <input
                type="text"
                value={epicorUser}
                onChange={(e) => setEpicorUser(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Epicor Password</label>
              <input
                type="password"
                value={epicorPass}
                onChange={(e) => setEpicorPass(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">Transbec Invoices (Gmail)</h2>
              <p className="text-sm text-slate-500">
                Pulls Transbec invoice numbers and totals from invoice emails. Requires a Google
                Cloud “Desktop app” OAuth client — paste its Client ID and Secret, then connect.
              </p>
            </div>
            <span
              className={`text-xs font-semibold ${
                gmailConnected ? "text-emerald-600" : "text-amber-600"
              }`}
            >
              {gmailConnected ? `Connected${gmailEmail ? ` · ${gmailEmail}` : ""}` : "Not connected"}
            </span>
          </div>
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Gmail OAuth Client ID</label>
              <input
                type="text"
                value={gmailClientId}
                onChange={(e) => setGmailClientId(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Gmail OAuth Client Secret</label>
              <input
                type="password"
                value={gmailClientSecret}
                onChange={(e) => setGmailClientSecret(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Invoice Sender (from:)</label>
              <input
                type="text"
                placeholder="e.g. noreply@transbec.com"
                value={transbecInvoiceSender}
                onChange={(e) => setTransbecInvoiceSender(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Transbec Subject Contains</label>
              <input
                type="text"
                placeholder="e.g. invoice"
                value={transbecInvoiceSubject}
                onChange={(e) => setTransbecInvoiceSubject(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">BestBuy Sender (from:)</label>
              <input
                type="text"
                placeholder="optional — leave blank to match by subject only"
                value={bestbuyInvoiceSender}
                onChange={(e) => setBestbuyInvoiceSender(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">BestBuy Subject Contains</label>
              <input
                type="text"
                placeholder="BESTBUY INVOICES FOR TODAY"
                value={bestbuyInvoiceSubject}
                onChange={(e) => setBestbuyInvoiceSubject(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">BestBuy Credit Invoice Sender (from:)</label>
              <input
                type="text"
                placeholder="bestautosolution.ca"
                value={bestbuyCreditInvoiceSender}
                onChange={(e) => setBestbuyCreditInvoiceSender(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">BestBuy Credit Invoice Subject Contains</label>
              <input
                type="text"
                placeholder="invoice"
                value={bestbuyCreditInvoiceSubject}
                onChange={(e) => setBestbuyCreditInvoiceSubject(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
              <p className="text-xs text-slate-400">
                Emails with "Order No." in the subject are always ignored, even if this matches them too.
              </p>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">CBK Sender (from:)</label>
              <input
                type="text"
                placeholder="branch_05@cbkauto.com"
                value={cbkInvoiceSender}
                onChange={(e) => setCbkInvoiceSender(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">CBK Subject Contains</label>
              <input
                type="text"
                placeholder="Invoice"
                value={cbkInvoiceSubject}
                onChange={(e) => setCbkInvoiceSubject(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Transbec Credit Memo Sender (from:)</label>
              <input
                type="text"
                placeholder="donotreply@transbec.ca"
                value={transbecCreditInvoiceSender}
                onChange={(e) => setTransbecCreditInvoiceSender(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">Transbec Credit Memo Subject Contains</label>
              <input
                type="text"
                placeholder="Credit Memo"
                value={transbecCreditInvoiceSubject}
                onChange={(e) => setTransbecCreditInvoiceSubject(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
              <p className="text-xs text-slate-400">
                E.g. subject "Credit Memo for T30252 Cust PO" — the PO/reference is read from the subject.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleConnectGmail}
              disabled={gmailConnecting}
              className="px-4 py-2 rounded-lg text-sm font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60"
            >
              {gmailConnecting ? "Connecting…" : gmailConnected ? "Reconnect Gmail" : "Connect Gmail"}
            </button>
            {gmailStatusMsg && (
              <span className="text-xs text-slate-600">{gmailStatusMsg}</span>
            )}
          </div>
          <p className="text-xs text-slate-400">
            Connecting saves these fields, then opens Google in your browser to authorize read-only
            access. Only the invoice sender/subject you set above are searched.
          </p>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">Invoice Printing</h2>
              <p className="text-sm text-slate-500">
                The printer used by the "Print Invoice" button in Order Management. Prints page 1
                of the invoice directly — no dialog, same as Sage's print button.
              </p>
            </div>
            <button
              type="button"
              onClick={refreshPrinters}
              disabled={printersLoading}
              className="px-3 py-2 rounded-lg text-sm font-semibold border bg-white text-slate-700 hover:bg-slate-50 disabled:opacity-60"
            >
              {printersLoading ? "Refreshing…" : "Refresh Printers"}
            </button>
          </div>
          <div className="flex flex-col gap-1 max-w-sm">
            <label className="text-xs uppercase tracking-wide text-slate-500">Printer</label>
            <select
              value={invoicePrinter}
              onChange={(e) => setInvoicePrinter(e.target.value)}
              className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
            >
              <option value="">System default</option>
              {printerOptions.map((p) => (
                <option key={p.name} value={p.name}>
                  {p.displayName}
                  {p.isDefault ? " (default)" : ""}
                </option>
              ))}
            </select>
          </div>
          {printersError && <p className="text-xs text-red-600">{printersError}</p>}
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleSaveCreds}
              disabled={credSaving}
              className="px-4 py-2 rounded-lg text-sm font-semibold border bg-white text-indigo-700 border-indigo-200 hover:bg-indigo-50 disabled:opacity-60"
            >
              {credSaving ? "Saving..." : "Save"}
            </button>
            {credStatus && <span className="text-xs text-emerald-600">{credStatus}</span>}
            {credError && <span className="text-xs text-red-600">{credError}</span>}
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">AutoHotkey Configuration</h2>
              <p className="text-sm text-slate-500">
                AutoHotkey must be installed separately. Select AutoHotkey64.exe.
              </p>
            </div>
            <span
              className={`text-xs font-semibold ${
                ahkValid ? "text-emerald-600" : ahkPath ? "text-red-600" : "text-amber-600"
              }`}
            >
              {ahkStatus}
            </span>
          </div>
          <div className="flex gap-2">
            <input
              className="flex-1 rounded-lg border border-slate-200 px-3 py-2 text-sm font-mono"
              value={ahkPath}
              onChange={(e) => setAhkPath(e.target.value)}
              onBlur={(e) => refreshAhkStatus(e.target.value)}
              placeholder="C:\\Program Files\\AutoHotkey\\AutoHotkey64.exe"
            />
            <button
              type="button"
              className="px-3 py-2 rounded-lg border border-slate-300 text-sm font-semibold text-slate-700 hover:bg-white"
              onClick={handleBrowseAhk}
            >
              Browse...
            </button>
          </div>
        </div>
      </Card>

      <Card>
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Automation</h2>
            <p className="text-sm text-slate-500">
              Control Sage automation timeouts and item write behavior.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Sage AHK Timeout (seconds)
              </label>
              <input
                type="number"
                min="10"
                step="1"
                value={sageTimeoutSeconds}
                onChange={(e) => setSageTimeoutSeconds(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
              {timeoutError && (
                <div className="text-xs text-red-600">{timeoutError}</div>
              )}
              <div className="text-xs text-slate-500">
                Minimum 10 seconds. Default is 300 seconds (5 minutes).
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Replace Items On Write
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={itemsReplaceAll}
                  onChange={(e) => setItemsReplaceAll(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span
                  title="If you send a partial list of items while this is enabled, any items missing from the list will be deleted from disk."
                >
                  When enabled, incoming items replace the full queue set.
                </span>
              </label>
              <div className="text-xs text-slate-500">
                Disable for partial updates that should not delete missing items.
              </div>
            </div>
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
                {sharedBubblePath && (
                  <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 sm:col-span-2">
                    <div className="text-xs font-semibold text-slate-700">Bubble notes & extras (shared)</div>
                    <div className="text-[11px] font-mono break-all text-slate-600">{sharedBubblePath}</div>
                    <div
                      className={`text-xs font-semibold ${
                        sharedBubbleExists ? "text-emerald-600" : "text-red-600"
                      }`}
                    >
                      {sharedBubbleExists ? "Exists" : "Missing"}
                    </div>
                  </div>
                )}
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

      <Card>
        <div className="space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">Application Updates</h2>
              <p className="text-sm text-slate-500">Manually check for updates to this application.</p>
            </div>
            <div className="text-xs text-slate-500">
              {lastChecked ? `Last checked: ${new Date(lastChecked).toLocaleString()}` : "Not checked yet"}
            </div>
          </div>
          <div className="flex items-center gap-3 flex-wrap">
            <button
              type="button"
              onClick={handleCheckForUpdates}
              disabled={updateStatus === "checking" || updateStatus === "downloading"}
              className="px-4 py-2 rounded-full bg-indigo-600 text-white text-sm font-semibold disabled:opacity-50"
            >
              {updateStatus === "checking"
                ? "Checking..."
                : updateStatus === "downloading"
                ? "Downloading..."
                : "Check for Updates"}
            </button>
            <div className="text-sm text-slate-700">
              {updateMessage || "Updates have not been checked yet."}
              {updateVersion ? ` (Latest: ${updateVersion})` : ""}
            </div>
            {updateStatus === "downloaded" && (
              <button
                type="button"
                onClick={handleRestartToUpdate}
                className="px-4 py-2 rounded-full bg-emerald-600 text-white text-sm font-semibold"
              >
                Restart to Update
              </button>
            )}
          </div>
        </div>
      </Card>
    </div>
  );
}
