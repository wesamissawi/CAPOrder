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
  readConfig: () => ipcRenderer.invoke('config:read'),
  writeConfig: (config) => ipcRenderer.invoke('config:write', config),
  getAppConfig: () => ipcRenderer.invoke('app-config:get'),
  setAppConfig: (partial) => ipcRenderer.invoke('app-config:set', partial),
  chooseSharedFolderDialog: () => ipcRenderer.invoke('app-config:choose-shared'),
  getResolvedBusinessPaths: () => ipcRenderer.invoke('app-config:resolved-paths'),
  getResolvedPathsSummary: () => ipcRenderer.invoke('app-config:resolved-paths'),
  validateSharedFolderWritable: (dir) => ipcRenderer.invoke('app-config:validate-shared', dir),
  migrateBusinessFilesToShared: (payload) => ipcRenderer.invoke('app-config:migrate-business', payload),
  readOrders: () => ipcRenderer.invoke('orders:read'),
  writeOrders: (orders) => ipcRenderer.invoke('orders:write', orders),
  watchOrders: (enable) => ipcRenderer.invoke('orders:watch', enable),
  onOrdersUpdated: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('orders:updated', listener);
    return () => ipcRenderer.removeListener('orders:updated', listener);
  },
  getOrdersPath: () => ipcRenderer.invoke('orders:get-path'),
  fetchWorldOrders: () => ipcRenderer.invoke('orders:fetch-world'),
  fetchTransbecOrders: () => ipcRenderer.invoke('orders:fetch-transbec'),
  fetchProforceOrders: () => ipcRenderer.invoke('orders:fetch-proforce'),
  fetchCbkOrders: () => ipcRenderer.invoke('orders:fetch-cbk'),
  fetchBestBuyOrders: () => ipcRenderer.invoke('orders:fetch-bestbuy'),
  addOrdersToOutstanding: () => ipcRenderer.invoke('orders:add-to-outstanding'),
  archiveBubble: (payload) => ipcRenderer.invoke('archive:save-bubble', payload),
  searchArchive: (query) => ipcRenderer.invoke('archive:search', query),
  getArchivePath: () => ipcRenderer.invoke('archive:get-path'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
});
