module.exports = async (page, opts = {}) => {
  if (opts.mobile) { await page.locator("button.menu-toggle").click(); await page.waitForTimeout(400); }
  for (const f of ["Production", "Staging"]) { await page.locator(".folder", { hasText: f }).first().click(); await page.waitForTimeout(250); }
  if (!opts.mobile) { await page.locator(".item", { hasText: "web-01 · nginx" }).first().click(); await page.waitForTimeout(1200); }
  await page.mouse.move(1, 1);
};
