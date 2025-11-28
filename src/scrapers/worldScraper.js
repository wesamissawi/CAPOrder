// src/scrapers/worldScraper.js
const path = require("path");
const fs = require("fs");
const { chromium } = require("playwright");
require("dotenv").config();

const WORLD_LOGIN_URL = "https://www.iautoparts.biz"; // adjust if needed
const STORAGE_STATE_PATH = path.join(__dirname, "..", "world_storage_state.json");
const ORDERS_JSON_PATH = path.join(__dirname, "..", "world_orders.json");

// Helper: ensure we have login credentials
function getCredentials() {
  const user = process.env.WORLD_USER;
  const pass = process.env.WORLD_PASS;

  if (!user || !pass) {
    throw new Error("WORLD_USER or WORLD_PASS not set in .env");
  }

  return { user, pass };
}

// Create a browser context, with stored session if available
async function createContextWithStorage(browser) {
  if (fs.existsSync(STORAGE_STATE_PATH)) {
    return await browser.newContext({ storageState: STORAGE_STATE_PATH });
  }
  return await browser.newContext();
}

// Login if necessary and save session
async function ensureLoggedIn(page) {
  const { user, pass } = getCredentials();

  await page.goto(WORLD_LOGIN_URL, { waitUntil: "networkidle" });

  // TODO: replace selectors with your actual ones
  // You told me you already have JS that logs in & clicks around.
  // This is where that logic goes.

  // Example (pseudo):
  await page.fill("#username", user);
  await page.fill("#password", pass);
  await page.click("button[type='submit']");
  await page.waitForLoadState("networkidle");

  // After successful login, save storage state
  await page.context().storageState({ path: STORAGE_STATE_PATH });
}

// Navigate to orders page and scrape
async function scrapeWorldOrders(page) {
  // TODO: navigate to the "new orders" page
  // e.g. await page.goto("https://www.iautoparts.biz/orders", { waitUntil: "networkidle" });

  // Here is where you can paste your existing JS-from-console.
  // Instead of DevTools, you use page.evaluate.
  const orders = await page.evaluate(() => {
    // Example skeleton:
    // const rows = [...document.querySelectorAll("table#orders tbody tr")];
    // return rows.map(row => ({
    //   orderNumber: row.querySelector("td:nth-child(1)")?.innerText.trim(),
    //   status: row.querySelector("td:nth-child(2)")?.innerText.trim(),
    //   date: row.querySelector("td:nth-child(3)")?.innerText.trim(),
    // }));

    // For now, return empty array; replace with your real logic:
    return [];
  });

  return orders;
}

// Save scraped orders into JSON file
function saveOrdersToJson(orders) {
  fs.writeFileSync(ORDERS_JSON_PATH, JSON.stringify(orders, null, 2), "utf8");
}

// MAIN ENTRY: call this from Electron main via IPC
async function getWorldOrders() {
  const browser = await chromium.launch({ headless: true });

  try {
    const context = await createContextWithStorage(browser);
    const page = await context.newPage();

    // If not logged in yet, we log in and store session.
    // A simple check is to try go to some known "logged-in only" page and see what happens.
    // For now, we always call ensureLoggedIn once at the start.
    await ensureLoggedIn(page);

    const orders = await scrapeWorldOrders(page);
    saveOrdersToJson(orders);

    return { ok: true, count: orders.length, path: ORDERS_JSON_PATH };
  } catch (err) {
    console.error("World scraper error:", err);
    return { ok: false, error: err.message };
  } finally {
    await browser.close();
  }
}

module.exports = {
  getWorldOrders,
  ORDERS_JSON_PATH,
};
