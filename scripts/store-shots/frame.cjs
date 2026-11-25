// node frame.cjs <device> <scenes,comma>  -> out/<device>/<NN>_<scene>.png
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const CAP = {
  db: ["Seven databases, one client.", "MySQL, MariaDB, PostgreSQL, SQL Server, SQLite, MongoDB and Redis."],
  ai: ["Ask your data anything.", "The AI assistant writes the SQL, runs it read-only and explains the answer."],
  ssh: ["A real SSH terminal.", "Deploy, tail logs and stay connected with tmux and auto-reconnect."],
  conn: ["Every server, one sidebar.", "SSH, SFTP, tunnels and databases in folders — synced across your devices."],
  sftp: ["Edit server files in place.", "Browse, preview and edit configs over SFTP."],
  tunnel: ["Tunnels you can see.", "Local, remote and SOCKS forwarding, mapped live."],
  s3: ["Object storage, built in.", "Browse S3 buckets, upload and preview files."],
  schema: ["Compare schemas. Ship the diff.", "Staging vs production → a ready-to-run ALTER script."],
  xfer: ["Move data across engines.", "Copy MySQL to PostgreSQL — tables, rows and keys."],
  erd: ["See your schema at a glance.", "ER diagrams with a tidy auto-layout — export PNG, PDF, SQL or docs."],
  erdt: ["See your schema at a glance.", "ER diagrams with a tidy auto-layout — export PNG, PDF, SQL or docs."],
  erdk: ["See your schema at a glance.", "ER diagrams of any database — pinch, pan and export."],
  termai: ["Just say what you need.", "AI turns plain words into the right shell command. You press Enter."],
  redis: ["Redis keys at a glance.", "Scan, inspect, set TTLs — plus a MongoDB document browser."],
};

// canvas CSS size, scale, shot display width, top offset, font sizes
const DEV = {
  mac: { w: 1440, h: 900, s: 2, shotW: 1160, top: 215, h1: 64, sub: 26, pad: 70, radius: 14 },
  ipad: { w: 1032, h: 1376, s: 2, shotW: 940, top: 250, h1: 56, sub: 26, pad: 80, radius: 22 },
  iphone: { w: 440, h: 956, s: 3, shotW: 390, top: 215, h1: 40, sub: 17, pad: 46, radius: 30 },
  android: { w: 360, h: 640, s: 3, shotW: 300, top: 150, h1: 26, sub: 13, pad: 30, radius: 22 },
  // Play 10" tablet, 9:16 → 1440×2560, from the iPad renders.
  tablet: { w: 720, h: 1280, s: 2, shotW: 660, top: 230, h1: 42, sub: 19, pad: 50, radius: 18 },
};

(async () => {
  const [dev, scenes] = process.argv.slice(2);
  const d = DEV[dev];
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({ viewport: { width: d.w, height: d.h }, deviceScaleFactor: d.s });
  fs.mkdirSync(`out/${dev}`, { recursive: true });
  const src = dev === "tablet" ? "tab" : dev;
  let n = 0;
  for (const sc of scenes.split(",")) {
    n++;
    const img = "data:image/png;base64," + fs.readFileSync(`raw/${src}/${sc}.png`).toString("base64");
    const [h1, sub] = CAP[sc];
    const html = `<!doctype html><html><head><style>
      *{margin:0;box-sizing:border-box}
      body{width:${d.w}px;height:${d.h}px;overflow:hidden;font-family:-apple-system,"SF Pro Display","Helvetica Neue",Arial,sans-serif;
        background:radial-gradient(120% 70% at 50% 0%,#2a1d4f 0%,#17142a 45%,#0d0e14 100%);color:#fff;text-align:center;position:relative}
      .glow{position:absolute;left:50%;top:${d.top + 40}px;width:${d.shotW * 1.1}px;height:${d.shotW * 0.7}px;transform:translateX(-50%);
        background:radial-gradient(closest-side,rgba(20,184,166,.28),rgba(20,184,166,0));filter:blur(10px)}
      .head{position:absolute;left:0;right:0;top:0;height:${d.top}px;display:flex;flex-direction:column;justify-content:center;padding:0 ${d.pad}px}
      h1{font-size:${d.h1}px;line-height:1.08;font-weight:800;letter-spacing:-.025em}
      p{margin-top:${Math.round(d.h1 * 0.32)}px;font-size:${d.sub}px;line-height:1.35;color:#c4bde6;font-weight:500}
      .shot{position:absolute;left:50%;top:${d.top}px;transform:translateX(-50%);width:${d.shotW}px;border-radius:${d.radius}px;overflow:hidden;
        box-shadow:0 0 0 1px rgba(255,255,255,.10),0 30px 80px rgba(0,0,0,.6)}
      .shot img{display:block;width:100%}
    </style></head><body><div class="glow"></div>
      <div class="head"><h1>${h1}</h1><p>${sub}</p></div>
      <div class="shot"><img src="${img}"></div></body></html>`;
    await page.setContent(html);
    await page.waitForTimeout(150);
    const out = `out/${dev}/${String(n).padStart(2, "0")}_${sc}.png`;
    await page.screenshot({ path: out });
    console.log(out);
  }
  await browser.close();
})();
