// Moving scraper credentials + Gmail auth from one workstation to another.
//
// These settings deliberately do NOT live on the share: they are per-machine,
// they are secrets, and the CRDT store replicates business data, not passwords.
// But typing eight vendor logins plus a Gmail OAuth client into every new
// workstation by hand is its own kind of mistake, so this is a one-shot
// hand-off, not a sync:
//
//   1. The machine that NEEDS credentials posts a request into
//      <share>/cred_sync/requests/<machine>.json — a name and a timestamp,
//      nothing sensitive.
//   2. A machine that HAS them sees the request in Settings and clicks Send.
//      The credential subset is encrypted with a 6-digit pairing code that is
//      shown on screen and never written anywhere, then dropped in
//      <share>/cred_sync/grants/<machine>.json.
//   3. The requesting machine types the code (read off the other screen, or
//      over the phone) and the payload decrypts into its local config.json.
//
// The pairing code is the whole point of the design. The shared folder is a
// plain SMB share that every workstation — and whoever else has the UNC path —
// can read, so a grant sitting there in cleartext would be strictly worse than
// the status quo of typing passwords in by hand. Encrypted, the file on the
// share is inert: without the code, which travels out-of-band between two
// people looking at two screens, it decrypts to nothing.
//
// Grants are single-use and expire (see GRANT_TTL_MS). A wrong code burns an
// attempt; MAX_ATTEMPTS wrong codes destroy the grant and the sender has to
// send again, which is what stops the file being brute-forced offline at
// leisure. (A determined attacker who copies the file off the share can still
// grind it offline — scrypt at these parameters buys time, not immunity.
// That's the accepted trade for a 6-digit code people can read aloud.)

const crypto = require('crypto');

// What a grant carries. Credentials and Gmail auth: the things that are
// identical on every workstation because they identify the BUSINESS to a
// vendor, not the machine to the business.
//
// INVOICE_PRINTER is deliberately absent — it names hardware sitting next to
// one particular desk, and copying it would silently point a new machine at a
// printer in another room.
const SHARED_CONFIG_KEYS = [
  // vendor logins
  'WORLD_USER',
  'WORLD_PASS',
  'TRANSBEC_USER',
  'TRANSBEC_PASS',
  'TRANSBEC_MAX_PAGES',
  'CBK_USER',
  'CBK_PASS',
  'TIGER_USER',
  'TIGER_PASS',
  'BESTBUY_USER',
  'BESTBUY_PASS',
  'PROFORCE_STORE',
  'PROFORCE_CUSTOMER',
  'PROFORCE_PASS',
  // Gmail: the OAuth app plus the token minted against it. The refresh token is
  // bound to the client id/secret and the mailbox, not to a machine, so it
  // keeps working on the receiving machine — which is exactly why the three
  // have to travel together or not at all.
  'GMAIL_CLIENT_ID',
  'GMAIL_CLIENT_SECRET',
  'GMAIL_REFRESH_TOKEN',
  // which mail counts as which vendor's invoices
  'WORLD_INVOICE_SENDER',
  'WORLD_INVOICE_SUBJECT',
  'TRANSBEC_INVOICE_SENDER',
  'TRANSBEC_INVOICE_SUBJECT',
  'BESTBUY_INVOICE_SENDER',
  'BESTBUY_INVOICE_SUBJECT',
  'BESTBUY_CREDIT_INVOICE_SENDER',
  'BESTBUY_CREDIT_INVOICE_SUBJECT',
  'CBK_INVOICE_SENDER',
  'CBK_INVOICE_SUBJECT',
  'TRANSBEC_CREDIT_INVOICE_SENDER',
  'TRANSBEC_CREDIT_INVOICE_SUBJECT',
];

// Keys whose VALUE must never be shown back to a user or logged — the UI lists
// what a grant contains by key name, and these are the ones that get a "•••"
// instead of a preview.
const SECRET_KEYS = new Set(
  SHARED_CONFIG_KEYS.filter((k) => /_PASS$|_SECRET$|_TOKEN$/.test(k))
);

const SYNC_DIRNAME = 'cred_sync';
const REQUESTS_DIRNAME = 'requests';
const GRANTS_DIRNAME = 'grants';

// A request is a person walking to another desk. If nobody has acted on it in
// a day it is stale, not pending.
const REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
// A grant is a code being read off a screen. Thirty minutes is generous for
// that and short enough that a forgotten grant is not left lying on the share.
const GRANT_TTL_MS = 30 * 60 * 1000;
const MAX_ATTEMPTS = 5;

const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keylen: 32 };

const createCredentialSyncService = (deps) => {
  // loadConfig/saveConfig, NOT readConfig/writeConfig + `userConfig`.
  //
  // config.json has two credential-shaped places in it and only one is live.
  // The Settings screen saves through config:set -> saveConfig(), which merges
  // into the TOP LEVEL of the file, and every scraper reads them back with
  // loadConfig(). The nested `userConfig` block belongs to the older
  // config:read/config:write pair and is empty on a real install. Reading the
  // wrong one is silent — it yields {} and the UI just offers "Send 0
  // setting(s)" — so keep this pinned to the same pair the scrapers use.
  const {
    fs,
    path,
    getSharedDataDir,
    getSharedDirInfo,
    getMachineId,
    loadConfig,
    saveConfig,
    writeJsonAtomic,
  } = deps;

  // ---- paths -------------------------------------------------------------

  // Machine ids are hostnames, and a hostname can legally contain characters
  // that a filename cannot. Slugify for the filename but keep the real id in
  // the file body — the slug is an address, the id is the identity.
  function slug(machineId) {
    return String(machineId || 'unknown')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 64) || 'unknown';
  }

  const syncDir = () => path.join(getSharedDataDir(), SYNC_DIRNAME);
  const requestsDir = () => path.join(syncDir(), REQUESTS_DIRNAME);
  const grantsDir = () => path.join(syncDir(), GRANTS_DIRNAME);
  const requestFileFor = (machineId) => path.join(requestsDir(), `${slug(machineId)}.json`);
  const grantFileFor = (machineId) => path.join(grantsDir(), `${slug(machineId)}.json`);

  function ensureDirs() {
    try {
      fs.mkdirSync(requestsDir(), { recursive: true });
      fs.mkdirSync(grantsDir(), { recursive: true });
    } catch (e) {
      console.error('[cred-sync] could not create sync dirs', e?.message || e);
    }
  }

  // Every entry point needs the same answer to "is there even a share?" — with
  // no shared folder configured, getSharedDataDir() falls back to the instance
  // dir and this would silently become a machine talking to itself.
  function requireShare() {
    const { sharedConfigured } = getSharedDirInfo();
    if (!sharedConfigured) {
      return { ok: false, error: 'No shared folder is configured. Set one under Shared Data Folder first.' };
    }
    return null;
  }

  function readJson(file) {
    try {
      if (!fs.existsSync(file)) return null;
      const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  function removeFile(file) {
    try { fs.unlinkSync(file); } catch {}
  }

  // ---- crypto ------------------------------------------------------------

  // Six digits, uniformly distributed. randomInt rejects internally rather than
  // taking a modulo, so 000000-999999 are equally likely.
  function makePairingCode() {
    return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
  }

  function deriveKey(code, saltB64) {
    return crypto.scryptSync(
      String(code).trim(),
      Buffer.from(saltB64, 'base64'),
      SCRYPT_PARAMS.keylen,
      { N: SCRYPT_PARAMS.N, r: SCRYPT_PARAMS.r, p: SCRYPT_PARAMS.p }
    );
  }

  function encryptPayload(payload, code) {
    const salt = crypto.randomBytes(16);
    const iv = crypto.randomBytes(12);
    const key = deriveKey(code, salt.toString('base64'));
    const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(payload), 'utf-8'),
      cipher.final(),
    ]);
    return {
      alg: 'aes-256-gcm',
      kdf: 'scrypt',
      kdfParams: { ...SCRYPT_PARAMS },
      salt: salt.toString('base64'),
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      ciphertext: ciphertext.toString('base64'),
    };
  }

  // Returns null on a bad code rather than throwing: GCM tag failure IS the
  // wrong-code signal, and it is not exceptional here — it's the expected
  // outcome of a typo.
  function decryptPayload(env, code) {
    try {
      const key = deriveKey(code, env.salt);
      const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(env.iv, 'base64'));
      decipher.setAuthTag(Buffer.from(env.tag, 'base64'));
      const plain = Buffer.concat([
        decipher.update(Buffer.from(env.ciphertext, 'base64')),
        decipher.final(),
      ]).toString('utf-8');
      const parsed = JSON.parse(plain);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
      return null;
    }
  }

  // ---- what a machine has to give ---------------------------------------

  // Only keys that are actually set travel. A machine that has never configured
  // Tiger should not push an empty TIGER_USER over a receiving machine's
  // working one.
  function collectSharedConfig() {
    const cfg = loadConfig();
    const out = {};
    SHARED_CONFIG_KEYS.forEach((key) => {
      const value = cfg[key];
      if (value === undefined || value === null) return;
      if (typeof value === 'string' && !value.trim()) return;
      out[key] = value;
    });
    return out;
  }

  function describeKeys(payload) {
    return Object.keys(payload).map((key) => ({
      key,
      secret: SECRET_KEYS.has(key),
      preview: SECRET_KEYS.has(key) ? '•••' : String(payload[key]),
    }));
  }

  // ---- requesting machine ------------------------------------------------

  function requestCredentials() {
    const blocked = requireShare();
    if (blocked) return blocked;
    ensureDirs();
    const machineId = getMachineId();
    const record = {
      machineId,
      requestedAt: new Date().toISOString(),
      // Which of the shareable keys this machine is missing, so the sender can
      // see at a glance whether the request is "new machine, has nothing" or
      // "just needs the Gmail token".
      missingKeys: SHARED_CONFIG_KEYS.filter((k) => !(k in collectSharedConfig())),
    };
    try {
      writeJsonAtomic(requestFileFor(machineId), JSON.stringify(record, null, 2));
      return { ok: true, request: record };
    } catch (e) {
      console.error('[cred-sync] request failed', e);
      return { ok: false, error: e?.message || 'Could not post the request to the shared folder.' };
    }
  }

  function cancelRequest() {
    const blocked = requireShare();
    if (blocked) return blocked;
    removeFile(requestFileFor(getMachineId()));
    return { ok: true };
  }

  // What this machine is waiting on: its own outstanding request, and any grant
  // that has been left for it. Metadata only — nothing here is decrypted.
  function getInboundStatus() {
    const { sharedConfigured } = getSharedDirInfo();
    if (!sharedConfigured) return { ok: true, sharedConfigured: false, request: null, grant: null };

    const machineId = getMachineId();
    const request = readJson(requestFileFor(machineId));

    const grantFile = grantFileFor(machineId);
    const raw = readJson(grantFile);
    let grant = null;
    if (raw) {
      if (Date.parse(raw.expiresAt || '') <= Date.now()) {
        removeFile(grantFile);
      } else {
        grant = {
          id: raw.id,
          from: raw.from,
          createdAt: raw.createdAt,
          expiresAt: raw.expiresAt,
          keys: Array.isArray(raw.keys) ? raw.keys : [],
          attemptsUsed: Number(raw.attempts) || 0,
          attemptsLeft: Math.max(0, MAX_ATTEMPTS - (Number(raw.attempts) || 0)),
        };
      }
    }
    return { ok: true, sharedConfigured: true, machineId, request, grant };
  }

  function redeemGrant(code) {
    const blocked = requireShare();
    if (blocked) return blocked;

    const entered = String(code || '').replace(/\D/g, '');
    if (entered.length !== 6) return { ok: false, error: 'Enter the 6-digit code shown on the sending machine.' };

    const machineId = getMachineId();
    const grantFile = grantFileFor(machineId);
    const grant = readJson(grantFile);
    if (!grant) return { ok: false, error: 'No credentials are waiting for this machine.' };
    if (Date.parse(grant.expiresAt || '') <= Date.now()) {
      removeFile(grantFile);
      return { ok: false, error: 'That transfer expired. Ask the other machine to send again.' };
    }

    const payload = decryptPayload(grant, entered);
    if (!payload) {
      // Burn the attempt on the share, where the count survives this machine
      // being restarted mid-guess.
      const attempts = (Number(grant.attempts) || 0) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        removeFile(grantFile);
        return { ok: false, error: 'Too many wrong codes — the transfer was destroyed. Ask the other machine to send again.' };
      }
      try {
        writeJsonAtomic(grantFile, JSON.stringify({ ...grant, attempts }, null, 2));
      } catch (e) {
        console.error('[cred-sync] could not record failed attempt', e?.message || e);
      }
      return { ok: false, error: `Wrong code. ${MAX_ATTEMPTS - attempts} attempt(s) left.` };
    }

    // Merge, don't replace. saveConfig() folds a partial into the existing
    // file, so anything this grant doesn't carry keeps its local value —
    // INVOICE_PRINTER above all, but also windowBounds/dataFile/ordersFile,
    // which share the top level with the credentials.
    const imported = {};
    try {
      SHARED_CONFIG_KEYS.forEach((key) => {
        if (!(key in payload)) return;
        imported[key] = payload[key];
      });
      saveConfig(imported);
    } catch (e) {
      console.error('[cred-sync] import failed', e);
      return { ok: false, error: e?.message || 'Could not save the received credentials.' };
    }

    // Single use. The grant is consumed whether or not the request file is
    // still around, and this machine's request is answered.
    removeFile(grantFile);
    removeFile(requestFileFor(machineId));
    const importedKeys = Object.keys(imported);
    return { ok: true, imported: importedKeys, count: importedKeys.length, from: grant.from || '' };
  }

  // ---- sending machine ---------------------------------------------------

  function listRequests() {
    const { sharedConfigured } = getSharedDirInfo();
    if (!sharedConfigured) return { ok: true, sharedConfigured: false, requests: [] };
    ensureDirs();

    const ownId = getMachineId();
    const ownSlug = slug(ownId);
    let files = [];
    try {
      files = fs.readdirSync(requestsDir()).filter((f) => f.endsWith('.json'));
    } catch {
      return { ok: true, sharedConfigured: true, requests: [] };
    }

    const requests = [];
    files.forEach((file) => {
      if (file === `${ownSlug}.json`) return; // our own ask, not ours to answer
      const full = path.join(requestsDir(), file);
      const record = readJson(full);
      if (!record || !record.machineId) return;
      const requestedAt = Date.parse(record.requestedAt || '');
      if (!Number.isFinite(requestedAt) || Date.now() - requestedAt > REQUEST_TTL_MS) {
        removeFile(full);
        return;
      }
      // A grant already sitting in the outbox means this one has been answered
      // and is waiting on a code, not on a person.
      const pendingGrant = readJson(grantFileFor(record.machineId));
      const grantLive = pendingGrant && Date.parse(pendingGrant.expiresAt || '') > Date.now();
      requests.push({
        machineId: record.machineId,
        requestedAt: record.requestedAt,
        missingKeys: Array.isArray(record.missingKeys) ? record.missingKeys : [],
        awaitingCode: Boolean(grantLive),
        grantExpiresAt: grantLive ? pendingGrant.expiresAt : null,
      });
    });
    requests.sort((a, b) => String(a.requestedAt).localeCompare(String(b.requestedAt)));
    return { ok: true, sharedConfigured: true, requests };
  }

  // Returns the pairing code. It is generated here, handed to the UI once, and
  // never persisted — not in the grant file, not in a log. Losing it means
  // sending again, which is the correct failure mode.
  function sendCredentials(targetMachineId) {
    const blocked = requireShare();
    if (blocked) return blocked;
    const target = String(targetMachineId || '').trim();
    if (!target) return { ok: false, error: 'No machine selected.' };
    if (slug(target) === slug(getMachineId())) {
      return { ok: false, error: 'That is this machine.' };
    }

    const payload = collectSharedConfig();
    const keys = Object.keys(payload);
    if (!keys.length) {
      return { ok: false, error: 'This machine has no credentials saved to send.' };
    }

    ensureDirs();
    const code = makePairingCode();
    const now = Date.now();
    const grant = {
      id: crypto.randomUUID(),
      from: getMachineId(),
      to: target,
      createdAt: new Date(now).toISOString(),
      expiresAt: new Date(now + GRANT_TTL_MS).toISOString(),
      attempts: 0,
      // Key NAMES only — so the receiving machine can show what it is about to
      // import before it has the code. The values are inside the envelope.
      keys,
      ...encryptPayload(payload, code),
    };

    try {
      writeJsonAtomic(grantFileFor(target), JSON.stringify(grant, null, 2));
    } catch (e) {
      console.error('[cred-sync] send failed', e);
      return { ok: false, error: e?.message || 'Could not write the transfer to the shared folder.' };
    }

    return {
      ok: true,
      code,
      to: target,
      expiresAt: grant.expiresAt,
      keys: describeKeys(payload),
      count: keys.length,
    };
  }

  // Pull a sent-but-unredeemed grant back off the share.
  function revokeGrant(targetMachineId) {
    const blocked = requireShare();
    if (blocked) return blocked;
    const target = String(targetMachineId || '').trim();
    if (!target) return { ok: false, error: 'No machine selected.' };
    removeFile(grantFileFor(target));
    return { ok: true };
  }

  // What this machine would hand over, for the confirm step before sending.
  function previewOutgoing() {
    const payload = collectSharedConfig();
    return { ok: true, keys: describeKeys(payload), count: Object.keys(payload).length };
  }

  return {
    requestCredentials,
    cancelRequest,
    getInboundStatus,
    redeemGrant,
    listRequests,
    sendCredentials,
    revokeGrant,
    previewOutgoing,
    SHARED_CONFIG_KEYS,
  };
};

module.exports = { createCredentialSyncService, SHARED_CONFIG_KEYS };
