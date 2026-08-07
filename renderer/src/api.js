// src/api.js
const notElectron = () =>
  ({ ok: false, reason: "not-electron", error: "This feature requires the Electron app." });

const warn = (method) => () => {
  console.warn(`[api] ${method} called outside Electron`);
  return notElectron();
};
const warnEvent = (method) => () => {
  console.warn(`[api] ${method} called outside Electron`);
  return () => {};
};

const warnAsync = (method, fallback) => async (...args) => {
  console.warn(`[api] ${method} called outside Electron`, { args });
  return fallback ? fallback(...args) : notElectron();
};

const fallbackApi = {
  debugLog: (...args) => console.log("[renderer]", ...args),
  readItems: async () => [],
  writeItems: warnAsync("writeItems"),
  readItemHistory: warnAsync("readItemHistory", async () => ({ ok: false, history: [] })),
  exportItems: warnAsync("exportItems"),
  onItemsUpdated: warnEvent("onItemsUpdated"),

  // Replicated store — concurrent-edit review.
  readConflicts: warnAsync("readConflicts", async () => ({ ok: true, conflicts: [] })),
  dismissConflict: warnAsync("dismissConflict", async () => ({ ok: true, conflicts: [] })),
  dismissAllConflicts: warnAsync("dismissAllConflicts", async () => ({ ok: true, conflicts: [] })),
  readStoreStats: warnAsync("readStoreStats", async () => ({ ok: false })),
  onConflicts: warnEvent("onConflicts"),
  onPaymentsUpdated: warnEvent("onPaymentsUpdated"),
  getDataPath: warnAsync("getDataPath", async () => ({ path: "(not in Electron)" })),
  revealDataFile: warnAsync("revealDataFile"),
  chooseItemsFile: warnAsync("chooseItemsFile"),
  useDefaultFile: warnAsync("useDefaultFile"),



  // NEW ---- locking fallbacks


  readOrders: async () => [],
  getOrderArrivalMap: warnAsync("getOrderArrivalMap", async () => ({ ok: true, map: {} })),
  writeOrders: warnAsync("writeOrders"),
  triggerOrderSage: warnAsync("triggerOrderSage"),
  sendSageQueue: warnAsync("sendSageQueue"),
  releaseOrderSageLock: warnAsync("releaseOrderSageLock"),
  setSagePoActive: warnAsync("setSagePoActive"),
  setSageInvoiceActive: warnAsync("setSageInvoiceActive"),
  onOrdersUpdated: warnEvent("onOrdersUpdated"),
  getOrdersPath: warnAsync("getOrdersPath", async () => ({ path: "(not in Electron)" })),
  readPayments: async () => [],
  writePayments: warnAsync("writePayments"),
  getPaymentsPath: warnAsync("getPaymentsPath", async () => ({ path: "(not in Electron)" })),
  openClover: warnAsync("openClover"),
  scrapeCloverPayments: warnAsync("scrapeCloverPayments", async () => ({ ok: false, imported: 0, payments: [] })),
  getCloverLedgerSummary: warnAsync("getCloverLedgerSummary", async () => ({ ok: true, total: 0, imported: 0 })),
  forgetMistypedClover: warnAsync("forgetMistypedClover", async () => ({ ok: true, removed: 0 })),
  closeClover: warnAsync("closeClover"),
  getCloverStatus: warnAsync("getCloverStatus", async () => ({ ok: true, open: false })),
  fetchWorldOrders: warnAsync("fetchWorldOrders"),
  fetchCbkOrders: warnAsync("fetchCbkOrders"),
  fetchTigerOrders: warnAsync("fetchTigerOrders"),
  fetchBestBuyOrders: warnAsync("fetchBestBuyOrders"),
  fetchWorldInvoices: warnAsync("fetchWorldInvoices"),
  openWorldInvoiceImage: warnAsync("openWorldInvoiceImage"),
  readWorldInvoiceImage: warnAsync("readWorldInvoiceImage"),
  fetchTransbecInvoices: warnAsync("fetchTransbecInvoices"),
  connectGmail: warnAsync("connectGmail"),
  getGmailStatus: warnAsync("getGmailStatus", async () => ({ ok: true, connected: false })),
  openTransbecInvoiceImage: warnAsync("openTransbecInvoiceImage"),
  readTransbecInvoiceImage: warnAsync("readTransbecInvoiceImage"),
  fetchBestbuyInvoices: warnAsync("fetchBestbuyInvoices"),
  openBestbuyInvoiceImage: warnAsync("openBestbuyInvoiceImage"),
  readBestbuyInvoiceImage: warnAsync("readBestbuyInvoiceImage"),
  fetchBestbuyCreditInvoices: warnAsync("fetchBestbuyCreditInvoices"),
  fetchTransbecCreditInvoices: warnAsync("fetchTransbecCreditInvoices"),
  getTransbecCredits: warnAsync("getTransbecCredits", async () => ({ ok: true, credits: [] })),
  resetTransbecCredits: warnAsync("resetTransbecCredits"),
  fetchCbkInvoices: warnAsync("fetchCbkInvoices"),
  openCbkInvoiceImage: warnAsync("openCbkInvoiceImage"),
  readCbkInvoiceImage: warnAsync("readCbkInvoiceImage"),
  printInvoiceSilent: warnAsync("printInvoiceSilent"),
  listPrinters: warnAsync("listPrinters", async () => ({ ok: true, printers: [] })),
  reconcileTotals: warnAsync("reconcileTotals"),
  addOrdersToOutstanding: warnAsync("addOrdersToOutstanding"),
  archiveOrders: warnAsync("archiveOrders"),
  archiveOrder: warnAsync("archiveOrder"),
  deleteOrder: warnAsync("deleteOrder"),
  confirm: async (message) => window.confirm(message),
  searchOrdersArchive: warnAsync("searchOrdersArchive", async () => ({ ok: false, results: [] })),
  addArchiveLineToCashSales: warnAsync("addArchiveLineToCashSales", async () => ({ ok: false })),
  purgeOldOrdersArchive: warnAsync("purgeOldOrdersArchive", async () => ({ ok: false, removed: 0 })),
  readOrderAssignments: warnAsync("readOrderAssignments", async () => ({ ok: false, orders: [] })),
  setOrderAssignmentResolved: warnAsync("setOrderAssignmentResolved"),
  resolveOrderAssignmentsBefore: warnAsync("resolveOrderAssignmentsBefore"),
  assignOrderLine: warnAsync("assignOrderLine"),
  unassignOrderLine: warnAsync("unassignOrderLine"),
  unassignOrderItem: warnAsync("unassignOrderItem"),
  archiveBubble: warnAsync("archiveBubble"),
  appendPrintSnapshot: warnAsync("appendPrintSnapshot"),
  findPrintSnapshots: warnAsync("findPrintSnapshots", async () => ({ ok: false, snapshots: [] })),
  searchArchive: warnAsync("searchArchive", async () => ({ ok: false, results: [] })),
  locatePart: warnAsync("locatePart", async () => ({
    ok: false,
    live: [],
    archived: [],
    purchases: [],
    history: [],
  })),
  getArchivedPaymentUsage: warnAsync("getArchivedPaymentUsage", async () => ({ ok: false, usage: {} })),
  readSageRuns: warnAsync("readSageRuns", async () => ({ ok: false, runs: [] })),
  appendSageRun: warnAsync("appendSageRun"),
  setSageRunInvoice: warnAsync("setSageRunInvoice"),
  deleteSageRun: warnAsync("deleteSageRun"),
  getArchivePath: warnAsync("getArchivePath", async () => ({ path: "(not in Electron)" })),
  getAppVersion: warnAsync("getAppVersion"),
  sageSalesInvoice: warnAsync("sageSalesInvoice"),
  getAhkExePath: warnAsync("getAhkExePath"),
  setAhkExePath: warnAsync("setAhkExePath"),
  chooseAhkExePath: warnAsync("chooseAhkExePath", async () => ({ ok: false, canceled: true })),
  validateAhkExePath: warnAsync("validateAhkExePath"),
  checkForUpdates: warnAsync("checkForUpdates"),
  restartToUpdate: warnAsync("restartToUpdate"),
  onUpdateStatus: warnEvent("onUpdateStatus"),
  getSageLock: warnAsync("getSageLock", async () => ({ ok: false, lock: null, ownMachineId: null })),
  onSageLockChanged: warnEvent("onSageLockChanged"),
  readConfig: warnAsync("readConfig", async () => ({ ok: false, config: {}, raw: {}, overrides: {} })),
  writeConfig: warnAsync("writeConfig"),
  getAppConfig: warnAsync("getAppConfig"),
  setAppConfig: warnAsync("setAppConfig"),
  chooseSharedFolderDialog: warnAsync("chooseSharedFolderDialog"),
  getResolvedBusinessPaths: warnAsync("getResolvedBusinessPaths"),
  getResolvedPathsSummary: warnAsync("getResolvedPathsSummary"),
  validateSharedFolderWritable: warnAsync("validateSharedFolderWritable"),
  migrateBusinessFilesToShared: warnAsync("migrateBusinessFilesToShared"),
  getConfig: warnAsync("getConfig", async () => ({ ok: false, config: {} })),
  setConfig: warnAsync("setConfig"),
  requestCredentials: warnAsync("requestCredentials"),
  cancelCredentialRequest: warnAsync("cancelCredentialRequest"),
  getCredentialInboundStatus: warnAsync("getCredentialInboundStatus", async () => ({
    ok: true,
    sharedConfigured: false,
    request: null,
    grant: null,
  })),
  redeemCredentials: warnAsync("redeemCredentials"),
  listCredentialRequests: warnAsync("listCredentialRequests", async () => ({
    ok: true,
    sharedConfigured: false,
    requests: [],
  })),
  sendCredentials: warnAsync("sendCredentials"),
  revokeCredentialGrant: warnAsync("revokeCredentialGrant"),
  previewOutgoingCredentials: warnAsync("previewOutgoingCredentials", async () => ({ ok: true, keys: [], count: 0 })),
  getRules: warnAsync("getRules", async () => ({ ok: false, rules: { warehouses: {} }, isDefault: true, interchangeFiles: [] })),
  saveRules: warnAsync("saveRules"),
  resetRulesDefaults: warnAsync("resetRulesDefaults"),
  testRule: warnAsync("testRule", async () => ({ ok: false, code: "", description: "" })),
  getInterchange: warnAsync("getInterchange", async () => ({ ok: false, table: {} })),
  saveInterchange: warnAsync("saveInterchange"),
};

const api = window.api ?? fallbackApi;

export default api;
