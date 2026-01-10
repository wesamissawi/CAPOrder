const createVendorOrdersService = (deps) => {
  const {
    ensureDir,
    VENDOR_PATHS,
    readOrders,
    writeOrders,
    getOrdersFile,
    loadConfig,
    getWorldOrders,
    getTransbecOrders,
    getProforceOrders,
    getCbkOrders,
    getBestBuyOrders,
  } = deps;

  async function fetchWorldOrders() {
    try {
      ensureDir(VENDOR_PATHS.world.dataDir);
      const existing = readOrders();
      const targetOrdersPath = getOrdersFile();
      const config = loadConfig();
      const worldUser = typeof config.WORLD_USER === 'string' ? config.WORLD_USER : '';
      const worldPass = typeof config.WORLD_PASS === 'string' ? config.WORLD_PASS : '';
      if (!worldUser || !worldPass) {
        return { ok: false, error: 'Missing WORLD credentials. Set them in Settings.' };
      }
      const res = await getWorldOrders({
        storageDir: VENDOR_PATHS.world.dataDir,
        storageStatePath: VENDOR_PATHS.world.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        credentials: { user: worldUser, pass: worldPass },
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrders(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-world]', e);
      return { ok: false, error: e?.message || 'Failed to fetch World orders.' };
    }
  }

  async function fetchTransbecOrders() {
    try {
      ensureDir(VENDOR_PATHS.transbec.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const config = loadConfig();
      const transbecUser = typeof config.TRANSBEC_USER === 'string' ? config.TRANSBEC_USER : '';
      const transbecPass = typeof config.TRANSBEC_PASS === 'string' ? config.TRANSBEC_PASS : '';
      if (!transbecUser || !transbecPass) {
        return { ok: false, error: 'Missing TRANSBEC credentials. Set them in Settings.' };
      }
      const res = await getTransbecOrders({
        storageDir: VENDOR_PATHS.transbec.dataDir,
        storageStatePath: VENDOR_PATHS.transbec.storageState,
        ordersPath: targetOrdersPath,
        productsPath: VENDOR_PATHS.transbec.products,
        existingOrders: existing,
        maxPages: 1, // limit to first page as requested
        credentials: { user: transbecUser, pass: transbecPass },
      });
      let merged = Array.isArray(res?.orders) ? res.orders : [];
      if (res?.ok) {
        const byRef = new Map();
        (existing || []).forEach((o) => {
          if (!o?.reference) return;
          const key = String(o.reference).trim().toUpperCase();
          if (key) byRef.set(key, o);
        });
        for (const o of merged) {
          const key = o?.reference ? String(o.reference).trim().toUpperCase() : "";
          if (!key) continue;
          if (!byRef.has(key)) {
            byRef.set(key, o);
          }
        }
        merged = Array.from(byRef.values());
        writeOrders(merged);
      }
      return {
        ok: true,
        ...(res || {}),
        orders: merged,
        path: targetOrdersPath,
        productsPath: VENDOR_PATHS.transbec.products,
      };
    } catch (e) {
      console.error('[orders:fetch-transbec]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Transbec orders.' };
    }
  }

  async function fetchProforceOrders() {
    try {
      const config = loadConfig();
      const store = typeof config.PROFORCE_STORE === 'string' ? config.PROFORCE_STORE : '';
      const customer = typeof config.PROFORCE_CUSTOMER === 'string' ? config.PROFORCE_CUSTOMER : '';
      const pass = typeof config.PROFORCE_PASS === 'string' ? config.PROFORCE_PASS : '';
      if (!store || !customer || !pass) {
        return { ok: false, error: 'Missing PROFORCE credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.proforce.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const res = await getProforceOrders({
        storageDir: VENDOR_PATHS.proforce.dataDir,
        storageStatePath: VENDOR_PATHS.proforce.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        credentials: { store, customer, pass },
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrders(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:login-proforce]', e);
      return { ok: false, error: e?.message || 'Failed to fetch Proforce orders.' };
    }
  }

  async function fetchCbkOrders() {
    try {
      const config = loadConfig();
      const cbkUser = typeof config.CBK_USER === 'string' ? config.CBK_USER : '';
      const cbkPass = typeof config.CBK_PASS === 'string' ? config.CBK_PASS : '';
      if (!cbkUser || !cbkPass) {
        return { ok: false, error: 'Missing CBK credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.cbk.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const res = await getCbkOrders({
        storageDir: VENDOR_PATHS.cbk.dataDir,
        storageStatePath: VENDOR_PATHS.cbk.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        credentials: { user: cbkUser, pass: cbkPass },
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrders(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-cbk]', e);
      return { ok: false, error: e?.message || 'Failed to fetch CBK orders.' };
    }
  }

  async function fetchBestBuyOrders() {
    try {
      const config = loadConfig();
      const bestUser = typeof config.BESTBUY_USER === 'string' ? config.BESTBUY_USER : '';
      const bestPass = typeof config.BESTBUY_PASS === 'string' ? config.BESTBUY_PASS : '';
      if (!bestUser || !bestPass) {
        return { ok: false, error: 'Missing BESTBUY credentials. Set them in Settings.' };
      }
      ensureDir(VENDOR_PATHS.bestbuy.dataDir);
      const targetOrdersPath = getOrdersFile();
      const existing = readOrders();
      const res = await getBestBuyOrders({
        storageDir: VENDOR_PATHS.bestbuy.dataDir,
        storageStatePath: VENDOR_PATHS.bestbuy.storageState,
        ordersPath: targetOrdersPath,
        existingOrders: existing,
        credentials: { user: bestUser, pass: bestPass },
      });
      if (res?.ok && Array.isArray(res.orders)) {
        writeOrders(res.orders);
      }
      return { ok: true, ...(res || {}), path: targetOrdersPath };
    } catch (e) {
      console.error('[orders:fetch-bestbuy]', e);
      return { ok: false, error: e?.message || 'Failed to fetch BestBuy orders.' };
    }
  }

  return {
    fetchWorldOrders,
    fetchTransbecOrders,
    fetchProforceOrders,
    fetchCbkOrders,
    fetchBestBuyOrders,
  };
};

module.exports = { createVendorOrdersService };
