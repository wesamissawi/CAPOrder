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
  getOrdersPath: async () => ({ path: "(not in Electron)" }),
  fetchWorldOrders: async () => ({ ok: false }),
  fetchCbkOrders: async () => ({ ok: false }),
  fetchBestBuyOrders: async () => ({ ok: false }),
  addOrdersToOutstanding: async () => ({ ok: false }),
};

const api = window.api ?? fallbackApi;

export default api;
