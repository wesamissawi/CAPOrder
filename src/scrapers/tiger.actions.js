const fs = require("fs");

const LOGIN_URL = "https://scarborough.tigeronlineorder.com/";
const DEFAULT_BRANCH = "Brampton";
const BRANCH_HOSTS = {
  Scarborough: "scarborough.tigeronlineorder.com",
  Brampton: "brampton.tigeronlineorder.com",
  Montreal: "montreal.tigeronlineorder.com",
  Cleveland: "cleveland.tigeronlineorder.com",
  Michigan: "michigan.tigeronlineorder.com",
  Chicago: "chicago.tigeronlineorder.com",
  Vancouver: "vancouver.tigeronlineorder.com",
};

function getCredentials(creds) {
  const user = (creds && (creds.user || creds.TIGER_USER || creds.username)) || process.env.TIGER_USER;
  const pass = (creds && (creds.pass || creds.TIGER_PASS || creds.password)) || process.env.TIGER_PASS;
  if (!user || !pass) {
    throw new Error("Missing TIGER credentials. Set them in Settings.");
  }
  return { user, pass };
}

function branchHost(branch) {
  return BRANCH_HOSTS[branch] || BRANCH_HOSTS[DEFAULT_BRANCH];
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

function originOf(page) {
  return new URL(page.url()).origin;
}

// Login if necessary and save session. Tiger's login form is gated by a
// "location" dropdown: username/password stay readonly until a branch is
// picked, and only on submit does a synchronous AJAX call
// (admin/check_user_or_ip_blocked.php) rewrite the form's action to the
// matching branch subdomain's dologins.php. We always start from the
// Scarborough gateway page and select the target branch there, mirroring
// exactly what a human does.
async function ensureLoggedIn(page, storageStatePath, statusLog = [], credentials, branch = DEFAULT_BRANCH) {
  const { user, pass } = getCredentials(credentials);
  const host = branchHost(branch);

  // Cheap session-validity check: hit the branch dashboard directly. If the
  // stored cookies are still good, the real dashboard renders; otherwise the
  // site serves the login form back.
  await page.goto(`https://${host}/admin/dashboard.php`, { waitUntil: "domcontentloaded" }).catch(() => null);
  const alreadyLoggedIn = !(await page.$("form#frmlog"));
  if (alreadyLoggedIn) {
    statusLog.push("Using stored Tiger session (dashboard loaded directly).");
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  await page.goto(LOGIN_URL, { waitUntil: "load" });
  await page.selectOption("#location", branch);
  await page.waitForTimeout(300);
  await page.fill("#username", user);
  await page.fill("#password", pass);

  statusLog.push(`Submitting Tiger login (${branch})…`);
  await Promise.all([
    page.click("#submit"),
    page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
  ]);
  await page.waitForTimeout(800);

  const stillOnLogin = await page.$("form#frmlog");
  if (stillOnLogin) {
    const blockText = await page.$eval("#blockdiv", (el) => el.textContent.trim()).catch(() => "");
    const otpText = await page.$eval("#otpmsg", (el) => el.textContent.trim()).catch(() => "");
    const shown = [blockText, otpText].filter(Boolean).join(" ");
    throw new Error(
      `Tiger login did not complete${shown ? `: ${shown}` : ""}. If OTP is being requested, log in manually once in a real browser first so the account is recognized.`
    );
  }

  await page.context().storageState({ path: storageStatePath });
  statusLog.push("Tiger login complete; session stored.");
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

// The statement table itself is populated by a chained pair of async AJAX
// calls (get_total_purchase_mr -> get_all_transactions) that replace a
// loading-spinner placeholder once done; waiting on #all_transactions alone
// only confirms the (empty) placeholder container exists, not that the rows
// have arrived.
async function waitForTransactionsLoaded(page, timeoutMs = 15000) {
  await page
    .waitForFunction(
      () => {
        const el = document.querySelector("#all_transactions");
        if (!el) return false;
        return !el.querySelector('img[alt="Loading..."]');
      },
      { timeout: timeoutMs }
    )
    .catch(() => {});
}

// period: 1 = current month, 2 = previous month, 3 = two months back, ... per
// the "Previous Statements" dropdown on mr.php (My Account).
async function goToStatement(page, statusLog = [], period = 1) {
  const origin = originOf(page);
  await page.goto(`${origin}/admin/mr.php`, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#all_transactions", { timeout: 15000 }).catch(() => {});
  await waitForTransactionsLoaded(page);

  if (period && period !== 1) {
    await page.evaluate((p) => {
      const sel = document.querySelector("#period");
      if (!sel) return;
      sel.value = String(p);
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    }, period);
    await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 15000 }).catch(() => null);
    await page.waitForSelector("#all_transactions", { timeout: 15000 }).catch(() => {});
    await waitForTransactionsLoaded(page);
  }
  statusLog.push(`Loaded Tiger statement (period=${period}).`);
}

async function scrapeStatementRows(page, statusLog = []) {
  const rows = await page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const money = (s) => {
      const n = parseFloat((s || "").replace(/[^0-9.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const container = document.querySelector("#all_transactions");
    if (!container) return [];
    const rowEls = Array.from(container.querySelectorAll(".row.clrRow.tbl1"));
    const out = [];
    for (const row of rowEls) {
      const get = (n) => norm(row.querySelector(`.col${n}`)?.innerText || "");
      const refLink = row.querySelector(".col3 a");
      if (!refLink) continue; // rows with no Ref # link are balance/payment lines, not orders
      const href = refLink.getAttribute("href") || "";
      if (!/view_order\.php/i.test(href)) continue; // "Return Credit"/"Payment" rows link elsewhere, not real orders
      const idMatch = href.match(/id=(\d+)/);
      const orderId = idMatch ? idMatch[1] : norm(refLink.textContent);
      const invLink = row.querySelector(".col4 a");
      const totalRaw = get(5);
      out.push({
        orderId,
        reference: orderId,
        orderDateRaw: get(1),
        description: get(2),
        detailUrl: href,
        invoiceNum: invLink ? norm(invLink.textContent) : "",
        invoiceUrl: invLink ? invLink.getAttribute("href") : "",
        totalRaw,
        total: money(totalRaw),
        creditRaw: get(6),
        balanceRaw: get(7),
        source: "tiger",
      });
    }
    return out;
  });
  statusLog.push(`Scraped ${rows.length} Tiger statement row(s).`);
  return rows;
}

async function fetchOrderDetail(context, origin, orderId) {
  if (!orderId) return { ok: false, reason: "no-order-id" };
  const page = await context.newPage();
  const url = `${origin}/admin/view_order.php?id=${encodeURIComponent(orderId)}`;

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 20000 });
    await page.waitForSelector("table.alternate", { timeout: 15000 });
  } catch (err) {
    await page.close();
    return { ok: false, error: `detail-navigation-failed (${err.message || err})` };
  }

  try {
    const detail = await page.evaluate(() => {
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const money = (s) => {
        const n = parseFloat((s || "").replace(/[^0-9.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const getInfo = (label) => {
        const head = Array.from(document.querySelectorAll(".info-head")).find(
          (h) => norm(h.textContent) === label
        );
        return norm(head?.nextElementSibling?.textContent || "");
      };

      const table = document.querySelector("table.alternate");
      const lineItems = [];
      const totals = {};
      if (table) {
        for (const tr of Array.from(table.querySelectorAll("tr"))) {
          if (tr.classList.contains("nobg")) {
            const labelCell = tr.querySelector("td.title");
            const label = norm(labelCell?.textContent || "").replace(/:$/, "");
            const value = norm(labelCell?.nextElementSibling?.textContent || "");
            if (label) totals[label.toLowerCase()] = { raw: value, value: money(value) };
            continue;
          }
          const tds = tr.querySelectorAll("td");
          if (tds.length < 7) continue; // header row or summary row, not a part line
          const partNumber = norm(tds[1]?.innerText || "");
          if (!partNumber) continue;
          const modelYear = norm(tds[2]?.innerText || "");
          const description = norm(tds[3]?.innerText || "");
          const qty = norm(tds[5]?.innerText || "") || norm(tds[4]?.innerText || "");
          const priceRaw = norm(tds[6]?.innerText || "");
          const totalRaw = norm(tds[7]?.innerText || "");
          lineItems.push({
            partNumber,
            partDescription: [modelYear, description].filter(Boolean).join(" - "),
            quantity: qty,
            costPrice: priceRaw,
            costPriceValue: money(priceRaw),
            extended: totalRaw,
            extendedValue: money(totalRaw),
            core: false,
          });
        }
      }

      return {
        customerPO: getInfo("Customer PO"),
        orderedBy: getInfo("Ordered By"),
        lineItems,
        totals,
      };
    });

    await page.close();
    return { ok: true, detail };
  } catch (err) {
    await page.close();
    return { ok: false, error: err.message || "detail-parse-failed" };
  }
}

module.exports = {
  createContextWithStorage,
  ensureLoggedIn,
  goToStatement,
  scrapeStatementRows,
  fetchOrderDetail,
  originOf,
  DEFAULT_BRANCH,
};
