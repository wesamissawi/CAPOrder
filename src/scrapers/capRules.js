// src/scrapers/capRules.js
//
// CAP/Sage item-code resolver. Turns a raw supplier line —
// (warehouse, linecode, partnumber, description) — into the canonical CAP/Sage
// item code and description.
//
// WHY THIS EXISTS
// ---------------
// The CAP code used to be derived only inside AutoHotkey and re-derived
// independently at every entry point, so a part could enter Sage during a
// PURCHASE as "TRK GM8314" / "NTK 24651" yet be looked up during a SALE as the
// raw "TRK GM-8314" / "NGK 24651" whenever the bubble had lost/altered its
// warehouse or description — and Sage would not find it. The fix is
// single-source-of-truth: resolve ONCE on the JS side and store the resolved
// code (bubble itemcode + sage_lineItems.sageCode). See [[cap-code-single-source-resolve]].
//
// RULE ENGINE (data-driven)
// -------------------------
// The rules are now DATA, stored in capRules.json (editable from the Rules view
// in the app). This module INTERPRETS that data. JS is the single interpreter;
// the AHK Sage-entry scripts consume the JS-precomputed code (sageCode) instead
// of re-deriving it, so there is exactly one place the rule logic lives.
//
// DEFAULT_RULES below reproduces the original hardcoded ourRules exactly and is
// used whenever capRules.json is absent or unreadable. resolveCapCodeLegacy is
// the original hardcoded implementation, kept as the ultimate fallback and as a
// test oracle for the interpreter.

const fs = require('fs');
const path = require('path');

// --- shared file locations ----------------------------------------------------
// The AHK interchange() reads these from the share dir next to the AHK scripts.
// We prefer that same live copy (so JS and AHK never disagree) and fall back to
// the bundled copy in ./interchange when the share is unreachable (e.g. offline).
const SHARE_INTERCHANGE_DIR =
  process.env.CAP_INTERCHANGE_DIR ||
  '\\\\GIRLSBOYS\\ushare\\Ghost PO\\interchange';
const LOCAL_INTERCHANGE_DIR = path.join(__dirname, 'interchange');
const RULES_FILENAME = 'capRules.json';
const LOCAL_RULES_PATH = path.join(__dirname, RULES_FILENAME);

// --- interchange JSON loading -------------------------------------------------
const _interchangeCache = new Map();

function interchangeCandidatePaths(fileName) {
  return [
    path.join(SHARE_INTERCHANGE_DIR, fileName),
    path.join(LOCAL_INTERCHANGE_DIR, fileName),
  ];
}

function loadInterchange(fileName) {
  if (_interchangeCache.has(fileName)) return _interchangeCache.get(fileName);
  let data = {};
  for (const p of interchangeCandidatePaths(fileName)) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object') {
          data = parsed;
          break;
        }
      }
    } catch (e) {
      // Mirror AHK: a failed/missing file just yields no interchange match.
    }
  }
  _interchangeCache.set(fileName, data);
  return data;
}

// Mirrors AHK interchange(): returns the mapped value or "" when absent.
function interchange(fileName, key) {
  const data = loadInterchange(fileName);
  const v = data ? data[String(key)] : undefined;
  return v === undefined || v === null ? '' : String(v);
}

// --- AHK string-primitive shims (v1 semantics) --------------------------------
// AHK v1 `=` and InStr are case-INSENSITIVE; SubStr is 1-indexed.
function s(v) {
  return v === null || v === undefined ? '' : String(v);
}
function ci(a, b) {
  return s(a).toUpperCase() === s(b).toUpperCase();
}
function inStr(hay, needle) {
  return s(hay).toUpperCase().includes(s(needle).toUpperCase());
}
// SubStr(str, start[, len]) — 1-indexed like AHK.
function subStr(str, start, len) {
  const str2 = s(str);
  const from = start - 1;
  return len === undefined ? str2.slice(from) : str2.slice(from, from + len);
}
function stripDash(str) {
  return s(str).split('-').join('');
}

// =============================================================================
// DATA-DRIVEN RULE INTERPRETER
// =============================================================================
//
// Rule schema (see capRules.json):
//   { version, warehouses: { <name>: [rule,...] }, defaultCode: [token,...] }
//   rule       = { id, enabled, label, conditions:[cond,...], code:[token,...], description:[token,...]|null }
//   cond.type  = eq | startsWith | startsWithAny | contains | containsAny | interchangeHasKey
//   token.t    = lit | var | interchange
//     var.field = linecode | partnumber | description
//     var.transform = (none) | stripDash | substr(start[, trim])
//
// The interpreter returns the first matching rule per warehouse; if none match
// (or the warehouse is unknown) it emits defaultCode ("<linecode> <partnumber>")
// and leaves the description unchanged.

function fieldValue(field, ctx) {
  if (field === 'linecode') return ctx.lc;
  if (field === 'partnumber') return ctx.pn;
  if (field === 'description') return ctx.desc;
  return '';
}

function startsWithCI(str, prefix) {
  const p = s(prefix);
  return ci(subStr(str, 1, p.length), p);
}

function evalCondition(cond, ctx) {
  if (!cond || !cond.type) return false;
  switch (cond.type) {
    case 'eq':
      return ci(fieldValue(cond.field, ctx), cond.value);
    case 'startsWith':
      return startsWithCI(fieldValue(cond.field, ctx), cond.value);
    case 'startsWithAny':
      return (cond.values || []).some((v) => startsWithCI(fieldValue(cond.field, ctx), v));
    case 'contains':
      return inStr(fieldValue(cond.field, ctx), cond.value);
    case 'containsAny':
      return (cond.values || []).some((v) => inStr(fieldValue(cond.field, ctx), v));
    case 'interchangeHasKey':
      return interchange(cond.file, fieldValue(cond.key || 'partnumber', ctx)) !== '';
    default:
      return false;
  }
}

function renderToken(token, ctx) {
  if (!token || !token.t) return '';
  if (token.t === 'lit') return s(token.v);
  if (token.t === 'interchange') {
    return interchange(token.file, fieldValue(token.key || 'partnumber', ctx));
  }
  if (token.t === 'var') {
    let val = fieldValue(token.field, ctx);
    if (token.transform === 'stripDash') val = stripDash(val);
    else if (token.transform === 'substr') {
      val = subStr(val, token.start || 1);
      if (token.trim) val = s(val).trim();
    }
    return s(val);
  }
  return '';
}

function renderTokens(tokens, ctx) {
  if (!Array.isArray(tokens)) return '';
  return tokens.map((t) => renderToken(t, ctx)).join('');
}

function findWarehouseRules(rules, warehouse) {
  const table = rules && rules.warehouses ? rules.warehouses : {};
  for (const name of Object.keys(table)) {
    if (ci(name, warehouse)) return table[name] || [];
  }
  return [];
}

function resolveWithRules(rules, warehouse, linecode, partnumber, description) {
  const ctx = { lc: s(linecode), pn: s(partnumber), desc: s(description) };
  const list = findWarehouseRules(rules, warehouse);
  for (const rule of list) {
    if (!rule || rule.enabled === false) continue;
    const conds = Array.isArray(rule.conditions) ? rule.conditions : [];
    if (conds.every((c) => evalCondition(c, ctx))) {
      const code = renderTokens(rule.code, ctx);
      const desc =
        Array.isArray(rule.description) && rule.description.length
          ? renderTokens(rule.description, ctx)
          : ctx.desc;
      return { code, description: desc };
    }
  }
  const defaultTokens =
    rules && Array.isArray(rules.defaultCode)
      ? rules.defaultCode
      : [{ t: 'var', field: 'linecode' }, { t: 'lit', v: ' ' }, { t: 'var', field: 'partnumber' }];
  return { code: renderTokens(defaultTokens, ctx), description: ctx.desc };
}

// --- rule table loading (cached) ----------------------------------------------
let _rulesCache = undefined;

function rulesPath() {
  // Prefer the shared, editable copy next to the interchange files; fall back to
  // the bundled default shipped with the app.
  const shareRules = path.join(SHARE_INTERCHANGE_DIR, RULES_FILENAME);
  try {
    if (fs.existsSync(shareRules)) return shareRules;
  } catch (e) {
    /* share unreachable */
  }
  return LOCAL_RULES_PATH;
}

function readRulesFromDisk() {
  const shareRules = path.join(SHARE_INTERCHANGE_DIR, RULES_FILENAME);
  for (const p of [shareRules, LOCAL_RULES_PATH]) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && parsed.warehouses) return parsed;
      }
    } catch (e) {
      // corrupt file -> try next candidate, ultimately DEFAULT_RULES
    }
  }
  return null;
}

function loadRules() {
  if (_rulesCache !== undefined) return _rulesCache;
  _rulesCache = readRulesFromDisk() || DEFAULT_RULES;
  return _rulesCache;
}

// Call after writing capRules.json (or interchange files) so the next resolve
// picks up the change.
function invalidateRulesCache() {
  _rulesCache = undefined;
  _interchangeCache.clear();
}

// --- write helpers + accessors (used by the Rules view via IPC) ---------------
// All edits are written to the SHARED copy (next to the interchange files), so
// every machine — and the AHK fallback — sees the same rules.
function writeJsonAtomic(filePath, obj) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, filePath);
}

function rulesWritePath() {
  return path.join(SHARE_INTERCHANGE_DIR, RULES_FILENAME);
}

// Returns the active rule table, where it came from, and whether it's still the
// shipped defaults (isDefault = no EDITED copy exists on the share yet).
function getRules() {
  const shareRules = path.join(SHARE_INTERCHANGE_DIR, RULES_FILENAME);
  let hasShareCopy = false;
  try {
    hasShareCopy = fs.existsSync(shareRules);
  } catch (e) {
    hasShareCopy = false;
  }
  const fromDisk = readRulesFromDisk();
  return {
    rules: fromDisk || DEFAULT_RULES,
    isDefault: !hasShareCopy,
    source: hasShareCopy ? 'share' : fromDisk ? 'bundled' : 'builtin',
    path: rulesPath(),
  };
}

function saveRules(rulesObj) {
  const target = rulesWritePath();
  writeJsonAtomic(target, rulesObj);
  invalidateRulesCache();
  return target;
}

// Fresh (uncached) read of an interchange table for editing, with its path.
function readInterchangeTable(fileName) {
  for (const p of interchangeCandidatePaths(fileName)) {
    try {
      if (fs.existsSync(p)) {
        const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
        if (parsed && typeof parsed === 'object') return { table: parsed, path: p };
      }
    } catch (e) {
      /* try next */
    }
  }
  return { table: {}, path: null };
}

function saveInterchangeTable(fileName, obj) {
  const target = path.join(SHARE_INTERCHANGE_DIR, fileName);
  writeJsonAtomic(target, obj);
  invalidateRulesCache();
  return target;
}

// Every interchange file referenced anywhere in a rule table (tokens or
// conditions), unioned with the known defaults — so the Rules view lists them all.
function referencedInterchangeFiles(rules) {
  const files = new Set(['trsToCAP.json', 'trsToASRotors.json']);
  const scan = (arr) => {
    (arr || []).forEach((item) => {
      if (item && typeof item.file === 'string') files.add(item.file);
    });
  };
  const table = rules && rules.warehouses ? rules.warehouses : {};
  Object.keys(table).forEach((wh) => {
    (table[wh] || []).forEach((rule) => {
      scan(rule && rule.conditions);
      scan(rule && rule.code);
      scan(rule && rule.description);
    });
  });
  return Array.from(files);
}

// --- public resolver ----------------------------------------------------------
// Faithful to the original ourRules. Interprets the (editable) rule table and,
// on any failure, falls back to the hardcoded legacy implementation so a bad
// edit can never leave the resolver dead.
function resolveCapCode(warehouse, linecode, partnumber, description) {
  try {
    const rules = loadRules();
    const out = resolveWithRules(rules, warehouse, linecode, partnumber, description);
    if (out && typeof out.code === 'string') return out;
  } catch (e) {
    // fall through to legacy
  }
  return resolveCapCodeLegacy(warehouse, linecode, partnumber, description);
}

// =============================================================================
// LEGACY hardcoded implementation — the exact original ourRules port.
// Kept as the ultimate fallback and as the interpreter's test oracle.
// KEEP IN SYNC with ahk/lib/capRules/rules.ahk if that ever changes.
// =============================================================================
function resolveCapCodeLegacy(warehouse, linecode, partnumber, description) {
  const wh = s(warehouse);
  const lc = s(linecode);
  const pn = s(partnumber);
  const desc = s(description);

  let result;
  let newdescription = desc;

  if (ci(wh, 'World')) {
    if (ci(lc, 'FRA')) {
      if (ci(subStr(pn, 1, 2), 'DL')) {
        result = 'DEF ' + pn;
      } else if (ci(subStr(pn, 1, 2), 'CA') || ci(subStr(pn, 1, 2), 'FT')) {
        result = pn;
      } else if (ci(subStr(pn, 1, 2), 'CH') || ci(subStr(pn, 1, 2), 'CF')) {
        result = 'FR ' + pn;
      } else if (ci(subStr(pn, 1, 2), 'DA')) {
        result = 'VIP ' + subStr(pn, 3);
      } else {
        result = lc + ' ' + pn;
      }
    } else if (ci(lc, 'NGK')) {
      if (inStr(desc, 'Oxygen') || inStr(desc, 'NTK') || inStr(desc, 'o2')) {
        result = 'NTK ' + pn;
      } else if (ci(subStr(desc, 1, 3), 'RC-')) {
        newdescription = 'IGNITION WIRES ' + desc;
        result = 'NGK ' + pn;
      } else {
        result = lc + ' ' + pn;
      }
    } else if (ci(lc, 'BSH') && (inStr(desc, 'WIPER') || inStr(desc, 'BLADE'))) {
      result = 'BOS ' + pn;
    } else if (ci(lc, 'LUA')) {
      result = 'LUC ' + pn;
    } else if (ci(lc, 'ULR')) {
      result = 'ASR ' + stripDash(pn);
    } else if (ci(lc, 'EUR')) {
      if (inStr(desc, 'SHOE')) {
        result = 'ALS' + pn;
      } else if (ci(subStr(pn, 1, 3), 'F1D') || ci(subStr(pn, 1, 2), 'ID')) {
        result = 'EUR ' + stripDash(pn);
      } else {
        result = lc + ' ' + pn;
      }
    } else if (ci(lc, 'SPE') && ci(subStr(pn, 1, 2), 'C-')) {
      result = 'SPE ' + stripDash(pn);
    } else if (ci(lc, 'TRK')) {
      result = 'TRK ' + stripDash(pn);
    } else if (
      ci(lc, 'WAG') &&
      (ci(subStr(pn, 1, 2), 'QC') ||
        ci(subStr(pn, 1, 2), 'ZD') ||
        ci(subStr(pn, 1, 2), 'MX') ||
        ci(subStr(pn, 1, 2), 'PD') ||
        ci(subStr(pn, 1, 2), 'SX'))
    ) {
      result = pn;
    } else if (ci(lc, 'PRO')) {
      result = pn;
    } else {
      result = lc + ' ' + pn;
    }
  } else if (ci(wh, 'Transbec')) {
    result = interchange('trsToCAP.json', pn);

    if (result === '') {
      if (ci(subStr(pn, 1, 3), 'BCD')) {
        result = 'BCD ' + subStr(pn, 4).trim();
        newdescription = 'Bremsen Ceramic Disc Pads';
      } else if (ci(subStr(pn, 1, 2), 'TK')) {
        result = 'UC K' + subStr(pn, 3).trim();
      } else if (ci(subStr(pn, 1, 3), 'TES')) {
        result = 'UC ES' + subStr(pn, 4).trim();
      } else if (ci(subStr(desc, 1, 20), 'PROFUSION Brake Disc')) {
        result = interchange('trsToASRotors.json', pn);
        if (result === '') {
          result = lc + ' ' + pn;
        }
      } else if (ci(subStr(desc, 1, 18), 'BREMSEN Brake Disc')) {
        result = 'BRM ' + pn;
      } else if (ci(subStr(desc, 1, 26), 'BLACK BELT Serpentine Belt')) {
        result = 'SB 5' + subStr(pn, 2);
        newdescription = 'Serpentine Belt';
      } else {
        result = lc + ' ' + pn;
      }
    }
  } else if (ci(wh, 'Proforce')) {
    if (ci(subStr(pn, 1, 3), 'CRD')) {
      result = 'CRD ' + subStr(pn, 4).trim();
      newdescription = 'PROFORCE Ceramic Disc Pads';
    } else if (ci(lc, 'ROT')) {
      const asrNumber = interchange('trsToASRotors.json', pn);
      result = lc + ' ' + pn;
      newdescription = 'BRAKE ROTORS - ' + asrNumber;
    } else {
      result = lc + ' ' + pn;
    }
  } else {
    result = lc + ' ' + pn;
  }

  return { code: result, description: newdescription };
}

// =============================================================================
// DEFAULT_RULES — data mirror of resolveCapCodeLegacy. Used when capRules.json
// is absent, and shipped as the bundled default the Rules view starts from.
// =============================================================================
const V = (field, extra) => ({ t: 'var', field, ...(extra || {}) });
const L = (v) => ({ t: 'lit', v });
const LINE_PART = [V('linecode'), L(' '), V('partnumber')];

let _uid = 0;
const rid = (name) => `${name}-${++_uid}`;

const DEFAULT_RULES = {
  version: 1,
  defaultCode: LINE_PART,
  warehouses: {
    World: [
      { id: rid('world-fra'), enabled: true, label: 'FRA DL* → DEF <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'FRA' }, { type: 'startsWith', field: 'partnumber', value: 'DL' }],
        code: [L('DEF '), V('partnumber')], description: null },
      { id: rid('world-fra'), enabled: true, label: 'FRA CA*/FT* → <part> (drop line code)',
        conditions: [{ type: 'eq', field: 'linecode', value: 'FRA' }, { type: 'startsWithAny', field: 'partnumber', values: ['CA', 'FT'] }],
        code: [V('partnumber')], description: null },
      { id: rid('world-fra'), enabled: true, label: 'FRA CH*/CF* → FR <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'FRA' }, { type: 'startsWithAny', field: 'partnumber', values: ['CH', 'CF'] }],
        code: [L('FR '), V('partnumber')], description: null },
      { id: rid('world-fra'), enabled: true, label: 'FRA DA* → VIP <part w/o first 2 chars>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'FRA' }, { type: 'startsWith', field: 'partnumber', value: 'DA' }],
        code: [L('VIP '), V('partnumber', { transform: 'substr', start: 3 })], description: null },
      { id: rid('world-fra'), enabled: true, label: 'FRA (other) → FRA <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'FRA' }],
        code: LINE_PART, description: null },
      { id: rid('world-ngk'), enabled: true, label: 'NGK O2/Oxygen/NTK → NTK <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'NGK' }, { type: 'containsAny', field: 'description', values: ['Oxygen', 'NTK', 'o2'] }],
        code: [L('NTK '), V('partnumber')], description: null },
      { id: rid('world-ngk'), enabled: true, label: 'NGK RC-* wires → NGK <part>, relabel IGNITION WIRES',
        conditions: [{ type: 'eq', field: 'linecode', value: 'NGK' }, { type: 'startsWith', field: 'description', value: 'RC-' }],
        code: [L('NGK '), V('partnumber')], description: [L('IGNITION WIRES '), V('description')] },
      { id: rid('world-ngk'), enabled: true, label: 'NGK (other) → NGK <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'NGK' }],
        code: LINE_PART, description: null },
      { id: rid('world-bsh'), enabled: true, label: 'BSH wiper/blade → BOS <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'BSH' }, { type: 'containsAny', field: 'description', values: ['WIPER', 'BLADE'] }],
        code: [L('BOS '), V('partnumber')], description: null },
      { id: rid('world-lua'), enabled: true, label: 'LUA → LUC <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'LUA' }],
        code: [L('LUC '), V('partnumber')], description: null },
      { id: rid('world-ulr'), enabled: true, label: 'ULR → ASR <part w/o dashes>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'ULR' }],
        code: [L('ASR '), V('partnumber', { transform: 'stripDash' })], description: null },
      { id: rid('world-eur'), enabled: true, label: 'EUR shoe → ALS<part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'EUR' }, { type: 'contains', field: 'description', value: 'SHOE' }],
        code: [L('ALS'), V('partnumber')], description: null },
      { id: rid('world-eur'), enabled: true, label: 'EUR F1D*/ID* → EUR <part w/o dashes>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'EUR' }, { type: 'startsWithAny', field: 'partnumber', values: ['F1D', 'ID'] }],
        code: [L('EUR '), V('partnumber', { transform: 'stripDash' })], description: null },
      { id: rid('world-eur'), enabled: true, label: 'EUR (other) → EUR <part>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'EUR' }],
        code: LINE_PART, description: null },
      { id: rid('world-spe'), enabled: true, label: 'SPE C-* → SPE <part w/o dashes>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'SPE' }, { type: 'startsWith', field: 'partnumber', value: 'C-' }],
        code: [L('SPE '), V('partnumber', { transform: 'stripDash' })], description: null },
      { id: rid('world-trk'), enabled: true, label: 'TRK → TRK <part w/o dashes>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'TRK' }],
        code: [L('TRK '), V('partnumber', { transform: 'stripDash' })], description: null },
      { id: rid('world-wag'), enabled: true, label: 'WAG QC/ZD/MX/PD/SX* → <part> (drop line code)',
        conditions: [{ type: 'eq', field: 'linecode', value: 'WAG' }, { type: 'startsWithAny', field: 'partnumber', values: ['QC', 'ZD', 'MX', 'PD', 'SX'] }],
        code: [V('partnumber')], description: null },
      { id: rid('world-pro'), enabled: true, label: 'PRO → <part> (drop line code)',
        conditions: [{ type: 'eq', field: 'linecode', value: 'PRO' }],
        code: [V('partnumber')], description: null },
    ],
    Transbec: [
      { id: rid('trs-ic'), enabled: true, label: 'Interchange trsToCAP hit → mapped code',
        conditions: [{ type: 'interchangeHasKey', file: 'trsToCAP.json', key: 'partnumber' }],
        code: [{ t: 'interchange', file: 'trsToCAP.json', key: 'partnumber' }], description: null },
      { id: rid('trs-bcd'), enabled: true, label: 'BCD* → BCD <part w/o prefix>, relabel Bremsen Ceramic',
        conditions: [{ type: 'startsWith', field: 'partnumber', value: 'BCD' }],
        code: [L('BCD '), V('partnumber', { transform: 'substr', start: 4, trim: true })],
        description: [L('Bremsen Ceramic Disc Pads')] },
      { id: rid('trs-tk'), enabled: true, label: 'TK* → UC K<part w/o prefix>',
        conditions: [{ type: 'startsWith', field: 'partnumber', value: 'TK' }],
        code: [L('UC K'), V('partnumber', { transform: 'substr', start: 3, trim: true })], description: null },
      { id: rid('trs-tes'), enabled: true, label: 'TES* → UC ES<part w/o prefix>',
        conditions: [{ type: 'startsWith', field: 'partnumber', value: 'TES' }],
        code: [L('UC ES'), V('partnumber', { transform: 'substr', start: 4, trim: true })], description: null },
      { id: rid('trs-profusion'), enabled: true, label: 'PROFUSION Brake Disc + rotor interchange → mapped ASR code',
        conditions: [{ type: 'startsWith', field: 'description', value: 'PROFUSION Brake Disc' }, { type: 'interchangeHasKey', file: 'trsToASRotors.json', key: 'partnumber' }],
        code: [{ t: 'interchange', file: 'trsToASRotors.json', key: 'partnumber' }], description: null },
      { id: rid('trs-bremsen'), enabled: true, label: 'BREMSEN Brake Disc → BRM <part>',
        conditions: [{ type: 'startsWith', field: 'description', value: 'BREMSEN Brake Disc' }],
        code: [L('BRM '), V('partnumber')], description: null },
      { id: rid('trs-blackbelt'), enabled: true, label: 'BLACK BELT Serpentine → SB 5<part[2:]>, relabel Serpentine Belt',
        conditions: [{ type: 'startsWith', field: 'description', value: 'BLACK BELT Serpentine Belt' }],
        code: [L('SB 5'), V('partnumber', { transform: 'substr', start: 2 })],
        description: [L('Serpentine Belt')] },
    ],
    Proforce: [
      { id: rid('pfc-crd'), enabled: true, label: 'CRD* → CRD <part w/o prefix>, relabel PROFORCE Ceramic',
        conditions: [{ type: 'startsWith', field: 'partnumber', value: 'CRD' }],
        code: [L('CRD '), V('partnumber', { transform: 'substr', start: 4, trim: true })],
        description: [L('PROFORCE Ceramic Disc Pads')] },
      { id: rid('pfc-rot'), enabled: true, label: 'ROT → ROT <part>, relabel BRAKE ROTORS - <asr>',
        conditions: [{ type: 'eq', field: 'linecode', value: 'ROT' }],
        code: LINE_PART,
        description: [L('BRAKE ROTORS - '), { t: 'interchange', file: 'trsToASRotors.json', key: 'partnumber' }] },
    ],
  },
};

module.exports = {
  resolveCapCode,
  resolveCapCodeLegacy,
  interchange,
  // rule-engine internals + accessors for IPC / the Rules view
  DEFAULT_RULES,
  loadRules,
  readRulesFromDisk,
  invalidateRulesCache,
  resolveWithRules,
  rulesPath,
  RULES_FILENAME,
  SHARE_INTERCHANGE_DIR,
  LOCAL_INTERCHANGE_DIR,
  interchangeCandidatePaths,
  loadInterchange,
  // write helpers + accessors for the Rules view
  getRules,
  saveRules,
  rulesWritePath,
  readInterchangeTable,
  saveInterchangeTable,
  referencedInterchangeFiles,
};
