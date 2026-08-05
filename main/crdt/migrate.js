// One-time seeding of the op log from the JSON files as they exist today.
//
// Runs once for the whole share, not once per machine. It is guarded by an
// exclusive-create marker so that if two machines start up together, exactly
// one seeds — the same wx-flag trick the sales-order sequence already uses to
// keep two machines from drawing the same number.
//
// Double-seeding would not corrupt anything (identical field values merge to
// identical state, and the merge is idempotent), but it would double the log
// for no reason, so it is worth preventing.
//
// Ordering note: seed ops are stamped in the order the records appear in the
// existing files. Because projections sort by birth stamp, the first files this
// writes back out are in the same row order as the files it read. Nothing in
// any view has to change.

const SEED_MARKER = 'seeded.json';

function readJsonFile(fs, file, fallback) {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf-8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw);
  } catch (e) {
    // Seeding reads real business data. Guessing "empty" here would publish an
    // empty CRDT over a populated share, so an unreadable file aborts the whole
    // migration instead.
    const err = new Error(`[crdt/migrate] cannot read ${file}: ${e?.message || e}`);
    err.code = 'SEED_READ_FAILED';
    throw err;
  }
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

// Turn the nested assignment ledger into the three flat entities.
function flattenLedger(ledger) {
  const orders = [];
  const lines = [];
  const records = [];
  for (const orderKey of Object.keys(ledger || {})) {
    const entry = ledger[orderKey] || {};
    orders.push({ orderKey, resolved: entry.resolved === true });
    const entryLines = entry.lines || {};
    for (const idx of Object.keys(entryLines)) {
      const line = entryLines[idx] || {};
      lines.push({ orderKey, lineIdx: idx, resolved: line.resolved === true });
      for (const assignment of asArray(line.assignments)) {
        if (!assignment) continue;
        records.push({ ...assignment, orderKey, lineIdx: idx });
      }
    }
  }
  return { orders, lines, records };
}

// Collect every record to seed, keyed by entity, from the legacy files.
function collectSeedData(fs, paths) {
  const bubbleFile = readJsonFile(fs, paths.sharedBubble, { bubbles: {} });
  const bubbles = Object.entries(bubbleFile?.bubbles || {}).map(([id, data]) => ({
    ...(data || {}),
    id,
  }));

  const ledger = flattenLedger(readJsonFile(fs, paths.orderAssignments, {}));

  // The three queue files carry the accountingPath implicitly (by which file a
  // row lives in). In the CRDT it is an explicit field, so stamp it here —
  // readQueueItems already did the same thing on every read.
  const items = [
    ...asArray(readJsonFile(fs, paths.outstanding, [])).map((it) => ({ ...it, accountingPath: 'OUTSTANDING' })),
    ...asArray(readJsonFile(fs, paths.sageAr, [])).map((it) => ({ ...it, accountingPath: 'SAGE_AR' })),
    ...asArray(readJsonFile(fs, paths.cashSales, [])).map((it) => ({ ...it, accountingPath: 'CASH_SALE' })),
  ];

  return {
    item: items,
    order: asArray(readJsonFile(fs, paths.orders, [])),
    orderArchive: asArray(readJsonFile(fs, paths.ordersArchive, [])),
    bubble: bubbles,
    assignOrder: ledger.orders,
    assignLine: ledger.lines,
    assignRecord: ledger.records,
    payment: asArray(readJsonFile(fs, paths.payments, [])),
    sageRun: asArray(readJsonFile(fs, paths.sageSalesRuns, [])),
    archivedBubble: asArray(readJsonFile(fs, paths.archived, [])),
    cloverEntry: asArray(readJsonFile(fs, paths.cloverLedger, [])),
  };
}

// Keep an untouched copy of every file the migration is about to take over.
// The projections will overwrite them within seconds, and while the content
// should be identical, "should be" is not what you want backing a live parts
// counter.
function backupOriginals(fs, path, paths, crdtDir) {
  const dir = path.join(crdtDir, 'pre-crdt-backup');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  let copied = 0;
  for (const file of Object.values(paths)) {
    try {
      if (!file || !fs.existsSync(file)) continue;
      const target = path.join(dir, `${path.basename(file)}.${stamp}`);
      // Read-then-write, never copyFileSync: a Windows copy holds the source
      // without delete-sharing and makes another machine's atomic replace of
      // that same file fail with EPERM.
      fs.writeFileSync(target, fs.readFileSync(file));
      copied += 1;
    } catch (e) {
      console.warn('[crdt/migrate] backup failed for', file, e?.message || e);
    }
  }
  return { dir, copied };
}

// Claim the right to seed. Returns false if another machine already has.
function claimSeed(fs, path, crdtDir, machineId) {
  const marker = path.join(crdtDir, SEED_MARKER);
  if (fs.existsSync(marker)) return false;
  fs.mkdirSync(crdtDir, { recursive: true });
  try {
    fs.writeFileSync(
      marker,
      JSON.stringify({ by: machineId, at: new Date().toISOString(), pending: true }, null, 2),
      { flag: 'wx' } // exclusive create: loses harmlessly if another machine won
    );
    return true;
  } catch (e) {
    if (e?.code === 'EEXIST') return false;
    throw e;
  }
}

function finishSeed(fs, path, crdtDir, machineId, summary) {
  const marker = path.join(crdtDir, SEED_MARKER);
  fs.writeFileSync(
    marker,
    JSON.stringify({ by: machineId, at: new Date().toISOString(), pending: false, summary }, null, 2),
    'utf-8'
  );
}

// Run the migration if it hasn't been run. Safe to call on every startup.
function seedIfNeeded(deps) {
  const { fs, path, crdtDir, machineId, paths, store } = deps;
  const marker = path.join(crdtDir, SEED_MARKER);

  if (fs.existsSync(marker)) {
    return { seeded: false, reason: 'already-seeded' };
  }
  if (!claimSeed(fs, path, crdtDir, machineId)) {
    return { seeded: false, reason: 'another-machine-is-seeding' };
  }

  let data;
  try {
    data = collectSeedData(fs, paths);
  } catch (e) {
    // Release the claim so the next start (or another machine) can retry —
    // leaving a pending marker behind would block seeding forever.
    try { fs.unlinkSync(marker); } catch {}
    throw e;
  }

  const backup = backupOriginals(fs, path, paths, crdtDir);
  const summary = { backup: backup.dir, counts: {} };

  try {
    for (const entity of Object.keys(data)) {
      const records = data[entity];
      if (!records.length) continue;
      // skipRefresh: nothing else can be writing yet, and re-reading the logs
      // between every entity would be pure overhead on a first run.
      store.commit(entity, records, { skipRefresh: true });
      summary.counts[entity] = records.length;
    }
  } catch (e) {
    try { fs.unlinkSync(marker); } catch {}
    throw e;
  }

  // Fold the whole seed into a snapshot immediately: without it, every machine
  // joining afterwards would replay the entire history on startup.
  store.writeSnapshot();
  finishSeed(fs, path, crdtDir, machineId, summary);

  console.log('[crdt/migrate] seeded', JSON.stringify(summary.counts), '| backup:', backup.dir);
  return { seeded: true, summary };
}

module.exports = { seedIfNeeded, collectSeedData, flattenLedger, SEED_MARKER };
