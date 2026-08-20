// Last line of defence for the main process.
//
// Without this, an unhandled error in main goes to Electron's default handler:
// a raw "A JavaScript error occurred in the main process" dialog, no stack kept
// anywhere, and — on a machine running ghost mode unattended — nobody there to
// dismiss it. The shared data dir makes that a live risk rather than a
// theoretical one: it is an SMB share, and a file renamed out from under a
// reader there reports UNKNOWN, not the ENOENT every caller guards against.
// Observed on RIAD-2: lstat of a cash_sales_items.json.tmp.* that a projection
// write had renamed away microseconds earlier, which killed the app.
//
// So: every uncaught error is appended to main_errors.log with its stack, plus
// a one-line summary on the share so a crash on an unattended machine can be
// read from any other one. A transient shared-file error is then survived
// rather than fatal; anything else still raises a dialog — but the process
// stays up either way, because dying mid-cycle costs more than the error did.

// The codes Windows/SMB hands out for a file that is being replaced, locked, or
// has just gone. UNKNOWN is the important one: it is what a delete-pending file
// on a network share reports where a local disk would say ENOENT, so code that
// tolerates a missing file does not tolerate this.
const TRANSIENT_FS_CODES = new Set([
  'UNKNOWN',
  'ENOENT',
  'EPERM',
  'EACCES',
  'EBUSY',
  'EIO',
  'ETIMEDOUT',
  'EBADF',
]);

// "<name>.tmp.<pid>.<millis>" — the temp file writeJsonAtomic renames into
// place. Matched by hand rather than by regex so the shape stays obvious.
function isAtomicWriteTemp(basename) {
  const marker = basename.indexOf('.tmp.');
  if (marker <= 0) return false;
  const tail = basename.slice(marker + '.tmp.'.length).split('.');
  return (
    tail.length === 2 &&
    tail.every((part) => part.length > 0 && Number.isFinite(Number(part)))
  );
}

function createRaceTest({ path, getSharedDataDir }) {
  return function looksLikeSharedFileRace(err) {
    if (!err || !TRANSIENT_FS_CODES.has(err.code)) return false;
    const target = String(err.path || err.dest || '');
    if (!target) return false;
    if (isAtomicWriteTemp(path.basename(target))) return true;
    let shared = '';
    try {
      shared = (getSharedDataDir() || '').toString().trim();
    } catch {
      shared = '';
    }
    return Boolean(shared) && target.toLowerCase().startsWith(shared.toLowerCase());
  };
}

function installCrashGuard(deps) {
  const { app, dialog, fs, path, instanceDir, getSharedDataDir, getMachineId } = deps;
  const crashLog = path.join(instanceDir, 'main_errors.log');
  const looksLikeSharedFileRace = createRaceTest({ path, getSharedDataDir });

  function describe(err) {
    return `code=${err && err.code ? err.code : '-'} syscall=${
      err && err.syscall ? err.syscall : '-'
    } path=${err && err.path ? err.path : '-'}`;
  }

  function record(kind, err) {
    const at = new Date().toISOString();
    let machine = 'unknown';
    try {
      machine = getMachineId() || 'unknown';
    } catch {}
    let version = '?';
    try {
      version = app.getVersion();
    } catch {}
    const head = describe(err);
    const stack = (err && err.stack) || String(err);
    console.error(`[main] ${kind} on ${machine} — ${head}`, err);

    try {
      fs.appendFileSync(
        crashLog,
        `=== ${at} ${kind} (${machine}, v${version})\n${head}\n${stack}\n\n`,
        'utf-8'
      );
    } catch {}

    // Best effort, and deliberately last: the share is often exactly what just
    // failed, so this must never be able to take the handler down with it.
    try {
      const shared = (getSharedDataDir() || '').toString().trim();
      if (shared) {
        const line = JSON.stringify({
          at,
          machine,
          version,
          kind,
          code: (err && err.code) || null,
          syscall: (err && err.syscall) || null,
          path: (err && err.path) || null,
          message: (err && err.message) || String(err),
          stack: String(stack).split('\n').slice(0, 8).join(' | '),
        });
        fs.appendFileSync(path.join(shared, 'main_errors.jsonl'), `${line}\n`, 'utf-8');
      }
    } catch {}
  }

  process.on('uncaughtException', (err) => {
    record('uncaughtException', err);
    if (looksLikeSharedFileRace(err)) {
      console.warn(
        '[main] survived a transient shared-file error —',
        (err && err.path) || ''
      );
      return;
    }
    try {
      dialog.showErrorBox(
        'Something went wrong',
        `${(err && err.message) || err}\n\nThe app is still running. Details were written to:\n${crashLog}`
      );
    } catch {}
  });

  process.on('unhandledRejection', (reason) => {
    record('unhandledRejection', reason instanceof Error ? reason : new Error(String(reason)));
  });

  return { crashLog, looksLikeSharedFileRace };
}

module.exports = { installCrashGuard, isAtomicWriteTemp, TRANSIENT_FS_CODES };
