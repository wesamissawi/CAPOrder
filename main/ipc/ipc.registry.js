const { registerItemsIpc } = require('./items.ipc');
const { registerOrdersIpc } = require('./orders.ipc');
const { registerVendorIpc } = require('./vendor.ipc');
const { registerPaymentsIpc } = require('./payments.ipc');
const { registerCloverIpc } = require('./clover.ipc');
const { registerStockFlowIpc } = require('./stockflow.ipc');
const { registerSettingsIpc } = require('./settings.ipc');
const { registerUpdatesIpc } = require('./updates.ipc');
const { registerRulesIpc } = require('./rules.ipc');
const { registerOrderAssignmentIpc } = require('./orderAssignment.ipc');
const { registerSageRunsIpc } = require('./sageRuns.ipc');
const { registerCrdtIpc } = require('./crdt.ipc');
const { registerAutomationIpc } = require('./automation.ipc');

function registerAllIpc(ipcMain, deps) {
  registerAutomationIpc(ipcMain, {
    automation: deps.automation,
    getMachineId: deps.getMachineId,
  });

  registerCrdtIpc(ipcMain, {
    listCrdtConflicts: deps.listCrdtConflicts,
    ackCrdtConflict: deps.ackCrdtConflict,
    ackAllCrdtConflicts: deps.ackAllCrdtConflicts,
    getCrdtStats: deps.getCrdtStats,
  });

  registerItemsIpc(ipcMain, {
    readItems: deps.readItems,
    checkoutItems: deps.checkoutItems,
    writeItems: deps.writeItems,
    readHistory: deps.readHistory,
    getDataFile: deps.getDataFile,
    dialog: deps.dialog,
    fs: deps.fs,
    shell: deps.shell,
    readConfig: deps.readConfig,
    writeConfig: deps.writeConfig,
    startWatching: deps.startWatching,
    getWin: deps.getWin,
    setDataFileOverride: deps.setDataFileOverride,
    getItemsReplaceAll: deps.getItemsReplaceAll,
    runSageSalesInvoice: deps.runSageSalesInvoice,
  });

  registerOrdersIpc(ipcMain, {
    readOrders: deps.readOrders,
    writeOrders: deps.writeOrders,
    getOrdersFile: deps.getOrdersFile,
    getSagePoActive: deps.getSagePoActive,
    setSagePoActive: deps.setSagePoActive,
    getSageInvoiceActive: deps.getSageInvoiceActive,
    setSageInvoiceActive: deps.setSageInvoiceActive,
    resetSageQueue: deps.resetSageQueue,
    scheduleSageProcessing: deps.scheduleSageProcessing,
    syncOutstandingInvoices: deps.syncOutstandingInvoices,
    readItems: deps.readItems,
    writeItems: deps.writeItems,
    makeOutstandingFromLine: deps.makeOutstandingFromLine,
    fetchWorldOrders: deps.fetchWorldOrders,
    fetchTransbecOrders: deps.fetchTransbecOrders,
    fetchProforceOrders: deps.fetchProforceOrders,
    fetchCbkOrders: deps.fetchCbkOrders,
    fetchTigerOrders: deps.fetchTigerOrders,
    fetchBestBuyOrders: deps.fetchBestBuyOrders,
    orderMatchesKey: deps.orderMatchesKey,
    runSageReconcile: deps.runSageReconcile,
    applyReconcileResult: deps.applyReconcileResult,
    alignSageTotalSign: deps.alignSageTotalSign,
    archiveCompletedOrders: deps.archiveCompletedOrders,
    archiveOrderByKey: deps.archiveOrderByKey,
    deleteOrderByKey: deps.deleteOrderByKey,
    searchOrdersArchive: deps.searchOrdersArchive,
    purgeOldOrdersArchive: deps.purgeOldOrdersArchive,
    readOrdersArchive: deps.readOrdersArchive,
    writeOrdersArchive: deps.writeOrdersArchive,
    getWin: deps.getWin,
    readSageLock: deps.readSageLock,
    writeSageLock: deps.writeSageLock,
    clearSageLock: deps.clearSageLock,
    sageLockIsLive: deps.sageLockIsLive,
    tryAcquireSagePoLock: deps.tryAcquireSagePoLock,
    startSageHeartbeat: deps.startSageHeartbeat,
    stopSageHeartbeat: deps.stopSageHeartbeat,
    getMachineId: deps.getMachineId,
    mergeOrdersForWrite: deps.mergeOrdersForWrite,
    getArchivedOrderKeys: deps.getArchivedOrderKeys,
    sageOrderLockIsLive: deps.sageOrderLockIsLive,
    isOrderSageLocked: deps.isOrderSageLocked,
    setSageOrderLock: deps.setSageOrderLock,
    clearSageOrderLock: deps.clearSageOrderLock,
    patchOrderOnDisk: deps.patchOrderOnDisk,
  });

  registerVendorIpc(ipcMain, {
    shell: deps.shell,
    fetchWorldInvoices: deps.fetchWorldInvoices,
    fetchTransbecInvoices: deps.fetchTransbecInvoices,
    fetchBestbuyInvoices: deps.fetchBestbuyInvoices,
    fetchBestbuyCreditInvoices: deps.fetchBestbuyCreditInvoices,
    fetchCbkInvoices: deps.fetchCbkInvoices,
    fetchTransbecCreditInvoices: deps.fetchTransbecCreditInvoices,
    fetchProforceCreditInvoices: deps.fetchProforceCreditInvoices,
    fetchWorldCreditInvoices: deps.fetchWorldCreditInvoices,
    getTransbecCreditInvoices: deps.getTransbecCreditInvoices,
    getWorldCreditInvoices: deps.getWorldCreditInvoices,
    resetTransbecCreditScans: deps.resetTransbecCreditScans,
    connectGmail: deps.connectGmail,
    getGmailStatus: deps.getGmailStatus,
    getGmailAssetsDir: deps.getGmailAssetsDir,
    getWin: deps.getWin,
    loadConfig: deps.loadConfig,
  });

  registerPaymentsIpc(ipcMain, {
    readPayments: deps.readPayments,
    writePayments: deps.writePayments,
    getPaymentsFile: deps.getPaymentsFile,
  });

  registerCloverIpc(ipcMain, {
    openCloverSession: deps.openCloverSession,
    scrapeCloverPayments: deps.scrapeCloverPayments,
    closeCloverSession: deps.closeCloverSession,
    getCloverStatus: deps.getCloverStatus,
    getCloverDebugDir: deps.getCloverDebugDir,
    readPayments: deps.readPayments,
    writePayments: deps.writePayments,
    readCloverLedger: deps.readCloverLedger,
    writeCloverLedger: deps.writeCloverLedger,
    getCloverLedgerFile: deps.getCloverLedgerFile,
  });

  registerStockFlowIpc(ipcMain, {
    readSharedBubbleData: deps.readSharedBubbleData,
    getSharedBubbleDataPath: deps.getSharedBubbleDataPath,
    writeSharedBubbleData: deps.writeSharedBubbleData,
    deleteSharedBubbleData: deps.deleteSharedBubbleData,
    nextSalesOrderNumber: deps.nextSalesOrderNumber,
    readArchivedEntries: deps.readArchivedEntries,
    writeArchivedEntries: deps.writeArchivedEntries,
    getArchiveFile: deps.getArchiveFile,
    fs: deps.fs,
    searchArchiveEntries: deps.searchArchiveEntries,
    normalizeSharedBubblePayload: deps.normalizeSharedBubblePayload,
    // "Find part anywhere" reaches across every store, so it needs the readers
    // the other IPC groups own rather than just the archive's.
    locatePart: deps.locatePart,
    readItems: deps.readItems,
    readHistory: deps.readHistory,
    readOrders: deps.readOrders,
    readOrdersArchive: deps.readOrdersArchive,
    readOrderAssignments: deps.readOrderAssignments,
    // Frozen copies of what each Sales Order actually printed.
    appendPrintSnapshot: deps.appendPrintSnapshot,
    findPrintSnapshots: deps.findPrintSnapshots,
    getPrintsFile: deps.getPrintsFile,
  });

  registerSettingsIpc(ipcMain, {
    readUIState: deps.readUIState,
    writeUIState: deps.writeUIState,
    loadConfig: deps.loadConfig,
    saveConfig: deps.saveConfig,
    getUserConfigRaw: deps.getUserConfigRaw,
    getUserConfigEffective: deps.getUserConfigEffective,
    getEnvOverrides: deps.getEnvOverrides,
    readConfig: deps.readConfig,
    writeConfig: deps.writeConfig,
    ensureConfigFile: deps.ensureConfigFile,
    readAppConfig: deps.readAppConfig,
    ensureBusinessFiles: deps.ensureBusinessFiles,
    getSharedDirInfo: deps.getSharedDirInfo,
    writeAppConfig: deps.writeAppConfig,
    startWatching: deps.startWatching,
    validateWritable: deps.validateWritable,
    migrateBusinessFilesToShared: deps.migrateBusinessFilesToShared,
    getResolvedPathsSummary: deps.getResolvedPathsSummary,
    getAhkExePath: deps.getAhkExePath,
    validateAhkExePath: deps.validateAhkExePath,
    credentialSync: deps.credentialSync,
    INSTANCE_PATHS: deps.INSTANCE_PATHS,
    INSTANCE_DIR: deps.INSTANCE_DIR,
    fs: deps.fs,
    dialog: deps.dialog,
    app: deps.app,
    getWin: deps.getWin,
  });

  registerUpdatesIpc(ipcMain, {
    app: deps.app,
    autoUpdater: deps.autoUpdater,
    sendUpdateStatus: deps.sendUpdateStatus,
    beginManualCheck: deps.beginManualCheck,
  });


  registerRulesIpc(ipcMain);

  registerOrderAssignmentIpc(ipcMain, {
    readOrders: deps.readOrders,
    readOrdersArchive: deps.readOrdersArchive,
    readItems: deps.readItems,
    writeItems: deps.writeItems,
    writeOrdersArchive: deps.writeOrdersArchive,
    readOrderAssignments: deps.readOrderAssignments,
    writeOrderAssignments: deps.writeOrderAssignments,
    getOrderAssignmentsFile: deps.getOrderAssignmentsFile,
    makeOutstandingFromLine: deps.makeOutstandingFromLine,
    patchOrderOnDisk: deps.patchOrderOnDisk,
    randomUUID: deps.randomUUID,
    // Only for the destination list: a bubble with a payment attached is a
    // settled cash sale, not somewhere to send more parts.
    readSharedBubbleData: deps.readSharedBubbleData,
  });

  registerSageRunsIpc(ipcMain, {
    readSageSalesRuns: deps.readSageSalesRuns,
    writeSageSalesRuns: deps.writeSageSalesRuns,
    getSageSalesRunsFile: deps.getSageSalesRunsFile,
    randomUUID: deps.randomUUID,
  });
}

module.exports = { registerAllIpc };
