const E = "\x1b[";
const g = (s) => `${E}32m${s}${E}0m`, b = (s) => `${E}1;34m${s}${E}0m`, y = (s) => `${E}33m${s}${E}0m`, c = (s) => `${E}36m${s}${E}0m`, d = (s) => `${E}2m${s}${E}0m`, B = (s) => `${E}1m${s}${E}0m`;
const P = `${g("deploy@web-01")}:${b("/srv/shop")}$ `;
const OUT = [
  "Welcome to Ubuntu 24.04.1 LTS (GNU/Linux 6.8.0-49-generic x86_64)",
  "",
  `  System load:  0.21              Processes:             184`,
  `  Usage of /:   38.2% of 78.2GB   Users logged in:       1`,
  `  Memory usage: 41%               IPv4 address for eth0: 203.0.113.21`,
  "",
  `${P}docker compose ps`,
  B("NAME            IMAGE                 STATUS                  PORTS"),
  `shop-app        shop/app:2.4.0        ${g("Up 6 days (healthy)")}     9000/tcp`,
  `shop-nginx      nginx:1.27-alpine     ${g("Up 6 days")}               0.0.0.0:443->443/tcp`,
  `shop-worker     shop/app:2.4.0        ${g("Up 6 days")}`,
  `shop-redis      redis:7.4             ${g("Up 6 days (healthy)")}     6379/tcp`,
  `${P}git pull && ./deploy.sh`,
  `Already up to date.`,
  `${c("→")} Building assets ...        ${g("✓")} 4.2s`,
  `${c("→")} Running migrations ...     ${g("✓")} 2 applied`,
  `${c("→")} Restarting workers ...     ${g("✓")}`,
  `${c("→")} Health check ...           ${g("✓ 200 OK")} ${d("(38 ms)")}`,
  `${g("Deployed v2.4.1 to production")} 🚀`,
  `${P}tail -n 5 /var/log/nginx/access.log`,
  `${d("198.51.100.23")} - - [17/Nov/2026:09:41:02] "GET /api/products?page=2 HTTP/2" ${g("200")} 5124`,
  `${d("203.0.113.77")}  - - [17/Nov/2026:09:41:03] "POST /api/cart HTTP/2" ${g("201")} 318`,
  `${d("198.51.100.91")} - - [17/Nov/2026:09:41:03] "GET /checkout HTTP/2" ${g("200")} 18240`,
  `${d("203.0.113.45")}  - - [17/Nov/2026:09:41:05] "GET /img/hero.webp HTTP/2" ${y("304")} 0`,
  `${d("198.51.100.12")} - - [17/Nov/2026:09:41:06] "POST /api/orders HTTP/2" ${g("201")} 912`,
  P,
].join("\r\n");
const OUTM = [
  `${P}docker compose ps`,
  B("NAME          STATUS"),
  `shop-app      ${g("Up 6 days (healthy)")}`,
  `shop-nginx    ${g("Up 6 days")}`,
  `shop-worker   ${g("Up 6 days")}`,
  `shop-redis    ${g("Up 6 days (healthy)")}`,
  "",
  `${P}./deploy.sh`,
  `${c("→")} Building assets ...   ${g("✓")} 4.2s`,
  `${c("→")} Migrations ...        ${g("✓")} 2 applied`,
  `${c("→")} Restart workers ...   ${g("✓")}`,
  `${c("→")} Health check ...      ${g("✓ 200 OK")}`,
  `${g("Deployed v2.4.1 to production")} 🚀`,
  "",
  `${P}uptime`,
  ` 09:41:07 up 95 days,  load: ${g("0.21 0.18 0.12")}`,
  `${P}df -h /`,
  `/dev/vda1   79G   30G   49G  ${y("38%")} /`,
  P,
].join("\r\n");
module.exports = async (page, opts = {}) => {
  if (!opts.mobile) {
    await page.locator(".folder", { hasText: "Production" }).first().click();
    await page.waitForTimeout(300);
  }
  if (opts.openItem) await opts.openItem("web-01 · nginx");
  else await page.locator(".item", { hasText: "web-01 · nginx" }).first().click();
  await page.waitForTimeout(1500);
  const bytes = Array.from(new TextEncoder().encode(opts.mobile ? OUTM : OUT));
  await page.evaluate((bs) => window.__mock.emit("ssh://data/ssh1", bs), bytes);
  await page.waitForTimeout(800);
};
