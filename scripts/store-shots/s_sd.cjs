module.exports = async (page, opts = {}) => {
  const mode = process.env.MODE || "compare";
  if (!opts.mobile) { await page.locator(".folder", { hasText: "Production" }).first().click(); await page.waitForTimeout(200); }
  if (opts.openItem) await opts.openItem("shop-prod"); else await page.locator(".item", { hasText: "shop-prod" }).first().click();
  await page.waitForTimeout(400);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForTimeout(900);
  await page.getByText("shop", { exact: true }).first().click({ button: "right" });
  await page.waitForTimeout(300);
  await page.getByText(mode === "compare" ? "Schema Compare…" : "Data Transfer…").click();
  await page.waitForTimeout(800);
  const target = mode === "compare" ? "shop-staging" : "shop-pg";
  const inputs = page.locator(".modal .dt-combo-input");
  await inputs.nth(0).click(); await inputs.nth(0).fill(target.slice(0, 7));
  await page.waitForTimeout(300);
  await page.locator(".dt-combo-list li").filter({ hasText: target }).first().click();
  await page.waitForTimeout(800);
  await inputs.nth(1).click(); await inputs.nth(1).fill("shop");
  await page.waitForTimeout(300);
  await page.locator(".dt-combo-list li").filter({ hasText: /^shop$/ }).first().click();
  await page.waitForTimeout(800);
  if (mode === "compare") { await page.locator(".sd-compare").click(); await page.waitForTimeout(1200); await page.locator(".modal").getByText("customers", { exact: true }).click(); await page.waitForTimeout(500); }
};
module.exports.after = true;
