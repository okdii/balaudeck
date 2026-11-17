const SQL = `SELECT c.id, c.name, c.email, c.city, c.tier,
       SUM(o.total) AS spent_rm, MAX(o.placed_at) AS last_order
FROM customers c
JOIN orders o ON o.customer_id = c.id
WHERE o.status = 'paid'
GROUP BY c.id
ORDER BY last_order DESC
LIMIT 15;`;
module.exports = async (page, opts = {}) => {
  if (!opts.mobile) {
    await page.locator(".folder", { hasText: "Production" }).first().click();
    await page.waitForTimeout(300);
  }
  if (opts.openItem) await opts.openItem("shop-prod");
  else await page.locator(".item", { hasText: "shop-prod" }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByText("shop", { exact: true }).first().click();
  await page.waitForTimeout(600);
  if (!opts.mobile) { await page.getByText("Tables").first().click(); await page.waitForTimeout(400); }
  else { await page.getByText("shop", { exact: true }).first().click(); await page.waitForTimeout(300); }
  await page.locator(".cm-content").first().click();
  await page.keyboard.insertText(opts.mobile ? "SELECT id, name, email, city, tier\nFROM customers\nORDER BY spent_rm DESC;" : SQL);
  await page.keyboard.press("ControlOrMeta+Home");
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "Run", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.mouse.click(5, 790);
  if (opts.mobile) { await page.evaluate(() => document.querySelector(".cm-editor").scrollIntoView({ block: "start" })); await page.waitForTimeout(300); }
};
