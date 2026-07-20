const { registerItemsIpc } = require('./items.ipc');
const { registerOrdersIpc } = require('./orders.ipc');
const { registerVendorIpc } = require('./vendor.ipc');
const { registerPaymentsIpc } = require('./payments.ipc');
const { registerStockFlowIpc } = require('./stockflow.ipc');
const { registerSettingsIpc } = require('./settings.ipc');
const { registerUpdatesIpc } = require('./updates.ipc');
const { registerBubbleLocksIpc } = require('./bubbleLocks.ipc');

function registerAllIpc(ipcMain, deps) {
  registerItemsIpc(ipcMain, {
    readItems: deps.readItems,
    writeItems: deps.writeItems,
    getDataFile: deps.getDataFile,
    dialog: deps.dialog,
    fs: deps.fs,
    shell: deps.shell,
    readConfig: deps.readConfig,
    writeConfig: deps.writeConfig,
    startWatching: deps.startWatching,
    getWin: deps.getWin,
    setDataFileOverride: deps.setDataFileOverride,
    LOCK_DURATION_MS: deps.LOCK_DURATION_MS,
    cleanExpiredLocks: deps.cleanExpiredLocks,
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
    stopOrdersWatching: deps.stopOrdersWatching,
    startOrdersWatching: deps.startOrdersWatching,
    scheduleSageProcessing: deps.scheduleSageProcessing,
    syncOutstandingInvoices: deps.syncOutstandingInvoices,
    readItems: deps.readItems,
    writeItems: deps.writeItems,
    makeOutstandingFromLine: deps.makeOutstandingFromLine,
    fetchWorldOrders: deps.fetchWorldOrders,
    fetchTransbecOrders: deps.fetchTransbecOrders,
    fetchProforceOrders: deps.fetchProforceOrders,
    fetchCbkOrders: deps.fetchCbkOrders,
    fetchBestBuyOrders: deps.fetchBestBuyOrders,
    orderMatchesKey: deps.orderMatchesKey,
    runSageReconcile: deps.runSageReconcile,
    applyReconcileResult: deps.applyReconcileResult,
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
    startSageHeartbeat: deps.startSageHeartbeat,
    stopSageHeartbeat: deps.stopSageHeartbeat,
    getMachineId: deps.getMachineId,
  });

  registerVendorIpc(ipcMain, {
    openEpicor: deps.openEpicor,
    scanEpicorRange: deps.scanEpicorRange,
    rescanEpicorInvoice: deps.rescanEpicorInvoice,
    getEpicorScannedInvoices: deps.getEpicorScannedInvoices,
    shell: deps.shell,
    getEpicorAssetsDir: deps.getEpicorAssetsDir,
    fetchTransbecInvoices: deps.fetchTransbecInvoices,
    fetchBestbuyInvoices: deps.fetchBestbuyInvoices,
    fetchBestbuyCreditInvoices: deps.fetchBestbuyCreditInvoices,
    fetchCbkInvoices: deps.fetchCbkInvoices,
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

  registerStockFlowIpc(ipcMain, {
    readSharedBubbleData: deps.readSharedBubbleData,
    getSharedBubbleDataPath: deps.getSharedBubbleDataPath,
    writeSharedBubbleData: deps.writeSharedBubbleData,
    deleteSharedBubbleData: deps.deleteSharedBubbleData,
    readArchivedEntries: deps.readArchivedEntries,
    writeArchivedEntries: deps.writeArchivedEntries,
    getArchiveFile: deps.getArchiveFile,
    fs: deps.fs,
    searchArchiveEntries: deps.searchArchiveEntries,
    normalizeSharedBubblePayload: deps.normalizeSharedBubblePayload,
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
    startOrdersWatching: deps.startOrdersWatching,
    startBubbleSharedWatching: deps.startBubbleSharedWatching,
    validateWritable: deps.validateWritable,
    migrateBusinessFilesToShared: deps.migrateBusinessFilesToShared,
    getResolvedPathsSummary: deps.getResolvedPathsSummary,
    getAhkExePath: deps.getAhkExePath,
    validateAhkExePath: deps.validateAhkExePath,
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
  });

  registerBubbleLocksIpc(ipcMain, {
    readBubbleLocks: deps.readBubbleLocks,
    writeBubbleLock: deps.writeBubbleLock,
    releaseBubbleLock: deps.releaseBubbleLock,
    getMachineId: deps.getMachineId,
  });
}

module.exports = { registerAllIpc };
