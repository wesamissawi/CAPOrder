// src/scrapers/capRules.js
//
// Faithful JavaScript port of ahk/lib/capRules/rules.ahk `ourRules` (plus the
// interchange() helper from specificRules.ahk). This resolves a raw supplier
// line — (warehouse, linecode, partnumber, description) — into the canonical
// CAP/Sage item code and description.
//
// WHY THIS EXISTS
// ---------------
// The CAP code used to be derived only inside AutoHotkey, and re-derived
// independently at every entry point (purchase entry, sales entry,
// write_order_to_files). Because those AHK rules are gated on the warehouse
// spelling ("World") and on the description text (e.g. NGK -> NTK for O2
// sensors), a part that entered Sage during a PURCHASE as "TRK GM8314" /
// "NTK 24651" could be looked up during a SALE as the raw "TRK GM-8314" /
// "NGK 24651" whenever the bubble had lost/altered its warehouse or
// description — and Sage would not find it.
//
// The fix is single-source-of-truth: resolve the code ONCE, on the JS side, at
// the moment a scraped line becomes a stock/bubble item (see
// main/domain/items.domain.js makeOutstandingFromLine), and store the resolved
// code. Purchase entry still runs ourRules on the raw fields (unchanged), and
// the resolved rules are idempotent, so the sales AHK re-running ourRules over
// an already-resolved code is a harmless no-op. All three paths converge.
//
// KEEP IN SYNC with ahk/lib/capRules/rules.ahk. If you change a rule in one,
// change it in the other.

const fs = require('fs');
const path = require('path');

// --- interchange JSON loading -------------------------------------------------
// The AHK interchange() reads these from the share dir next to the AHK scripts.
// We prefer that same live copy (so JS and AHK never disagree) and fall back to
// the bundled copy in ./interchange when the share is unreachable (e.g. offline).
const SHARE_INTERCHANGE_DIR =
  process.env.CAP_INTERCHANGE_DIR ||
  '\\\\GIRLSBOYS\\ushare\\Ghost PO\\interchange';
const LOCAL_INTERCHANGE_DIR = path.join(__dirname, 'interchange');

const _interchangeCache = new Map();

function loadInterchange(fileName) {
  if (_interchangeCache.has(fileName)) return _interchangeCache.get(fileName);
  let data = {};
  for (const dir of [SHARE_INTERCHANGE_DIR, LOCAL_INTERCHANGE_DIR]) {
    try {
      const p = path.join(dir, fileName);
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

// --- the rule engine ----------------------------------------------------------
// Faithful port of ourRules(warehouse, linecode, partnumber, description).
// Returns { code, description }.
function resolveCapCode(warehouse, linecode, partnumber, description) {
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
      // result is never empty here, so (mirroring AHK) description always
      // becomes "BRAKE ROTORS - <asr>" (asr may be empty).
      newdescription = 'BRAKE ROTORS - ' + asrNumber;
    } else {
      result = lc + ' ' + pn;
    }
  } else {
    result = lc + ' ' + pn;
  }

  return { code: result, description: newdescription };
}

module.exports = { resolveCapCode, interchange };
