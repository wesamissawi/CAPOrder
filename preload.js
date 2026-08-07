// preload.js
const { contextBridge, ipcRenderer } = require('electron');

console.log('[preload] loaded');

contextBridge.exposeInMainWorld('api', {
  // debug logging -> main-process terminal
  debugLog: (...args) => ipcRenderer.send('debug:log', ...args),

  // data
  readItems: () => ipcRenderer.invoke('items:read'),
  writeItems: (items, deletedUids, options) => ipcRenderer.invoke('items:write', items, deletedUids, options),
  readItemHistory: () => ipcRenderer.invoke('items:read-history'),
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

  // Replicated store: concurrent-edit review. The store resolves collisions on
  // its own; these surface the ones where a person's change lost, so somebody
  // can check whether it mattered.
  readConflicts: () => ipcRenderer.invoke('crdt:conflicts'),
  dismissConflict: (id) => ipcRenderer.invoke('crdt:ack-conflict', id),
  dismissAllConflicts: () => ipcRenderer.invoke('crdt:ack-all-conflicts'),
  readStoreStats: () => ipcRenderer.invoke('crdt:stats'),
  onConflicts: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('crdt:conflicts', listener);
    return () => ipcRenderer.removeListener('crdt:conflicts', listener);
  },
  onPaymentsUpdated: (cb) => {
    const listener = (_e, data) => cb(data);
    ipcRenderer.on('payments:updated', listener);
    return () => ipcRenderer.removeListener('payments:updated', listener);
  },

  // file utilities
  getDataPath: () => ipcRenderer.invoke('items:get-path'),
  revealDataFile: () => ipcRenderer.invoke('items:reveal'),
  chooseItemsFile: () => ipcRenderer.invoke('items:choose-file'),
  useDefaultFile: () => ipcRenderer.invoke('items:use-default'),

    // locking

  readUIState: () => ipcRenderer.invoke('ui-state:read'),
  writeUIState: (state) => ipcRenderer.invoke('ui-state:write', state),
  readSharedBubbleData: () => ipcRenderer.invoke('bubble-shared:read'),
  writeSharedBubbleData: (payload) => ipcRenderer.invoke('bubble-shared:write', payload),
  deleteSharedBubbleData: (bubbleId) => ipcRenderer.invoke('bubble-shared:delete', bubbleId),
  nextSalesOrderNumber: () => ipcRenderer.invoke('sales-order:next'),
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
  // Credential hand-off between workstations. The pairing code exists only in
  // the return value of sendCredentials and the argument to redeemCredentials —
  // there is deliberately no channel that broadcasts it.
  requestCredentials: () => ipcRenderer.invoke('cred-sync:request'),
  cancelCredentialRequest: () => ipcRenderer.invoke('cred-sync:cancel-request'),
  getCredentialInboundStatus: () => ipcRenderer.invoke('cred-sync:inbound-status'),
  redeemCredentials: (code) => ipcRenderer.invoke('cred-sync:redeem', code),
  listCredentialRequests: () => ipcRenderer.invoke('cred-sync:list-requests'),
  sendCredentials: (machineId) => ipcRenderer.invoke('cred-sync:send', machineId),
  revokeCredentialGrant: (machineId) => ipcRenderer.invoke('cred-sync:revoke', machineId),
  previewOutgoingCredentials: () => ipcRenderer.invoke('cred-sync:preview-outgoing'),

  readOrders: () => ipcRenderer.invoke('orders:read'),
  getOrderArrivalMap: () => ipcRenderer.invoke('orders:get-arrival-map'),
  writeOrders: (orders) => ipcRenderer.invoke('orders:write', orders),
  triggerOrderSage: (refKey, kind) => ipcRenderer.invoke('sage:trigger-order', refKey, kind),
  sendSageQueue: () => ipcRenderer.invoke('sage:send-queue'),
  releaseOrderSageLock: (refKey) => ipcRenderer.invoke('sage:release-order-lock', refKey),
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
  openClover: (payload) => ipcRenderer.invoke('clover:open', payload),
  scrapeCloverPayments: () => ipcRenderer.invoke('clover:scrape-import'),
  getCloverLedgerSummary: () => ipcRenderer.invoke('clover:ledger-summary'),
  forgetMistypedClover: () => ipcRenderer.invoke('clover:forget-mistyped'),
  closeClover: () => ipcRenderer.invoke('clover:close'),
  getCloverStatus: () => ipcRenderer.invoke('clover:status'),
  fetchWorldOrders: () => ipcRenderer.invoke('orders:fetch-world'),
  fetchTransbecOrders: () => ipcRenderer.invoke('orders:fetch-transbec'),
  fetchProforceOrders: () => ipcRenderer.invoke('orders:fetch-proforce'),
  fetchCbkOrders: () => ipcRenderer.invoke('orders:fetch-cbk'),
  fetchTigerOrders: () => ipcRenderer.invoke('orders:fetch-tiger'),
  fetchBestBuyOrders: () => ipcRenderer.invoke('orders:fetch-bestbuy'),
  fetchWorldInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-world-invoices', payload),
  openWorldInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:open-world-invoice-image', fileName),
  readWorldInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:read-world-invoice-image', fileName),
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
  fetchProforceCreditInvoices: (payload) => ipcRenderer.invoke('vendor:fetch-proforce-credit-invoices', payload),
  openProforceInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:open-proforce-invoice-image', fileName),
  readProforceInvoiceImage: (fileName) => ipcRenderer.invoke('vendor:read-proforce-invoice-image', fileName),
  printInvoiceSilent: (fileName, allPages) => ipcRenderer.invoke('vendor:print-invoice-silent', fileName, allPages),
  listPrinters: () => ipcRenderer.invoke('printers:list'),
  reconcileTotals: (refKey, order) => ipcRenderer.invoke('orders:reconcile-totals', refKey, order),
  addOrdersToOutstanding: () => ipcRenderer.invoke('orders:add-to-outstanding'),
  archiveOrders: (payload) => ipcRenderer.invoke('orders:archive-completed', payload),
  archiveOrder: (refKey, source) => ipcRenderer.invoke('orders:archive-one', refKey, source),
  deleteOrder: (refKey, source) => ipcRenderer.invoke('orders:delete-one', refKey, source),
  searchOrdersArchive: (term) => ipcRenderer.invoke('orders-archive:search', term),
  addArchiveLineToCashSales: (order, line, target) => ipcRenderer.invoke('orders-archive:add-to-cash-sales', order, line, target),
  purgeOldOrdersArchive: () => ipcRenderer.invoke('orders-archive:purge-old'),
  readOrderAssignments: (opts) => ipcRenderer.invoke('order-assignment:read', opts),
  setOrderAssignmentResolved: (payload) => ipcRenderer.invoke('order-assignment:set-resolved', payload),
  resolveOrderAssignmentsBefore: (payload) => ipcRenderer.invoke('order-assignment:resolve-before', payload),
  assignOrderLine: (payload) => ipcRenderer.invoke('order-assignment:assign', payload),
  unassignOrderLine: (payload) => ipcRenderer.invoke('order-assignment:unassign', payload),
  unassignOrderItem: (payload) => ipcRenderer.invoke('order-assignment:unassign-item', payload),
  archiveBubble: (payload) => ipcRenderer.invoke('archive:save-bubble', payload),
  appendPrintSnapshot: (payload) => ipcRenderer.invoke('sales-order-prints:append', payload),
  findPrintSnapshots: (query) => ipcRenderer.invoke('sales-order-prints:find', query),
  searchArchive: (query) => ipcRenderer.invoke('archive:search', query),
  locatePart: (term) => ipcRenderer.invoke('items:locate', term),
  getArchivedPaymentUsage: () => ipcRenderer.invoke('archive:payment-usage'),
  readSageRuns: () => ipcRenderer.invoke('sage-runs:read'),
  appendSageRun: (run) => ipcRenderer.invoke('sage-runs:append', run),
  setSageRunInvoice: (payload) => ipcRenderer.invoke('sage-runs:set-invoice', payload),
  deleteSageRun: (id) => ipcRenderer.invoke('sage-runs:delete', id),
  getArchivePath: () => ipcRenderer.invoke('archive:get-path'),
  getAppVersion: () => ipcRenderer.invoke('app:get-version'),
  sageSalesInvoice: (bubbleName, customerCode, notes, paymentType, options) =>
    ipcRenderer.invoke('items:sage-sales-invoice', bubbleName, customerCode, notes, paymentType, options),
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
  // CAP rules editor (Rules view)
  getRules: () => ipcRenderer.invoke('rules:get'),
  saveRules: (rules) => ipcRenderer.invoke('rules:save', rules),
  resetRulesDefaults: () => ipcRenderer.invoke('rules:reset-defaults'),
  testRule: (sample) => ipcRenderer.invoke('rules:test', sample),
  getInterchange: (fileName) => ipcRenderer.invoke('rules:interchange-get', fileName),
  saveInterchange: (fileName, table) => ipcRenderer.invoke('rules:interchange-save', fileName, table),

});
