// preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[preload] loaded');

contextBridge.exposeInMainWorld('api', {
  // data
  readItems: () => ipcRenderer.invoke('items:read'),
  writeItems: (items) => ipcRenderer.invoke('items:write', items),
  exportItems: (items) => ipcRenderer.invoke('items:export', items),

  // updates
  onItemsUpdated: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('items:updated', listener);
    return () => ipcRenderer.removeListener('items:updated', listener);
  },

  // file utilities
  getDataPath: () => ipcRenderer.invoke('items:get-path'),
  revealDataFile: () => ipcRenderer.invoke('items:reveal'),
  chooseItemsFile: () => ipcRenderer.invoke('items:choose-file'),
  useDefaultFile: () => ipcRenderer.invoke('items:use-default'),

    // locking
  lockItem: (uid) => ipcRenderer.invoke('items:lock-item', uid),
  applyEdit: (uid, patch) => ipcRenderer.invoke('items:apply-edit', uid, patch),
  releaseLock: (uid) => ipcRenderer.invoke('items:release-lock', uid),

  readUIState: () => ipcRenderer.invoke('ui-state:read'),
  writeUIState: (state) => ipcRenderer.invoke('ui-state:write', state),
  readOrders: () => ipcRenderer.invoke('orders:read'),
  writeOrders: (orders) => ipcRenderer.invoke('orders:write', orders),
  getOrdersPath: () => ipcRenderer.invoke('orders:get-path'),
  fetchWorldOrders: () => ipcRenderer.invoke('orders:fetch-world'),
  fetchTransbecOrders: () => ipcRenderer.invoke('orders:fetch-transbec'),
  fetchProforceOrders: () => ipcRenderer.invoke('orders:fetch-proforce'),
  fetchCbkOrders: () => ipcRenderer.invoke('orders:fetch-cbk'),
  fetchBestBuyOrders: () => ipcRenderer.invoke('orders:fetch-bestbuy'),
  addOrdersToOutstanding: () => ipcRenderer.invoke('orders:add-to-outstanding'),
});
