// node batch.cjs <device> <scenes,comma> ; writes raw/<device>/<scene>.png
const { execFileSync } = require("child_process");
const DEV = { mac: [1440, 900, 2], ipad: [940, 1150, 2], iphone: [390, 820, 3], android: [390, 844, 3], q: [390, 820, 1], qi: [940, 1150, 1], tab: [800, 1180, 2] };
const SC = {
  db: ["s_db.cjs", {}], ai: ["s_ai.cjs", {}], ssh: ["s_ssh.cjs", {}], conn: ["s_conn.cjs", {}],
  sftp: ["s_open.cjs", { ITEM: "web-01 files", STEPS: 'await page.locator("tr,.row,div", {hasText:"nginx.conf"}).last().locator("button").first().click(); await page.waitForTimeout(800);' }],
  tunnel: ["s_open.cjs", { ITEM: "analytics → localhost", STEPS: 'await page.getByRole("button",{name:"Start tunnel"}).click(); await page.waitForTimeout(700); for (const n of ["grafana","SOCKS"]) { await page.getByRole("button",{name:"New tunnel"}).click(); await page.waitForTimeout(500); const sel = page.locator("select").first(); await sel.selectOption({label: (await sel.locator("option",{hasText:n}).textContent())}); await page.waitForTimeout(300); await page.getByRole("button",{name:"Start tunnel"}).click(); await page.waitForTimeout(700); }' }],
  s3: ["s_open.cjs", { ITEM: "assets", STEPS: 'await page.getByText("shop-media").click(); await page.waitForTimeout(800);' }],
  redis: ["s_open.cjs", { ITEM: "sessions", STEPS: 'await page.getByText("cart:1004").first().click(); await page.waitForTimeout(800);' }],
  mongo: ["s_open.cjs", { ITEM: "events", STEPS: 'await page.getByText("events", {exact:true}).last().click().catch(()=>{}); await page.waitForTimeout(600); await page.getByText("activity").first().click(); await page.waitForTimeout(900);' }],
  termai: ["s_termai.cjs", {}], erd: ["s_erd.cjs", {}], erdt: ["s_erd.cjs", { ERMODE: "Keys" }], erdk: ["s_erd.cjs", { ERMODE: "Keys" }],
  schema: ["s_sd.cjs", { MODE: "compare" }], xfer: ["s_sd.cjs", { MODE: "xfer" }],
};
const [dev, scenes] = process.argv.slice(2);
const [w, h, s] = DEV[dev];
require("fs").mkdirSync(`raw/${dev}`, { recursive: true });
for (const name of scenes.split(",")) {
  const [file, env] = SC[name];
  try {
    const out = execFileSync("node", ["probe.cjs", w, h, s, `raw/${dev}/${name}.png`, file], { env: { ...process.env, ...env }, encoding: "utf8" });
    const bad = out.split("\n").filter((l) => /PAGEERR|Error/.test(l));
    console.log(name, bad.length ? bad.slice(0, 2).join(" | ") : "ok");
  } catch (e) { console.log(name, "FAIL", String(e.stdout || e).split("\n").filter((l) => /Error|waiting/.test(l)).slice(0, 2).join(" | ")); }
}
