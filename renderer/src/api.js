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
  readItems: async () => [],
  writeItems: warnAsync("writeItems"),
  exportItems: warnAsync("exportItems"),
  onItemsUpdated: warnEvent("onItemsUpdated"),
  getDataPath: warnAsync("getDataPath", async () => ({ path: "(not in Electron)" })),
  revealDataFile: warnAsync("revealDataFile"),
  chooseItemsFile: warnAsync("chooseItemsFile"),
  useDefaultFile: warnAsync("useDefaultFile"),



  // NEW ---- locking fallbacks
  lockItem: warnAsync("lockItem"),
  applyEdit: warnAsync("applyEdit"),
  releaseLock: warnAsync("releaseLock"),


  readOrders: async () => [],
  writeOrders: warnAsync("writeOrders"),
  watchOrders: warnAsync("watchOrders"),
  onOrdersUpdated: warnEvent("onOrdersUpdated"),
  getOrdersPath: warnAsync("getOrdersPath", async () => ({ path: "(not in Electron)" })),
  readPayments: async () => [],
  writePayments: warnAsync("writePayments"),
  getPaymentsPath: warnAsync("getPaymentsPath", async () => ({ path: "(not in Electron)" })),
  fetchWorldOrders: warnAsync("fetchWorldOrders"),
  fetchCbkOrders: warnAsync("fetchCbkOrders"),
  fetchBestBuyOrders: warnAsync("fetchBestBuyOrders"),
  reconcileTotals: warnAsync("reconcileTotals"),
  addOrdersToOutstanding: warnAsync("addOrdersToOutstanding"),
  bubblifyOrder: warnAsync("bubblifyOrder"),
  archiveOrders: warnAsync("archiveOrders"),
  archiveOrder: warnAsync("archiveOrder"),
  confirm: async (message) => window.confirm(message),
  searchOrdersArchive: warnAsync("searchOrdersArchive", async () => ({ ok: false, results: [] })),
  addArchiveLineToCashSales: warnAsync("addArchiveLineToCashSales", async () => ({ ok: false })),
  purgeOldOrdersArchive: warnAsync("purgeOldOrdersArchive", async () => ({ ok: false, removed: 0 })),
  archiveBubble: warnAsync("archiveBubble"),
  searchArchive: warnAsync("searchArchive", async () => ({ ok: false, results: [] })),
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
  getBubbleLocks: warnAsync("getBubbleLocks", async () => ({ locks: {}, ownMachineId: null })),
  claimBubbleLock: warnAsync("claimBubbleLock", async () => ({ ok: true, claimed: true })),
  releaseBubbleLock: warnAsync("releaseBubbleLock"),
  heartbeatBubbleLock: warnAsync("heartbeatBubbleLock"),
  respondToBubbleRequest: warnAsync("respondToBubbleRequest"),
  onBubbleLocksUpdated: warnEvent("onBubbleLocksUpdated"),
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
};

const api = window.api ?? fallbackApi;

export default api;
