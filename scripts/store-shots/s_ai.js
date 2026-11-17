module.exports = async (page, opts = {}) => {
  await page.evaluate(() => {
    window.__mockHook = (cmd, a) => cmd === "db_query" && /INTERVAL 7/.test(a.sql) ? { columns: ["day", "orders", "revenue"], binary_cols: [false, false, false], rows: [["2026-11-10", "212", "19880.40"], ["2026-11-11", "248", "23512.10"], ["2026-11-12", "251", "24106.75"], ["2026-11-13", "266", "25930.00"], ["2026-11-14", "371", "36410.20"], ["2026-11-15", "297", "28210.55"], ["2026-11-16", "267", "26270.00"]], rows_affected: 0, elapsed_ms: 18, truncated: false } : undefined;
  });
  await require("./s_db.js")(page, opts);
  await page.locator(".pane-ai").first().click();
  await page.waitForTimeout(600);
  const ta = page.locator(".ai-chat textarea");
  await ta.click();
  await ta.fill("How much revenue did we make in the last 7 days?");
  if (opts.mobile) await page.locator(".ai-chat button.ai-send").click(); else await ta.press("Enter");
  await page.waitForTimeout(2500);
};
const base = module.exports;
module.exports = async (page, opts = {}) => {
  await base(page, opts);
  if (opts.mobile) { await page.evaluate(() => document.querySelector(".ai-head").scrollIntoView({ block: "start" })); await page.waitForTimeout(300); }
};
