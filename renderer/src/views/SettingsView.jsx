import React, { useEffect, useMemo, useState } from "react";
import api from "../api";
import Card from "../components/Card";
import { nextGhostCycleAt, sagePoMachine } from "../utils/ghostMode";
import { AUTOMATION_ROLES, ROLE_HELP, ROLE_LABELS } from "../utils/automation";

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

// "10:30 AM", or "tomorrow at 8:00 AM" once the day's last cycle has gone.
function formatGhostTime(when, now = new Date()) {
  const clock = when.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return when.getDate() === now.getDate() ? clock : `${clock} tomorrow`;
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
  const [scrapersHeadless, setScrapersHeadless] = useState(false);
  const [qtyDiscrepancyThreshold, setQtyDiscrepancyThreshold] = useState(15);
  const [qtyDiscrepancyTaxRatePercent, setQtyDiscrepancyTaxRatePercent] = useState(13);
  // Ghost mode saves the moment it is clicked rather than waiting for the Save
  // button at the top of the page: it arms an unattended routine, so leaving it
  // looking on while it is still off on disk is the one thing this toggle must
  // never do. `ghostSageMachine` is the other half of the answer to "and then
  // what?" — the cycle does nothing at all unless another machine is running
  // Sage purchase orders.
  const [ghostMode, setGhostMode] = useState(false);
  const [ghostSaving, setGhostSaving] = useState(false);
  const [ghostError, setGhostError] = useState("");
  const [ghostSageMachine, setGhostSageMachine] = useState("");
  const [ownMachineId, setOwnMachineId] = useState("");
  const [automationMachines, setAutomationMachines] = useState([]);
  const [automationRoles, setAutomationRoles] = useState({ fetch: "", print: "", sage: "" });
  const [roleSaving, setRoleSaving] = useState("");
  const [roleError, setRoleError] = useState("");
  // Re-rendered every half minute while armed, so "next cycle at ..." can't sit
  // there naming a time that has already gone by.
  const [ghostNow, setGhostNow] = useState(() => new Date());
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
  const [worldInvoiceSender, setWorldInvoiceSender] = useState("");
  const [worldInvoiceSubject, setWorldInvoiceSubject] = useState("");
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
  // Credential hand-off between machines. `sentGrant` holds the pairing code
  // for the machine that just sent — it is the only copy that will ever exist,
  // so it stays on screen until dismissed.
  const [syncRequests, setSyncRequests] = useState([]);
  const [syncInbound, setSyncInbound] = useState(null);
  const [syncOutgoingCount, setSyncOutgoingCount] = useState(0);
  const [sentGrant, setSentGrant] = useState(null);
  const [redeemCode, setRedeemCode] = useState("");
  const [syncBusy, setSyncBusy] = useState("");
  const [syncMsg, setSyncMsg] = useState("");
  const [syncError, setSyncError] = useState("");
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

  useEffect(() => {
    if (!ghostMode) return;
    const id = setInterval(() => setGhostNow(new Date()), 30 * 1000);
    return () => clearInterval(id);
  }, [ghostMode]);

  async function refreshGhostSageMachine() {
    try {
      const res = await api.getSageLock?.();
      setGhostSageMachine(sagePoMachine(res));
      setOwnMachineId(res?.ownMachineId || "");
    } catch (e) {
      setGhostSageMachine("");
    }
  }

  async function refreshAutomation() {
    try {
      const [rolesRes, machinesRes] = await Promise.all([
        api.getAutomationRoles?.(),
        api.listAutomationMachines?.(),
      ]);
      if (rolesRes?.ok) setAutomationRoles(rolesRes.roles || {});
      if (machinesRes?.ok) {
        setAutomationMachines(machinesRes.machines || []);
        if (machinesRes.ownMachineId) setOwnMachineId(machinesRes.ownMachineId);
      }
    } catch (e) {
      console.error("[automation] settings refresh failed", e);
    }
  }

  async function handleRoleChange(role, machineId) {
    setRoleSaving(role);
    setRoleError("");
    try {
      const res = await api.setAutomationRoles?.({ [role]: machineId });
      if (!res?.ok) throw new Error(res?.error || "Failed to save the assignment.");
      setAutomationRoles(res.roles || {});
      // The Sage role switches a machine's PO toggle, and the lock takes a
      // moment to change hands — re-read rather than showing the old owner.
      if (role === "sage") setTimeout(refreshGhostSageMachine, 1500);
    } catch (e) {
      setRoleError(e?.message || "Failed to save the assignment.");
    } finally {
      setRoleSaving("");
    }
  }

  // Written straight to disk on click. Everything else in the Automation card
  // waits for Save; this one cannot, because the gap between "the box is
  // ticked" and "the machine is actually doing it" is the whole feature.
  async function handleGhostModeToggle(next) {
    setGhostMode(next);
    setGhostError("");
    setGhostSaving(true);
    try {
      const res = await api.setAppConfig({ ghostMode: Boolean(next) });
      if (!res?.ok) throw new Error(res?.error || "Failed to save Ghost Mode.");
      setGhostNow(new Date());
      if (next) await refreshGhostSageMachine();
    } catch (e) {
      // Put the box back where disk says it is, rather than leaving it looking
      // armed when nothing was saved.
      setGhostMode(!next);
      setGhostError(e?.message || "Failed to save Ghost Mode.");
    } finally {
      setGhostSaving(false);
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
      setScrapersHeadless(res.config?.scrapersHeadless === true);
      const qtyThresholdRaw = Number(res.config?.qtyDiscrepancyThreshold);
      setQtyDiscrepancyThreshold(Number.isFinite(qtyThresholdRaw) && qtyThresholdRaw >= 0 ? qtyThresholdRaw : 15);
      setGhostMode(res.config?.ghostMode === true);
      setGhostError("");
      refreshGhostSageMachine();
      refreshAutomation();
      const qtyTaxRateRaw = Number(res.config?.qtyDiscrepancyTaxRate);
      setQtyDiscrepancyTaxRatePercent(
        Number.isFinite(qtyTaxRateRaw) && qtyTaxRateRaw >= 0 && qtyTaxRateRaw <= 1
          ? Math.round(qtyTaxRateRaw * 1000) / 10
          : 13
      );
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
          setWorldInvoiceSender(cfg.WORLD_INVOICE_SENDER || "");
          setWorldInvoiceSubject(cfg.WORLD_INVOICE_SUBJECT || "");
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
        scrapersHeadless: Boolean(scrapersHeadless),
        qtyDiscrepancyThreshold:
          Number.isFinite(Number(qtyDiscrepancyThreshold)) && Number(qtyDiscrepancyThreshold) >= 0
            ? Number(qtyDiscrepancyThreshold)
            : 15,
        qtyDiscrepancyTaxRate:
          Number.isFinite(Number(qtyDiscrepancyTaxRatePercent)) && Number(qtyDiscrepancyTaxRatePercent) >= 0
            ? Number(qtyDiscrepancyTaxRatePercent) / 100
            : 0.13,
        ghostMode: Boolean(ghostMode),
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
        WORLD_INVOICE_SENDER: worldInvoiceSender || "",
        WORLD_INVOICE_SUBJECT: worldInvoiceSubject || "",
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

  // ---- credential hand-off between machines --------------------------------

  // One poll for both sides of the exchange: this machine may be waiting on a
  // grant AND holding somebody else's request at the same time.
  async function refreshCredSync() {
    try {
      const [reqs, inbound, outgoing] = await Promise.all([
        api.listCredentialRequests?.(),
        api.getCredentialInboundStatus?.(),
        api.previewOutgoingCredentials?.(),
      ]);
      if (reqs?.ok) setSyncRequests(reqs.requests || []);
      if (inbound?.ok) setSyncInbound(inbound);
      if (outgoing?.ok) setSyncOutgoingCount(outgoing.count || 0);
    } catch (e) {
      console.warn("[settings] credential sync refresh failed", e);
    }
  }

  async function runCredSync(key, fn, onDone) {
    setSyncBusy(key);
    setSyncError("");
    setSyncMsg("");
    try {
      const res = await fn();
      if (res?.ok) {
        onDone?.(res);
      } else {
        setSyncError(res?.error || "Failed.");
      }
    } catch (e) {
      setSyncError(e?.message || "Failed.");
    } finally {
      setSyncBusy("");
      await refreshCredSync();
    }
  }

  function handleRequestCreds() {
    return runCredSync("request", () => api.requestCredentials?.(), () =>
      setSyncMsg("Request posted. Ask someone at a configured machine to open Settings and send.")
    );
  }

  function handleCancelRequest() {
    return runCredSync("cancel", () => api.cancelCredentialRequest?.(), () =>
      setSyncMsg("Request withdrawn.")
    );
  }

  // The code comes back exactly once, in this response. It is not stored on the
  // share and cannot be re-read — losing it means sending again.
  function handleSendCreds(machineId) {
    return runCredSync(`send:${machineId}`, () => api.sendCredentials?.(machineId), (res) =>
      setSentGrant(res)
    );
  }

  function handleRevokeGrant(machineId) {
    return runCredSync(`revoke:${machineId}`, () => api.revokeCredentialGrant?.(machineId), () => {
      setSentGrant(null);
      setSyncMsg("Transfer cancelled.");
    });
  }

  function handleRedeem() {
    return runCredSync("redeem", () => api.redeemCredentials?.(redeemCode), (res) => {
      setRedeemCode("");
      setSyncMsg(`Imported ${res.count} setting(s) from ${res.from || "the other machine"}.`);
      // Pull the freshly imported values into the fields above, and re-check
      // Gmail — the refresh token may have just arrived.
      load();
    });
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

  // Credential requests arrive as files another machine drops on the share.
  // Polling while this view is open is enough — a hand-off is a two-person
  // operation that both people are already watching, so it doesn't warrant a
  // watcher and an IPC push channel.
  useEffect(() => {
    refreshCredSync();
    const id = setInterval(refreshCredSync, 10000);
    return () => clearInterval(id);
  }, []);

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
                Stored per-machine in app data. Used by World, Transbec, CBK, Tiger, BestBuy, and Proforce scrapers.
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
              <label className="text-xs uppercase tracking-wide text-slate-500">World Sender (from:)</label>
              <input
                type="text"
                placeholder="e.g. reports@groupe-monaco.ca"
                value={worldInvoiceSender}
                onChange={(e) => setWorldInvoiceSender(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">World Subject Contains</label>
              <input
                type="text"
                placeholder="e.g. Invoice for 20605"
                value={worldInvoiceSubject}
                onChange={(e) => setWorldInvoiceSubject(e.target.value)}
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
        <div className="space-y-4">
          <div>
            <h2 className="text-xl font-semibold text-slate-800">Share Credentials With Another Machine</h2>
            <p className="text-sm text-slate-500">
              Copies the scraper logins and Gmail connection above to another workstation, so you
              don't retype them. The invoice printer stays per-machine and is never sent.
            </p>
          </div>

          {(syncError || syncMsg) && (
            <div
              className={`rounded-lg border px-3 py-2 text-sm ${
                syncError
                  ? "border-red-200 bg-red-50 text-red-700"
                  : "border-emerald-200 bg-emerald-50 text-emerald-700"
              }`}
            >
              {syncError || syncMsg}
            </div>
          )}

          {syncInbound && syncInbound.sharedConfigured === false && (
            <div className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-800">
              Set a shared data folder above before machines can hand credentials to each other.
            </div>
          )}

          {/* The pairing code. Shown once, never written down by the app. */}
          {sentGrant && (
            <div className="rounded-xl border-2 border-indigo-300 bg-indigo-50 p-4 space-y-2">
              <div className="text-sm font-semibold text-indigo-900">
                Read this code to whoever is at {sentGrant.to}
              </div>
              <div className="font-mono text-4xl tracking-[0.3em] text-indigo-900">
                {String(sentGrant.code).slice(0, 3)} {String(sentGrant.code).slice(3)}
              </div>
              <div className="text-xs text-indigo-800">
                {sentGrant.count} setting(s) sent, encrypted. They cannot be read without this code,
                and it is not stored anywhere — if it's lost, just send again. Expires{" "}
                {sentGrant.expiresAt ? new Date(sentGrant.expiresAt).toLocaleTimeString() : "shortly"}.
              </div>
              <div className="flex items-center gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setSentGrant(null)}
                  className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700"
                >
                  Done
                </button>
                <button
                  type="button"
                  onClick={() => handleRevokeGrant(sentGrant.to)}
                  disabled={syncBusy === `revoke:${sentGrant.to}`}
                  className="px-3 py-1.5 rounded-lg border border-indigo-300 text-indigo-700 text-xs font-semibold hover:bg-white disabled:opacity-60"
                >
                  Cancel transfer
                </button>
              </div>
            </div>
          )}

          {/* Sending side: requests other machines have posted. */}
          <div className="space-y-2">
            <div className="text-xs uppercase tracking-wide text-slate-500">
              Requests from other machines
            </div>
            {syncRequests.length === 0 ? (
              <div className="text-sm text-slate-400">None waiting.</div>
            ) : (
              syncRequests.map((req) => (
                <div
                  key={req.machineId}
                  className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2"
                >
                  <div>
                    <div className="text-sm font-semibold text-slate-800">{req.machineId}</div>
                    <div className="text-xs text-slate-500">
                      Asked {req.requestedAt ? new Date(req.requestedAt).toLocaleString() : "recently"}
                      {req.missingKeys?.length ? ` · missing ${req.missingKeys.length} setting(s)` : ""}
                      {req.awaitingCode ? " · sent, waiting for them to enter the code" : ""}
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    {req.awaitingCode && (
                      <button
                        type="button"
                        onClick={() => handleRevokeGrant(req.machineId)}
                        disabled={syncBusy === `revoke:${req.machineId}`}
                        className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-60"
                      >
                        Cancel
                      </button>
                    )}
                    {/* Never disabled on a zero count: a click that does
                        nothing is indistinguishable from a broken button, so
                        let the send run and surface whatever it says. */}
                    <button
                      type="button"
                      onClick={() => handleSendCreds(req.machineId)}
                      disabled={syncBusy === `send:${req.machineId}`}
                      title={`This machine has ${syncOutgoingCount} shareable setting(s) saved`}
                      className="px-3 py-1.5 rounded-lg bg-indigo-600 text-white text-xs font-semibold hover:bg-indigo-700 disabled:opacity-60"
                    >
                      {syncBusy === `send:${req.machineId}`
                        ? "Sending…"
                        : req.awaitingCode
                        ? "Send again"
                        : `Send ${syncOutgoingCount} setting(s)`}
                    </button>
                  </div>
                </div>
              ))
            )}
          </div>

          {/* Receiving side. */}
          <div className="space-y-2 border-t border-slate-200 pt-4">
            <div className="text-xs uppercase tracking-wide text-slate-500">This machine</div>

            {syncInbound?.grant ? (
              <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-3 space-y-2">
                <div className="text-sm text-emerald-900">
                  <span className="font-semibold">{syncInbound.grant.from}</span> sent{" "}
                  {syncInbound.grant.keys?.length || 0} setting(s). Enter the 6-digit code shown on
                  that machine.
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <input
                    type="text"
                    inputMode="numeric"
                    maxLength={7}
                    value={redeemCode}
                    onChange={(e) => setRedeemCode(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") handleRedeem();
                    }}
                    placeholder="000000"
                    className="w-32 rounded-lg border border-emerald-300 px-3 py-2 font-mono text-lg tracking-widest text-slate-800"
                  />
                  <button
                    type="button"
                    onClick={handleRedeem}
                    disabled={syncBusy === "redeem"}
                    className="px-4 py-2 rounded-lg bg-emerald-600 text-white text-sm font-semibold hover:bg-emerald-700 disabled:opacity-60"
                  >
                    {syncBusy === "redeem" ? "Importing…" : "Import"}
                  </button>
                  <span className="text-xs text-emerald-800">
                    {syncInbound.grant.attemptsLeft} attempt(s) left · expires{" "}
                    {syncInbound.grant.expiresAt
                      ? new Date(syncInbound.grant.expiresAt).toLocaleTimeString()
                      : "shortly"}
                  </span>
                </div>
              </div>
            ) : syncInbound?.request ? (
              <div className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
                <div className="text-sm text-slate-700">
                  Waiting for another machine to send. Asked{" "}
                  {syncInbound.request.requestedAt
                    ? new Date(syncInbound.request.requestedAt).toLocaleString()
                    : "just now"}
                  .
                </div>
                <button
                  type="button"
                  onClick={handleCancelRequest}
                  disabled={syncBusy === "cancel"}
                  className="px-3 py-1.5 rounded-lg border border-slate-300 text-slate-700 text-xs font-semibold hover:bg-white disabled:opacity-60"
                >
                  Withdraw
                </button>
              </div>
            ) : (
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleRequestCreds}
                  disabled={syncBusy === "request" || syncInbound?.sharedConfigured === false}
                  className="px-4 py-2 rounded-lg border border-indigo-200 bg-white text-indigo-700 text-sm font-semibold hover:bg-indigo-50 disabled:opacity-60"
                >
                  {syncBusy === "request" ? "Requesting…" : "Request Credentials"}
                </button>
                <span className="text-xs text-slate-500">
                  Posts a request other machines see here. They send; you enter the code they read
                  you.
                </span>
              </div>
            )}
          </div>
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
          <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-xl font-semibold text-slate-800">Machines &amp; roles</h2>
              <p className="text-sm text-slate-500">
                Which computer does each part of the work. Set here, applies everywhere - any
                machine can hand its work to the machine that owns the job.
              </p>
            </div>
            <button
              type="button"
              onClick={refreshAutomation}
              className="shrink-0 px-3 py-1.5 rounded-full border border-slate-300 text-xs font-semibold text-slate-700 hover:bg-white"
            >
              Refresh
            </button>
          </div>

          {roleError && (
            <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
              {roleError}
            </div>
          )}

          <div className="grid gap-3 sm:grid-cols-3">
            {AUTOMATION_ROLES.map((role) => {
              const assigned = automationRoles?.[role] || "";
              const assignedMachine = automationMachines.find((m) => m.machineId === assigned);
              const assignedOffline = Boolean(assigned) && !assignedMachine?.online;
              return (
                <div key={role} className="flex flex-col gap-1">
                  <label className="text-xs uppercase tracking-wide text-slate-500">
                    {ROLE_LABELS[role]}
                  </label>
                  <select
                    value={assigned}
                    disabled={roleSaving === role}
                    onChange={(e) => handleRoleChange(role, e.target.value)}
                    className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800 disabled:opacity-60"
                  >
                    <option value="">Whoever asks (no fixed machine)</option>
                    {automationMachines.map((m) => (
                      <option key={m.machineId} value={m.machineId}>
                        {m.machineId}
                        {m.isSelf ? " (this machine)" : ""}
                        {m.online ? "" : " - offline"}
                      </option>
                    ))}
                    {/* A machine assigned before it dropped off the share still
                        has to be visible, or the dropdown would silently show
                        the wrong owner. */}
                    {assigned && !assignedMachine && (
                      <option value={assigned}>{assigned} - not seen recently</option>
                    )}
                  </select>
                  {assignedOffline && (
                    <div className="text-xs text-amber-600">
                      Offline - this step will be skipped until it is back.
                    </div>
                  )}
                  <div className="text-xs text-slate-500">{ROLE_HELP[role]}</div>
                </div>
              );
            })}
          </div>

          <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
            <div className="font-semibold text-slate-700">
              On the share now ({automationMachines.filter((m) => m.online).length} online)
            </div>
            {automationMachines.length === 0 ? (
              <div className="mt-1">
                No machines have checked in yet. Each one announces itself a few seconds after it
                starts.
              </div>
            ) : (
              <ul className="mt-1 space-y-0.5">
                {automationMachines.map((m) => (
                  <li key={m.machineId} className="flex items-center gap-2">
                    <span
                      className={`inline-block h-2 w-2 rounded-full ${
                        m.online ? "bg-emerald-500" : "bg-slate-300"
                      }`}
                    />
                    <span className={m.isSelf ? "font-semibold text-slate-800" : ""}>
                      {m.machineId}
                      {m.isSelf ? " (this machine)" : ""}
                    </span>
                    {m.appVersion && <span className="text-slate-400">v{m.appVersion}</span>}
                    {AUTOMATION_ROLES.filter((r) => automationRoles?.[r] === m.machineId).map((r) => (
                      <span
                        key={r}
                        className="rounded-full border border-indigo-200 bg-indigo-50 px-2 text-[11px] text-indigo-700"
                      >
                        {r}
                      </span>
                    ))}
                  </li>
                ))}
              </ul>
            )}
            <div className="mt-2">
              A machine only does work for others while its app is open. Nothing here grants access
              to anything - it only says who runs which step.
            </div>
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
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Scraper Browser Visibility
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={scrapersHeadless}
                  onChange={(e) => setScrapersHeadless(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>Run scraper logins headless (no visible browser window)</span>
              </label>
              <div className="text-xs text-slate-500">
                Applies to World, Transbec, CBK, Tiger, BestBuy, and Proforce order fetches.
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Qty Discrepancy Threshold ($)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={qtyDiscrepancyThreshold}
                onChange={(e) => setQtyDiscrepancyThreshold(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
              <div className="text-xs text-slate-500">
                When a confirmed billed total is off from the line items total by more than this,
                Order Management shows a "Confirm Quantities" button instead of "Send to Sage".
              </div>
            </div>
            <div className="flex flex-col gap-1">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Qty Discrepancy Tax Rate (%)
              </label>
              <input
                type="number"
                min="0"
                step="0.01"
                value={qtyDiscrepancyTaxRatePercent}
                onChange={(e) => setQtyDiscrepancyTaxRatePercent(e.target.value)}
                className="rounded-lg border border-slate-200 px-3 py-2 text-sm text-slate-800"
              />
              <div className="text-xs text-slate-500">
                Tax rate used only to estimate the expected total from line items for the check
                above (default 13%, Ontario HST).
              </div>
            </div>
            <div className="flex flex-col gap-1 sm:col-span-2">
              <label className="text-xs uppercase tracking-wide text-slate-500">
                Ghost Mode
              </label>
              <label className="inline-flex items-center gap-2 text-sm text-slate-700">
                <input
                  type="checkbox"
                  checked={ghostMode}
                  disabled={ghostSaving}
                  onChange={(e) => handleGhostModeToggle(e.target.checked)}
                  className="h-4 w-4 rounded border-slate-300"
                />
                <span>
                  Run the Order Management routine by itself, every 30 minutes between 8am and 5pm
                </span>
              </label>
              {ghostError ? (
                <div className="rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700">
                  {ghostError}
                </div>
              ) : ghostMode ? (
                <div className="rounded-lg border border-violet-200 bg-violet-50 px-3 py-2 text-xs text-violet-700 space-y-1">
                  <div className="font-semibold">
                    On. Next cycle at {formatGhostTime(nextGhostCycleAt(ghostNow))}
                    {ghostSaving ? " (saving...)" : ""}
                  </div>
                  <div>
                    {!ghostSageMachine
                      ? "No machine is running Sage purchase orders right now, so cycles will skip until one is given the Sage role above."
                      : ghostSageMachine === ownMachineId
                      ? "This machine is doing the Sage entry, so the cycle will run."
                      : `${ghostSageMachine} is doing the Sage entry, so the cycle will run.`}
                  </div>
                  <div>
                    Each step runs on the machine given that role above - fetching here, printing
                    there - and this machine drives the sequence.
                  </div>
                  <div>
                    Watch it work in Order Management - the Order Fetcher card shows the step it is
                    on, what the last cycle did, and a "Run one now" button if you'd rather not
                    wait for the next half hour. Leave this app open; nothing runs while it is
                    closed.
                  </div>
                </div>
              ) : (
                <div className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
                  Off. Saved as soon as you tick it - no need to press Save.
                </div>
              )}
              <div className="text-xs text-slate-500">
                Each cycle runs strictly in order: Get All (every vendor), check Gmail for World
                and Transbec invoices, queue every order that now has an invoice and isn't in Sage
                yet and send the queue, wait for Sage to actually finish entering it, and only
                then print. Tiger is pulled twice a day (8am and noon) and BestBuy's invoice email
                arrives the next day, so that gets one Gmail check a day from noon. Printing covers
                Transbec and BestBuy invoices that have never been printed — never World.
              </div>
              <div className="text-xs text-slate-500">
                Only runs while ANOTHER machine has Sage purchase orders ("Run Sage") switched on
                — this machine fills the queue, that one types it in. Off on every machine until
                you turn it on here, and it only runs while this app is open.
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
