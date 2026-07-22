// preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[preload] loaded');

contextBridge.exposeInMainWorld('api', {
  // debug logging -> main-process terminal
  debugLog: (...args) => ipcRenderer.send('debug:log', ...args),

  // data
  readItems: () => ipcRenderer.invoke('items:read'),
  writeItems: (items, deletedUids) => ipcRenderer.invoke('items:write', items, deletedUids),
  exportItems: (items) => ipcRenderer.invoke('items:export', items),

  // updates
  onItemsUpdated: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('items:updated', listener);
    return () => ipcRenderer.removeListener('items:updated', listener);
  },
  onBubbleSharedUpdated: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('bubble-shared:updated', listener);
    return () => ipcRenderer.removeListener('bubble-shared:updated', listener);
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
  readSharedBubbleData: () => ipcRenderer.invoke('bubble-shared:read'),
  writeSharedBubbleData: (payload) => ipcRenderer.invoke('bubble-shared:write', payload),
  deleteSharedBubbleData: (bubbleId) => ipcRenderer.invoke('bubble-shared:delete', bubbleId),
  getConfig: () => ipcRenderer.invoke('config:get'),
  setConfig: (partial) => ipcRenderer.invoke('config:set', partial),
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
  setSagePoActive: (enable) => ipcRenderer.invoke('sage:set-po-active', enable),
  setSageInvoiceActive: (enable) => ipcRenderer.invoke('sage:set-invoice-active', enable),
  onOrdersUpdated: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('orders:updated', listener);
    return () => ipcRenderer.removeListener('orders:updated', listener);
  },
  getOrdersPath: () => ipcRenderer.invoke('orders:get-path'),
  readPayments: () => ipcRenderer.invoke('payments:read'),
  writePayments: (payments) => ipcRenderer.invoke('payments:write', payments),
  getPaymentsPath: () => ipcRenderer.invoke('payments:get-path'),
  fetchWorldOrders: () => ipcRenderer.invoke('orders:fetch-world'),
  fetchTransbecOrders: () => ipcRenderer.invoke('orders:fetch-transbec'),
  fetchProforceOrders: () => ipcRenderer.invoke('orders:fetch-proforce'),
  fetchCbkOrders: () => ipcRenderer.invoke('orders:fetch-cbk'),
  fetchTigerOrders: () => ipcRenderer.invoke('orders:fetch-tiger'),
  fetchBestBuyOrders: () => ipcRenderer.invoke('orders:fetch-bestbuy'),
  openEpicor: (payload) => ipcRenderer.invoke('vendor:open-epicor', payload),
  scanEpicorRange: (payload) => ipcRenderer.invoke('vendor:scan-epicor-range', payload),
  getEpicorScanned: () => ipcRenderer.invoke('vendor:get-epicor-scanned'),
  rescanEpicorInvoice: (invoiceNumber) => ipcRenderer.invoke('vendor:rescan-epicor-invoice', { invoiceNumber }),
  openEpicorInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:open-epicor-invoice-image', fileName),
  readEpicorInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:read-epicor-invoice-image', fileName),
  fetchTransbecInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-transbec-invoices', payload),
  connectGmail: () => ipcRenderer.invoke('vendor:connect-gmail'),
  getGmailStatus: () => ipcRenderer.invoke('vendor:gmail-status'),
  openTransbecInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:open-transbec-invoice-image', fileName),
  readTransbecInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:read-transbec-invoice-image', fileName),
  fetchBestbuyInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-bestbuy-invoices', payload),
  openBestbuyInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:open-bestbuy-invoice-image', fileName),
  readBestbuyInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:read-bestbuy-invoice-image', fileName),
  fetchBestbuyCreditInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-bestbuy-credit-invoices', payload),
  fetchTransbecCreditInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-transbec-credit-invoices', payload),
  getTransbecCredits: () => ipcRenderer.invoke('vendor:get-transbec-credits'),
  resetTransbecCredits: () => ipcRenderer.invoke('vendor:reset-transbec-credits'),
  fetchCbkInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-cbk-invoices', payload),
  openCbkInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:open-cbk-invoice-image', fileName),
  readCbkInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:read-cbk-invoice-image', fileName),
  printInvoiceSilent: (fileName, allPages) => ipcRenderer.invoke('vendor:print-invoice-silent', fileName, allPages),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  reconcileTotals: (refKey, order) => ipcRenderer.invoke('orders:reconcile-totals', refKey, order),
  addOrdersToOutstanding: () => ipcRenderer.invoke('orders:add-to-outstanding'),
  bubblifyOrder: (refKey, bubbleName) => ipcRenderer.invoke('orders:bubblify-order', refKey, bubbleName),
  archiveOrders: (payload) => ipcRenderer.invoke('orders:archive-completed', payload),
  archiveOrder: (refKey, source) => ipcRenderer.invoke('orders:archive-one', refKey, source),
  deleteOrder: (refKey, source) => ipcRenderer.invoke('orders:delete-one', refKey, source),
  searchOrdersArchive: (term) => ipcRenderer.invoke('orders-archive:search', term),
  addArchiveLineToCashSales: (order, line) => ipcRenderer.invoke('orders-archive:add-to-cash-sales', order, line),
  purgeOldOrdersArchive: () => ipcRenderer.invoke('orders-archive:purge-old'),
  archiveBubble: (payload) => ipcRenderer.invoke('archive:save-bubble', payload),
  searchArchive: (query) => ipcRenderer.invoke('archive:search', query),
  getArchivePath: () => ipcRenderer.invoke('archive:get-path'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  sageSalesInvoice: (bubbleName, customerCode, notes, paymentType) => ipcRenderer.invoke('items:sage-sales-invoice', bubbleName, customerCode, notes, paymentType),
  confirm: (message, detail) => ipcRenderer.invoke('dialog:confirm', message, detail),
  getAhkExePath: () => ipcRenderer.invoke('ahk:get-path'),
  setAhkExePath: (pathStr) => ipcRenderer.invoke('ahk:set-path', pathStr),
  chooseAhkExePath: () => ipcRenderer.invoke('ahk:choose-path'),
  validateAhkExePath: (pathStr) => ipcRenderer.invoke('ahk:validate-path', pathStr),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  restartToUpdate: () => ipcRenderer.invoke('updates:restart'),
  onUpdateStatus: (cb) => {
    const listener = (_e, data) => cb?.(data);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  },
  getSageLock: () => ipcRenderer.invoke('sage:get-lock'),
  onSageLockChanged: (cb) => {
    const listener = (_e, data) => cb?.(data);
    ipcRenderer.on('sage:lock-changed', listener);
    return () => ipcRenderer.removeListener('sage:lock-changed', listener);
  },
  getBubbleLocks: () => ipcRenderer.invoke('bubble-lock:get-all'),
  claimBubbleLock: (bubbleId, bubbleName, opts) => ipcRenderer.invoke('bubble-lock:claim', bubbleId, bubbleName, opts),
  releaseBubbleLock: (bubbleId, opts) => ipcRenderer.invoke('bubble-lock:release', bubbleId, opts),
  heartbeatBubbleLock: (bubbleId) => ipcRenderer.invoke('bubble-lock:heartbeat', bubbleId),
  respondToBubbleRequest: (bubbleId, allow) => ipcRenderer.invoke('bubble-lock:respond', bubbleId, allow),
  onBubbleLocksUpdated: (cb) => {
    const listener = (_e, data) => cb?.(data);
    ipcRenderer.on('bubble-lock:updated', listener);
    return () => ipcRenderer.removeListener('bubble-lock:updated', listener);
  },
});
