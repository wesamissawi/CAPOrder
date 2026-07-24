// main/ipc/rules.ipc.js
// IPC for the Rules view: read/write the CAP rule table + interchange tables,
// and a live "test resolve" that runs the current rules against sample inputs.
// JS (capRules.js) is the single rule interpreter; these handlers just persist
// the data it reads. See src/scrapers/capRules.js and [[cap-code-single-source-resolve]].

const capRules = require('../../src/scrapers/capRules');

function isPlainObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

// Minimal structural validation so a malformed payload can't brick the resolver.
function validateRules(rules) {
  if (!isPlainObject(rules)) return 'Rules must be an object.';
  if (!isPlainObject(rules.warehouses)) return 'Rules must have a "warehouses" object.';
  for (const wh of Object.keys(rules.warehouses)) {
    const list = rules.warehouses[wh];
    if (!Array.isArray(list)) return `Warehouse "${wh}" must be an array of rules.`;
    for (const rule of list) {
      if (!isPlainObject(rule)) return `A rule under "${wh}" is not an object.`;
      if (!Array.isArray(rule.conditions)) return `A rule under "${wh}" is missing conditions[].`;
      if (!Array.isArray(rule.code)) return `A rule under "${wh}" is missing code[] tokens.`;
    }
  }
  return null;
}

const registerRulesIpc = (ipcMain) => {
  ipcMain.handle('rules:get', () => {
    try {
      const { rules, isDefault, path } = capRules.getRules();
      return { ok: true, rules, isDefault, path, interchangeFiles: capRules.referencedInterchangeFiles(rules) };
    } catch (e) {
      console.error('[rules:get]', e);
      return { ok: false, error: e?.message || 'Failed to read rules.' };
    }
  });

  ipcMain.handle('rules:save', (_evt, rules) => {
    try {
      const err = validateRules(rules);
      if (err) return { ok: false, error: err };
      const path = capRules.saveRules(rules);
      return { ok: true, path };
    } catch (e) {
      console.error('[rules:save]', e);
      return { ok: false, error: e?.message || 'Failed to save rules.' };
    }
  });

  ipcMain.handle('rules:reset-defaults', () => {
    try {
      const path = capRules.saveRules(capRules.DEFAULT_RULES);
      return { ok: true, path, rules: capRules.DEFAULT_RULES };
    } catch (e) {
      console.error('[rules:reset-defaults]', e);
      return { ok: false, error: e?.message || 'Failed to reset rules.' };
    }
  });

  // Live test: resolve a sample line through the CURRENT (saved) rules.
  ipcMain.handle('rules:test', (_evt, sample) => {
    try {
      const s = sample || {};
      capRules.invalidateRulesCache();
      const out = capRules.resolveCapCode(s.warehouse, s.linecode, s.partnumber, s.description);
      return { ok: true, code: out.code, description: out.description };
    } catch (e) {
      console.error('[rules:test]', e);
      return { ok: false, error: e?.message || 'Failed to test rule.' };
    }
  });

  ipcMain.handle('rules:interchange-get', (_evt, fileName) => {
    try {
      if (!fileName || typeof fileName !== 'string') return { ok: false, error: 'File name required.' };
      const { table, path } = capRules.readInterchangeTable(fileName);
      return { ok: true, fileName, table, path, count: Object.keys(table || {}).length };
    } catch (e) {
      console.error('[rules:interchange-get]', e);
      return { ok: false, error: e?.message || 'Failed to read interchange.' };
    }
  });

  ipcMain.handle('rules:interchange-save', (_evt, fileName, table) => {
    try {
      if (!fileName || typeof fileName !== 'string') return { ok: false, error: 'File name required.' };
      if (!isPlainObject(table)) return { ok: false, error: 'Interchange table must be an object of part → code.' };
      // Normalize: string keys + string values, drop blank keys.
      const clean = {};
      for (const [k, v] of Object.entries(table)) {
        const key = String(k).trim();
        if (key) clean[key] = String(v ?? '');
      }
      const path = capRules.saveInterchangeTable(fileName, clean);
      return { ok: true, fileName, path, count: Object.keys(clean).length };
    } catch (e) {
      console.error('[rules:interchange-save]', e);
      return { ok: false, error: e?.message || 'Failed to save interchange.' };
    }
  });
};

module.exports = { registerRulesIpc };
