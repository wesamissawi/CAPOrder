const fs = require("fs");

const BASE_URL = "https://orderstransbec.com";
const HOME_URL = `${BASE_URL}/store/home`;
const ORDERS_URL = `${BASE_URL}/store/order-history`;
const LANG_EN_URL = `${BASE_URL}/store/lang-english/`;

function getCredentials(creds) {
  const user =
    (creds && (creds.user || creds.TRANSBEC_USER || creds.username)) || process.env.TRANSBEC_USER;
  const pass =
    (creds && (creds.pass || creds.TRANSBEC_PASS || creds.password)) || process.env.TRANSBEC_PASS;
  if (!user || !pass) throw new Error("Missing TRANSBEC credentials. Set them in Settings.");
  return { user, pass };
}

async function createContextWithStorage(browser, storageStatePath) {
  if (fs.existsSync(storageStatePath)) {
    return browser.newContext({ storageState: storageStatePath });
  }
  return browser.newContext();
}

function normalizeMonthToken(raw) {
  let s = String(raw || "").toLowerCase();
  // Fix common mojibake (UTF-8 decoded as Latin-1)
  s = s.replace(/\u00c3\u00a9/g, "e").replace(/\u00c3\u00bb/g, "u");
  // Strip diacritics when possible
  try {
    s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  } catch (_) {}
  return s.replace(/[^a-z]/g, "");
}

function parseTransbecDate(txt) {
  const monthMap = {
    jan: "01",
    feb: "02",
    mar: "03",
    apr: "04",
    avr: "04",
    mai: "05",
    may: "05",
    jun: "06",
    juin: "06",
    jui: "07",
    juil: "07",
    jul: "07",
    aug: "08",
    aou: "08",
    sep: "09",
    oct: "10",
    nov: "11",
    dec: "12",
  };
  if (!txt) return { iso: null, sageDate: "" };
  const clean = String(txt).trim();
  const match = clean.match(
    /([A-Za-z\u00c0-\u017f]{3,})\.?\s*(\d{1,2}),\s*(\d{4})(?:\s*at\s*(\d{1,2}):(\d{2})\s*(AM|PM|EST|EDT)?)?/i
  );
  if (!match) return { iso: null, sageDate: "" };
  const normalized = normalizeMonthToken(match[1]);
  const monthKey = monthMap[normalized.slice(0, 4)] ? normalized.slice(0, 4) : normalized.slice(0, 3);
  const month = monthMap[monthKey] || "";
  const day = match[2].padStart(2, "0");
  const year = match[3];
  let hour = match[4] ? parseInt(match[4], 10) : 0;
  const minute = match[5] ? parseInt(match[5], 10) : 0;
  const ampm = (match[6] || "").toUpperCase();
  if (ampm === "PM" && hour < 12) hour += 12;
  if (ampm === "AM" && hour === 12) hour = 0;
  if (!month) return { iso: null, sageDate: "" };
  const iso = new Date(Date.UTC(Number(year), Number(month) - 1, Number(day), hour, minute, 0)).toISOString();
  return { iso, sageDate: `${day}${month}${year.slice(-2)}` };
}

async function ensureEnglish(page) {
  try {
    await page.goto(LANG_EN_URL, { waitUntil: "domcontentloaded" });
    await page.waitForTimeout(800);
  } catch (e) {
    console.warn("[transbec] Unable to switch language to English:", e.message || e);
  }
}

async function findFirst(page, selectors) {
  for (const sel of selectors) {
    const handle = await page.$(sel);
    if (handle) return handle;
  }
  return null;
}

async function findVisibleLocator(page, selectors) {
  for (const sel of selectors) {
    const handles = await page.$$(sel);
    if (!handles.length) continue;
    for (let i = 0; i < handles.length; i++) {
      const h = handles[i];
      if (await h.isVisible().catch(() => false)) return h;
      try {
        await h.evaluate((el) => {
          el.style.display = "block";
          el.style.visibility = "visible";
          el.style.opacity = "1";
          el.removeAttribute("hidden");
        });
        if (await h.isVisible().catch(() => false)) return h;
      } catch (_) {}
    }
  }
  return null;
}

async function dismissOverlays(page) {
  try {
    const overlay = page.locator("#saoverlaycontainer");
    if (await overlay.isVisible().catch(() => false)) {
      await overlay.evaluate((el) => {
        el.style.display = "none";
      });
    }
  } catch (_) {}
}

async function ensureLoggedIn(page, storageStatePath, credentials) {
  const { user, pass } = getCredentials(credentials);
  await ensureEnglish(page);
  await page.goto(HOME_URL, { waitUntil: "domcontentloaded" });
  await page
    .waitForSelector(
      "#loginform form, #loginemail, #loginpassword, form[action*='login'], form[action=''], input[name='tmplusername']",
      { timeout: 15000 }
    )
    .catch(() => {});

  const logoutBtn = await page.$("#logoutbutton");
  if (logoutBtn) {
    await ensureEnglish(page);
    await page.context().storageState({ path: storageStatePath });
    return { loggedIn: true, usedStoredSession: true, loginPerformed: false };
  }

  await dismissOverlays(page);

  const loginLink = await findFirst(page, [
    'a[href*="user-login"]',
    'a[href*="login"]',
    "#headbtnlogin a",
    "#loginbutton",
  ]);
  if (loginLink) {
    await Promise.all([
      loginLink.click(),
      page.waitForTimeout(400),
    ]);
  }

  const usernameLocator =
    (await findVisibleLocator(page, [
      "#loginemail",
      'input[name="tmplusername"]',
      'input[name="username"]',
      'input[name="userid"]',
      "#username",
      "#userid",
      'input[type="text"][name*="user" i]',
      'input[type="email"]',
    ])) || page.locator("#loginemail").first() || page.locator('input[name="tmplusername"]').first();

  const passwordLocator =
    (await findVisibleLocator(page, [
      "#loginpassword",
      'input[name="tmplpassword"]',
      'input[type="password"]',
      'input[name*="pass" i]',
    ])) || page.locator("#loginpassword").first() || page.locator('input[name="tmplpassword"]').first();

  if (!usernameLocator || !passwordLocator) {
    // Last resort: force-fill via DOM visibility filtering
    const domFill = await page.evaluate(([u, p]) => {
      const pickVisible = (nodes) => nodes.find((n) => n && n.offsetParent !== null) || nodes[0];
      const uEl = pickVisible(
        Array.from(
          document.querySelectorAll('#sidesearch #loginemail, #loginform #loginemail, input[name="tmplusername"], input#loginemail')
        )
      );
      const pEl = pickVisible(
        Array.from(
          document.querySelectorAll('#sidesearch #loginpassword, #loginform #loginpassword, input[name="tmplpassword"], input#loginpassword')
        )
      );
      if (uEl) {
        uEl.value = u;
        uEl.dispatchEvent(new Event("input", { bubbles: true }));
        uEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      if (pEl) {
        pEl.value = p;
        pEl.dispatchEvent(new Event("input", { bubbles: true }));
        pEl.dispatchEvent(new Event("change", { bubbles: true }));
      }
      return { uOk: Boolean(uEl), pOk: Boolean(pEl) };
    }, [user, pass]);

    if (!domFill?.uOk || !domFill?.pOk) {
      throw new Error("Could not locate Transbec login inputs on the page.");
    }
  } else {
    await usernameLocator.scrollIntoViewIfNeeded().catch(() => {});
    await passwordLocator.scrollIntoViewIfNeeded().catch(() => {});

    try {
      await usernameLocator.fill(user, { timeout: 5000 });
      await passwordLocator.fill(pass, { timeout: 5000 });
    } catch (_) {
      await page.evaluate(
        ([u, p]) => {
          const uEl =
            document.querySelector("#loginemail") ||
            document.querySelector('input[name="tmplusername"]') ||
            document.querySelector('input[name="username"]');
          const pEl =
            document.querySelector("#loginpassword") ||
            document.querySelector('input[name="tmplpassword"]') ||
            document.querySelector('input[type="password"]');
          if (uEl) {
            uEl.value = u;
            uEl.dispatchEvent(new Event("input", { bubbles: true }));
            uEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
          if (pEl) {
            pEl.value = p;
            pEl.dispatchEvent(new Event("input", { bubbles: true }));
            pEl.dispatchEvent(new Event("change", { bubbles: true }));
          }
        },
        [user, pass]
      );
    }
  }

  const remember = await findFirst(page, [
    'input[type="checkbox"][name*="remember" i]',
    'input[type="checkbox"][id*="remember" i]',
    'input[name="tmplrememberme"]',
  ]);
  if (remember) {
    try {
      const checked = await remember.isChecked();
      if (!checked) await remember.check();
    } catch (e) {
      console.warn("[transbec] failed to tick remember checkbox", e);
    }
  }

  await dismissOverlays(page);

  // Click visible login button, prefer ones in the sidebar/login form
  const buttonSelectors = [
    "#sidesearch button[name='tmplloginsubmit']",
    "#loginform button[name='tmplloginsubmit']",
    "button[name='tmplloginsubmit']",
    "button[type='submit']",
    "input[type='submit']",
  ];

  let clicked = false;
  for (const sel of buttonSelectors) {
    const handles = await page.$$(sel);
    for (const h of handles) {
      if (!(await h.isVisible().catch(() => false))) continue;
      await h.scrollIntoViewIfNeeded().catch(() => {});
      try {
        await Promise.all([
          h.click({ timeout: 5000 }),
          page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
        ]);
        clicked = true;
        break;
      } catch (_) {
        // try next
      }
    }
    if (clicked) break;
  }

  if (!clicked) {
    const domClicked = await page.evaluate(() => {
      const pickVisible = (nodes) => nodes.find((n) => n && n.offsetParent !== null) || nodes[0];
      const btn = pickVisible(
        Array.from(
          document.querySelectorAll(
            "#sidesearch button[name='tmplloginsubmit'], #loginform button[name='tmplloginsubmit'], button[type='submit'], input[type='submit']"
          )
        )
      );
      if (btn) {
        btn.click();
        return true;
      }
      return false;
    });
    if (domClicked) {
      await page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null);
      clicked = true;
    }
  }

  if (!clicked && passwordLocator) {
    await Promise.all([
      passwordLocator.press("Enter").catch(() => {}),
      page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }).catch(() => null),
    ]);
  }

  await ensureEnglish(page);
  await page.context().storageState({ path: storageStatePath });
  return { loggedIn: true, usedStoredSession: false, loginPerformed: true };
}

async function parseOrdersFromPage(page) {
  return page.evaluate(() => {
    const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
    const num = (s) => {
      const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
      return Number.isFinite(n) ? n : null;
    };
    const rows = Array.from(document.querySelectorAll("#orders tr"));
    const orders = rows
      .map((tr, rowIndex) => {
        const cells = tr.querySelectorAll("td");
        const link = cells[1]?.querySelector("a");
        const modalCandidate =
          link?.getAttribute("onclick") ||
          cells[0]?.querySelector("a")?.getAttribute("onclick") ||
          "";
        const modalMatch = modalCandidate.match(/openOrderViewModal\(['"]([^'"]+)/);
        const modalUrl = modalMatch ? modalMatch[1] : "";

        const totalPages = Array.from(
          document.querySelectorAll("#orderspagination .pagination li a")
        ).reduce((acc, a) => {
          const num = parseInt(a.textContent, 10);
          return Number.isFinite(num) ? Math.max(acc, num) : acc;
        }, 1);

        return {
          reference: norm(link?.textContent || ""),
          poNumber: norm(cells[2]?.textContent || "").replace(/^Order PO:\s*/i, ""),
          partsCount: norm(cells[3]?.textContent || ""),
          totalRaw: norm(cells[4]?.innerText || ""),
          total: num(cells[4]?.innerText || ""),
          orderDateRaw: norm(cells[5]?.innerText || ""),
          dateTimestamp: norm(cells[5]?.querySelector("a")?.getAttribute("data-tstamp") || ""),
          href: link?.getAttribute("href") || "",
          modalUrl,
          rowIndex: rowIndex + 1,
          totalPages,
        };
      })
      .filter((o) => o.reference);

    const maxPage = orders.reduce((acc, o) => Math.max(acc, o.totalPages || 1), 1);
    return { orders, totalPages: maxPage };
  });
}

async function scrapeOrdersList(page, maxPages = 1) {
  let pageNumber = 1;
  const orders = [];

  while (pageNumber <= Math.max(1, maxPages)) {
    await page.goto(`${ORDERS_URL}?pageNumber=${pageNumber}`, { waitUntil: "domcontentloaded" });
    await page.waitForSelector("#orders tr", { timeout: 20000 });
    const { orders: pageOrders } = await parseOrdersFromPage(page);

    for (const o of pageOrders) {
      const { iso, sageDate } = o.dateTimestamp
        ? parseTransbecDate(o.dateTimestamp)
        : parseTransbecDate(o.orderDateRaw);
      orders.push({
        ...o,
        orderDate: iso,
        sageDate,
        source: "transbec",
      });
    }

    pageNumber += 1;
  }

  return orders;
}

async function fetchOrderDetail(context, detailUrl, refLabel = "") {
  if (!detailUrl) return { ok: false, reason: "no-detail-url" };
  const detailPage = await context.newPage();
  const fullUrl = detailUrl.startsWith("http") ? detailUrl : `${BASE_URL}${detailUrl}`;

  try {
    await detailPage.goto(fullUrl, { waitUntil: "domcontentloaded" });
    await detailPage.waitForSelector(".tblorderdeets tbody tr", { timeout: 20000 });
  } catch (err) {
    await detailPage.close();
    return { ok: false, error: `detail-navigation-failed (${err.message || err})` };
  }

  try {
    const detail = await detailPage.evaluate(() => {
      const monthMap = {
        jan: "01",
        feb: "02",
        mar: "03",
        apr: "04",
        avr: "04",
        mai: "05",
        may: "05",
        jun: "06",
        juin: "06",
        jui: "07",
        juil: "07",
        jul: "07",
        aug: "08",
        aou: "08",
        sep: "09",
        oct: "10",
        nov: "11",
        dec: "12",
      };
      const normalizeMonthToken = (raw) => {
        let s = String(raw || "").toLowerCase();
        s = s.replace(/\u00c3\u00a9/g, "e").replace(/\u00c3\u00bb/g, "u");
        try {
          s = s.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
        } catch (_) {}
        return s.replace(/[^a-z]/g, "");
      };
      const norm = (s) => (s || "").replace(/\s+/g, " ").trim();
      const money = (s) => norm(s).replace(/[^\d.,-]/g, "").replace(",", ".") || "";
      const num = (s) => {
        const n = parseFloat((s || "").replace(/[^\d.-]/g, ""));
        return Number.isFinite(n) ? n : null;
      };

      const bodyText = document.body.innerText || "";
      const dateMatch = bodyText.match(
        /([A-Za-z\u00c0-\u017f]{3,})\.?[^\d]*(\d{1,2}),\s*(\d{4})/
      );
      let orderDateRaw = "";
      let orderDate = null;
      let sageDate = "";
      if (dateMatch) {
        orderDateRaw = dateMatch[0];
        const normalizedMonth = normalizeMonthToken(dateMatch[1]);
        const monthKey = monthMap[normalizedMonth.slice(0, 4)] ? normalizedMonth.slice(0, 4) : normalizedMonth.slice(0, 3);
        const month = monthMap[monthKey] || "";
        const day = dateMatch[2].padStart(2, "0");
        const year = dateMatch[3];
        if (month) {
          orderDate = new Date(`${year}-${month}-${day}T00:00:00.000Z`).toISOString();
          sageDate = `${day}${month}${year.slice(-2)}`;
        }
      }

      const reference = norm(document.querySelector("span.oconftxt")?.textContent || "");

      const rows = Array.from(document.querySelectorAll(".tblorderdeets tbody tr"));
      const lineItems = [];

      for (let i = 0; i < rows.length; i++) {
        const row = rows[i];
        const bold = row.querySelector("td b");
        if (!bold) continue;

        const tds = row.querySelectorAll("td");
        const partCellText = norm(tds[1]?.innerText || "");
        const [partNumRaw, lineCodeRaw] = partCellText.split("/");
        const partNumber = norm(partNumRaw || bold.textContent || "");
        const partLineCode = norm(lineCodeRaw || "").replace(/^\/\s*/, "") || "TRB";

        const quantity = norm(tds[4]?.textContent || "");
        const costPrice = money(tds[5]?.innerText || "");
        const extended = money(tds[6]?.innerText || "");
        const costPriceValue = num(tds[5]?.innerText || "");
        const extendedValue = num(tds[6]?.innerText || "");
        const coreText = norm(tds[3]?.innerText || "");

        // Skip rows that don't look like a real line (no partNumber or no quantity/cost)
        if (!partNumber || partNumber.includes("Application:") || partNumber.includes("$")) continue;
        if (!quantity && !costPrice && !extended) continue;

        let partDescription = "";
        const nextRow = rows[i + 1];
        if (nextRow && nextRow.querySelector('td[colspan="5"]')) {
          const descTd = nextRow.querySelector('td[colspan="5"]');
          partDescription = norm(
            (descTd?.textContent || "")
              .replace(/Popularity:.*$/i, "")
              .replace(/Application:/i, "Application:")
          );
          // Drop leading "TRANSBEC" branding when present
          partDescription = partDescription.replace(/^TRANSBEC\s*/i, "").trim();
        }

        lineItems.push({
          partLineCode,
          partNumber,
          costPrice,
          costPriceValue,
          partDescription,
          quantity,
          extended,
          extendedValue,
          core: coreText !== "",
          addedToOutstanding: false,
          hasEnvironmentalFee: false,
          environmentalFeeAmount: null,
        });
      }

      return {
        reference,
        orderDateRaw,
        orderDate,
        sageDate,
        lineItems,
      };
    });

    await detailPage.close();
    return { ok: true, detail };
  } catch (err) {
    await detailPage.close();
    return { ok: false, error: err.message || "detail-parse-failed", refLabel };
  }
}

function aggregateProducts(orders) {
  const map = new Map();
  for (const order of orders || []) {
    for (const line of order.lineItems || []) {
      if (!line?.partNumber) continue;
      const key = `${line.partLineCode || ""}::${line.partNumber}`.toUpperCase();
      if (!map.has(key)) {
        map.set(key, {
          partLineCode: line.partLineCode || "",
          partNumber: line.partNumber,
          partDescription: line.partDescription || "",
          lastCostPrice: line.costPrice || "",
          lastExtended: line.extended || "",
          lastOrderReference: order.reference || "",
          source: "transbec",
        });
      }
    }
  }
  return Array.from(map.values());
}

module.exports = {
  createContextWithStorage,
  ensureLoggedIn,
  parseTransbecDate,
  parseOrdersFromPage,
  scrapeOrdersList,
  fetchOrderDetail,
  aggregateProducts,
};
