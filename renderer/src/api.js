// src/api.js
const fallbackApi = {
  readItems: async () => [],
  writeItems: async () => ({ ok: true }),
  exportItems: async () => ({ ok: true }),
  onItemsUpdated: () => () => {},
  getDataPath: async () => ({ path: "(not in Electron)" }),
  revealDataFile: async () => ({ ok: false }),
  chooseItemsFile: async () => ({ ok: false }),
  useDefaultFile: async () => ({ ok: false }),



  // NEW ---- locking fallbacks
  lockItem: async () => ({ ok: false, reason: "not-electron" }),
  applyEdit: async () => ({ ok: false, reason: "not-electron" }),
  releaseLock: async () => ({ ok: false }),


  readOrders: async () => [],
  writeOrders: async () => ({ ok: false }),
  watchOrders: async () => ({ ok: false }),
  onOrdersUpdated: () => () => {},
  getOrdersPath: async () => ({ path: "(not in Electron)" }),
  fetchWorldOrders: async () => ({ ok: false }),
  fetchCbkOrders: async () => ({ ok: false }),
  fetchBestBuyOrders: async () => ({ ok: false }),
  addOrdersToOutstanding: async () => ({ ok: false }),
  archiveBubble: async () => ({ ok: false }),
  searchArchive: async () => ({ ok: false, results: [] }),
  getArchivePath: async () => ({ path: "(not in Electron)" }),
  getAppVersion: async () => ({ ok: false }),
  readConfig: async () => ({ ok: false, config: {}, raw: {}, overrides: {} }),
  writeConfig: async () => ({ ok: false }),
  getAppConfig: async () => ({ ok: false }),
  setAppConfig: async () => ({ ok: false }),
  chooseSharedFolderDialog: async () => ({ ok: false }),
  getResolvedBusinessPaths: async () => ({ ok: false }),
  getResolvedPathsSummary: async () => ({ ok: false }),
  validateSharedFolderWritable: async () => ({ ok: false }),
  migrateBusinessFilesToShared: async () => ({ ok: false }),
};

const api = window.api ?? fallbackApi;

export default api;
