// usage: node probe.cjs <w> <h> <scale> <out.png> [steps.js]
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");
(async () => {
  const [w, h, s, out, steps] = process.argv.slice(2);
  const browser = await chromium.launch({ channel: "chrome" });
  const ctx = await browser.newContext({ viewport: { width: +w, height: +h }, deviceScaleFactor: +s, colorScheme: "dark", hasTouch: +w <= 760, isMobile: +w <= 760 });
  await ctx.addInitScript({ path: path.join(__dirname, "mock.js") });
  await ctx.addInitScript(() => {
    localStorage.setItem("balaudeck.sidebarWidth", "300"); localStorage.setItem("balaudeck.settings", JSON.stringify({ theme: "dark", accent: "teal", autoUpdate: false, ai: { enabled: true, provider: "anthropic", model: "claude-sonnet-4-5", openaiBaseUrl: "", ollamaBaseUrl: "http://localhost:11434", autoRunReadOnly: true } }));
  });
  const page = await ctx.newPage(); page.setDefaultTimeout(5000);
  page.on("pageerror", (e) => console.log("PAGEERR", e.message));
  page.on("console", (m) => { if (m.type() === "error") console.log("CONSOLE", m.text().slice(0, 300)); });
  await page.goto("http://127.0.0.1:5299/");
  await page.waitForTimeout(1500);
  const mobile = +w <= 760;
  const opts = { mobile };
  if (mobile) opts.openItem = async (name) => {
    await page.locator("button.menu-toggle").click();
    await page.waitForTimeout(400);
    const item = page.locator("aside.sidebar .item", { hasText: name }).first();
    if (!(await item.isVisible())) {
      for (const f of ["Production", "Staging", "Home lab"]) {
        await page.locator("aside.sidebar .folder", { hasText: f }).first().click();
        await page.waitForTimeout(250);
        if (await item.isVisible()) break;
      }
    }
    await item.click();
    await page.waitForTimeout(500);
  };
  if (steps) await require(path.resolve(steps))(page, opts);
  await page.screenshot({ path: out });
  console.log("ipc:", [...new Set(await page.evaluate(() => window.__ipcLog))].join(","));
  await browser.close();
})();
