const fs = require('fs');
const path = require('path');

// Replacing an existing file on Windows needs delete access on the DESTINATION,
// so anything holding it open without delete-sharing (antivirus mid-scan, an
// editor, AHK's FileRead, a stale SMB oplock) fails the rename with
// EPERM/EACCES/EBUSY. Those holders let go within milliseconds, so retry
// briefly instead of failing the save outright.
const RENAME_RETRY_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

// Blocking pause that doesn't peg a core. Only used on the rare rename-retry
// error path, for at most ~400ms across all retries.
function sleepSync(ms) {
  try { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); } catch {}
}

function renameWithRetry(tmp, filePath, attempts = 5) {
  let lastErr = null;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      fs.renameSync(tmp, filePath);
      if (attempt > 0)
        console.warn('[writeJsonAtomic] rename succeeded on attempt', attempt + 1, filePath);
      return;
    } catch (e) {
      lastErr = e;
      if (!RENAME_RETRY_CODES.has(e?.code) || attempt === attempts - 1) break;
      sleepSync(40 * (attempt + 1));
    }
  }
  console.error('[writeJsonAtomic] rename failed after', attempts, 'attempts', filePath, lastErr);
  throw lastErr;
}

// Write-then-rename so a reader (or a concurrent writer's own read) never sees
// a half-written file — the shared files here live on an SMB share and get
// read by other machines and by this same app's own watchers mid-write. Not
// JSON-specific despite the name (it's just a string), but every caller so
// far has been a JSON blob; writeFileAtomic below is the same function under
// a content-neutral name for non-JSON callers (e.g. JSONL, CSV).
function writeJsonAtomic(filePath, jsonString) {
  const dir = path.dirname(filePath);
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  const tmp = path.join(dir, `${path.basename(filePath)}.tmp.${process.pid}.${Date.now()}`);
  fs.writeFileSync(tmp, jsonString, 'utf-8');
  try {
    renameWithRetry(tmp, filePath);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch {}
    throw e;
  }
}

module.exports = { writeJsonAtomic, writeFileAtomic: writeJsonAtomic };
