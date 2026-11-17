// generic: open an item; extra steps via env STEPS (JS string evaluated with page)
module.exports = async (page, opts = {}) => {
  const name = process.env.ITEM;
  if (!opts.mobile) {
    for (const f of (process.env.FOLDERS || "Production").split(",")) {
      await page.locator(".folder", { hasText: f }).first().click();
      await page.waitForTimeout(200);
    }
  }
  if (opts.openItem) await opts.openItem(name);
  else await page.locator(".item", { hasText: name }).first().click();
  await page.waitForTimeout(1200);
  if (process.env.STEPS) await eval(`(async()=>{${process.env.STEPS}})()`);
  await page.mouse.move(1000, 5);
  await page.waitForTimeout(500);
};
