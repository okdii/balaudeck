// ER diagram of the sample "shop" database (real FKs), opened from the DB tree.
const T = {
  customers: [["id", "bigint", 1], ["name", "varchar", 0, "120"], ["email", "varchar", 0, "191"], ["city", "varchar", 0, "80"], ["tier", "varchar", 0, "16"], ["created_at", "timestamp"]],
  addresses: [["id", "bigint", 1], ["customer_id", "bigint"], ["line1", "varchar", 0, "160"], ["postcode", "varchar", 0, "10"], ["state", "varchar", 0, "40"]],
  orders: [["id", "bigint", 1], ["customer_id", "bigint"], ["address_id", "bigint"], ["coupon_id", "bigint"], ["status", "varchar", 0, "16"], ["total", "decimal", 0, "12,2"], ["placed_at", "timestamp"]],
  order_items: [["id", "bigint", 1], ["order_id", "bigint"], ["product_id", "bigint"], ["qty", "int"], ["price", "decimal", 0, "10,2"]],
  products: [["id", "bigint", 1], ["category_id", "bigint"], ["supplier_id", "bigint"], ["sku", "varchar", 0, "32"], ["name", "varchar", 0, "160"], ["price", "decimal", 0, "10,2"]],
  categories: [["id", "bigint", 1], ["parent_id", "bigint"], ["name", "varchar", 0, "80"]],
  suppliers: [["id", "bigint", 1], ["name", "varchar", 0, "120"], ["country", "char", 0, "2"]],
  payments: [["id", "bigint", 1], ["order_id", "bigint"], ["method", "varchar", 0, "20"], ["amount", "decimal", 0, "12,2"], ["paid_at", "timestamp"]],
  shipments: [["id", "bigint", 1], ["order_id", "bigint"], ["warehouse_id", "bigint"], ["carrier", "varchar", 0, "40"], ["tracking_no", "varchar", 0, "40"]],
  warehouses: [["id", "bigint", 1], ["name", "varchar", 0, "80"], ["state", "varchar", 0, "40"]],
  inventory: [["id", "bigint", 1], ["product_id", "bigint"], ["warehouse_id", "bigint"], ["on_hand", "int"]],
  reviews: [["id", "bigint", 1], ["product_id", "bigint"], ["customer_id", "bigint"], ["rating", "tinyint"], ["body", "text"]],
  coupons: [["id", "bigint", 1], ["code", "varchar", 0, "24"], ["percent_off", "tinyint"]],
};
const REF = { customer_id: "customers", address_id: "addresses", coupon_id: "coupons", order_id: "orders", product_id: "products", category_id: "categories", supplier_id: "suppliers", warehouse_id: "warehouses", parent_id: "categories" };
module.exports = async (page, opts = {}) => {
  await page.evaluate(({ T, REF }) => {
    localStorage.setItem("bd.er.lines", "curved");
    const prev = window.__mockHook;
    window.__mockHook = (cmd, a) => {
      if (cmd === "db_schema_objects" && a.database === "shop") return { tables: Object.keys(T), views: [], routines: [] };
      if (cmd === "db_table_schema" && T[a.table]) {
        const cols = T[a.table];
        return {
          columns: cols.map(([name, dataType, pk, length]) => ({ name, dataType, length: length || "", nullable: !pk && !name.endsWith("_id") && name !== "name", default: "", pk: !!pk, autoIncrement: !!pk })),
          foreignKeys: cols.filter(([n]) => REF[n]).map(([n]) => ({ name: `fk_${a.table}_${n}`, column: n, refTable: REF[n], refColumn: "id", onDelete: "", onUpdate: "" })),
          indexes: [],
        };
      }
      return prev ? prev(cmd, a) : undefined;
    };
  }, { T, REF });
  if (!opts.mobile) {
    await page.locator(".folder", { hasText: "Production" }).first().click();
    await page.waitForTimeout(300);
  }
  if (opts.openItem) await opts.openItem("shop-prod");
  else await page.locator(".item", { hasText: "shop-prod" }).first().click();
  await page.waitForTimeout(500);
  await page.getByRole("button", { name: "Connect", exact: true }).click();
  await page.waitForTimeout(1000);
  await page.getByText("shop", { exact: true }).first().click({ button: "right" });
  await page.waitForTimeout(300);
  await page.locator(".ctx-menu li", { hasText: "ER Diagram" }).click();
  await page.waitForTimeout(2500);
  // Tablet: give the diagram the room (hide the connections sidebar).
  const vw = page.viewportSize().width;
  if (!opts.mobile && vw < 1100) {
    await page.locator("button.menu-toggle").first().click().catch(() => {});
    await page.waitForTimeout(400);
  }
  if (process.env.ERMODE) await page.locator(".er-mode button", { hasText: process.env.ERMODE }).click();
  await page.waitForTimeout(300);
  await page.locator("button", { hasText: "Fit" }).first().click();
  await page.waitForTimeout(600);
  if (opts.mobile) {
    // Phone: zoom in on the middle so the tables are readable.
    for (let i = 0; i < 2; i++) await page.locator('button[title="Zoom in"]').click();
    await page.waitForTimeout(400);
  }
  // Hover a hub table so its links light up.
  const hub = page.locator(".er-node").filter({ has: page.locator("text=orders") }).first();
  const bb = await hub.boundingBox().catch(() => null);
  if (bb && !opts.mobile) await page.mouse.move(bb.x + bb.width / 2, bb.y + 12);
  await page.waitForTimeout(500);
};
