// Fake Tauri IPC for store screenshots — every value here is invented sample
// data (documentation IP ranges 203.0.113.x / 10.x, fictional "shop" business).
(() => {
  const cbs = new Map();
  let nextCb = 1;
  const listeners = new Map(); // event -> [cbId]
  const log = (window.__ipcLog = []);
  const now = Date.now();

  const store = {
    folders: [
      { id: "f-prod", name: "Production", kind: "all", parent_id: null },
      { id: "f-stg", name: "Staging", kind: "all", parent_id: null },
      { id: "f-lab", name: "Home lab", kind: "all", parent_id: null },
    ],
    ssh: [
      { id: "s-web", name: "web-01 · nginx", host: "203.0.113.21", port: 22, user: "deploy", auth: "key", folder_id: "f-prod", tmux: true },
      { id: "s-api", name: "api-prod", host: "203.0.113.22", port: 22, user: "deploy", auth: "key", folder_id: "f-prod" },
      { id: "s-bastion", name: "bastion", host: "203.0.113.10", port: 22, user: "ops", auth: "key", folder_id: "f-prod" },
      { id: "s-stg", name: "staging-app", host: "198.51.100.40", port: 22, user: "ubuntu", auth: "key", folder_id: "f-stg" },
      { id: "s-pi", name: "raspberry-pi", host: "192.168.1.50", port: 22, user: "pi", auth: "password", folder_id: "f-lab" },
    ],
    db: [
      { id: "d-shop", name: "shop-prod", engine: "mysql", host: "10.0.2.15", port: 3306, user: "app", database: "shop", via_ssh_profile_id: "s-bastion", folder_id: "f-prod", color: "#ef4444" },
      { id: "d-an", name: "analytics", engine: "postgres", host: "10.0.2.30", port: 5432, user: "analyst", database: "analytics", via_ssh_profile_id: null, folder_id: "f-prod" },
      { id: "d-bill", name: "billing", engine: "mssql", host: "10.0.2.40", port: 1433, user: "sa", database: "billing", via_ssh_profile_id: null, folder_id: "f-prod" },
      { id: "d-cache", name: "sessions", engine: "redis", host: "10.0.2.50", port: 6379, user: "", database: null, via_ssh_profile_id: null, folder_id: "f-prod" },
      { id: "d-events", name: "events", engine: "mongodb", host: "10.0.2.60", port: 27017, user: "app", database: null, via_ssh_profile_id: null, folder_id: "f-prod" },
      { id: "d-assets", name: "assets", engine: "s3", host: "s3.example.com", port: 443, user: "AKIAEXAMPLE", database: null, region: "ap-southeast-1", path_style: false, tls: true, via_ssh_profile_id: null, folder_id: "f-prod" },
      { id: "d-shopstg", name: "shop-staging", engine: "mysql", host: "198.51.100.41", port: 3306, user: "app", database: "shop", via_ssh_profile_id: null, folder_id: "f-stg", color: "#f59e0b" },
      { id: "d-pg-stg", name: "shop-pg (new)", engine: "postgres", host: "198.51.100.42", port: 5432, user: "app", database: "shop", via_ssh_profile_id: null, folder_id: "f-stg" },
      { id: "d-lite", name: "notes.sqlite", engine: "sqlite", host: "", port: 0, user: "", database: null, file: "~/Documents/notes.sqlite", via_ssh_profile_id: null, folder_id: "f-lab" },
    ],
    sftp: [
      { id: "p-web", name: "web-01 files", host: "203.0.113.21", port: 22, user: "deploy", auth: "key", folder_id: "f-prod" },
    ],
    tunnel: [
      { id: "t-pg", name: "analytics → localhost:5433", host: "203.0.113.10", port: 22, user: "ops", auth: "key", mode: "local", remote_host: "10.0.2.30", remote_port: 5432, local_port: 5433, folder_id: "f-prod" },
      { id: "t-graf", name: "grafana dashboard", host: "203.0.113.10", port: 22, user: "ops", auth: "key", mode: "local", remote_host: "10.0.3.5", remote_port: 3000, local_port: 3000, folder_id: "f-prod" },
      { id: "t-socks", name: "SOCKS proxy", host: "203.0.113.10", port: 22, user: "ops", auth: "key", mode: "dynamic", remote_host: "", remote_port: 0, local_port: 1080, folder_id: "f-prod" },
    ],
    queries: [
      { id: "q1", name: "Top customers this month", sql: "SELECT ...", db_profile_id: "d-shop", database: "shop" },
      { id: "q2", name: "Low stock alert", sql: "SELECT ...", db_profile_id: "d-shop", database: "shop" },
    ],
    notes: [
      { id: "n1", title: "Deploy checklist", body: "# Deploy checklist\n\n- [x] Run migrations on **staging**\n- [x] Smoke-test checkout\n- [ ] Tag release `v2.4.0`\n- [ ] Purge CDN cache\n\n```bash\nphp artisan migrate --force\n```", updated_at: now - 3600e3 },
      { id: "n2", title: "On-call runbook", body: "# On-call\n\nRestart queue: `sudo systemctl restart shop-worker`", updated_at: now - 86400e3 },
    ],
  };

  // ---- sample databases --------------------------------------------------
  const TABLES = ["customers", "orders", "order_items", "products", "categories", "inventory", "payments", "coupons"];
  const customers = [
    ["1001", "Aisha Rahman", "aisha.r@example.com", "Kuala Lumpur", "Gold", "4,820.50", "2026-11-16 21:04"],
    ["1002", "Daniel Tan", "daniel.tan@example.com", "Penang", "Silver", "2,315.00", "2026-11-16 18:47"],
    ["1003", "Priya Nair", "priya.n@example.com", "Johor Bahru", "Gold", "6,104.20", "2026-11-16 16:12"],
    ["1004", "Marcus Lee", "marcus.lee@example.com", "Singapore", "Platinum", "12,950.00", "2026-11-16 14:30"],
    ["1005", "Siti Nurhaliza", "siti.n@example.com", "Shah Alam", "Silver", "1,980.75", "2026-11-15 22:58"],
    ["1006", "Hiro Tanaka", "hiro.t@example.com", "Kota Kinabalu", "Bronze", "640.00", "2026-11-15 20:11"],
    ["1007", "Emily Wong", "emily.w@example.com", "Ipoh", "Gold", "5,402.90", "2026-11-15 17:36"],
    ["1008", "Arjun Mehta", "arjun.m@example.com", "Melaka", "Silver", "2,876.40", "2026-11-15 11:05"],
    ["1009", "Nur Iman", "iman@example.com", "Kuching", "Bronze", "455.60", "2026-11-14 23:40"],
    ["1010", "Lucas Ng", "lucas.ng@example.com", "Petaling Jaya", "Platinum", "15,220.00", "2026-11-14 19:22"],
    ["1011", "Farah Aziz", "farah.a@example.com", "Seremban", "Gold", "4,110.35", "2026-11-14 15:09"],
    ["1012", "Kevin Ong", "kevin.o@example.com", "Cyberjaya", "Silver", "1,745.00", "2026-11-14 09:53"],
    ["1013", "Mei Ling", "meiling@example.com", "Klang", "Gold", "3,998.10", "2026-11-13 21:17"],
    ["1014", "Omar Haddad", "omar.h@example.com", "Putrajaya", "Bronze", "820.00", "2026-11-13 12:44"],
    ["1015", "Grace Lim", "grace.lim@example.com", "Miri", "Silver", "2,240.80", "2026-11-12 08:30"],
  ];
  const topSql = {
    columns: ["id", "name", "email", "city", "tier", "spent_rm", "last_order"],
    binary_cols: [false, false, false, false, false, false, false],
    rows: customers,
    rows_affected: 0,
    elapsed_ms: 12,
    truncated: false,
  };
  function cols(defs) {
    return defs.map(([name, type, nullable = false, pk = false, extra = ""]) => {
      const m = /^(\w+)(?:\(([^)]*)\))?$/.exec(type);
      return { name, dataType: m[1], length: m[2] || "", nullable, default: "", pk, autoIncrement: extra === "auto_increment" };
    });
  }
  function schemaFor(db, table) {
    const base = {
      customers: cols([["id", "int", false, true, "auto_increment"], ["name", "varchar(120)"], ["email", "varchar(190)"], ["city", "varchar(80)", true], ["tier", "varchar(16)"], ["created_at", "datetime"]]),
      orders: cols([["id", "bigint", false, true, "auto_increment"], ["customer_id", "int"], ["status", "varchar(20)"], ["total", "decimal(12,2)"], ["placed_at", "datetime"]]),
      products: cols([["id", "int", false, true, "auto_increment"], ["sku", "varchar(32)"], ["name", "varchar(160)"], ["price", "decimal(10,2)"], ["category_id", "int", true]]),
    }[table] || cols([["id", "int", false, true, "auto_increment"], ["name", "varchar(120)"], ["updated_at", "datetime", true]]);
    let columns = base;
    if (db === "prod" && table === "customers") {
      columns = [...base.slice(0, 4), ...cols([["phone", "varchar(32)", true]]), base[4], ...cols([["created_at", "timestamp"]])];
    }
    if (db === "prod" && table === "orders") {
      columns = [...base, ...cols([["coupon_code", "varchar(24)", true]])];
    }
    return {
      columns,
      foreignKeys: table === "orders" ? [{ name: "fk_orders_customer", column: "customer_id", refTable: "customers", refColumn: "id", onDelete: "CASCADE", onUpdate: "CASCADE" }] : [],
      indexes: table === "customers" ? [{ name: "idx_email", columns: ["email"], unique: true }] : [],
    };
  }

  // ---- SFTP --------------------------------------------------------------
  const sftpDir = [
    { name: "app", is_dir: true, size: 0, mtime: now / 1000 - 3600, permissions: 0o40755 },
    { name: "config", is_dir: true, size: 0, mtime: now / 1000 - 86400, permissions: 0o40750 },
    { name: "logs", is_dir: true, size: 0, mtime: now / 1000 - 120, permissions: 0o40755 },
    { name: "public", is_dir: true, size: 0, mtime: now / 1000 - 7200, permissions: 0o40755 },
    { name: "storage", is_dir: true, size: 0, mtime: now / 1000 - 600, permissions: 0o40775 },
    { name: ".env", is_dir: false, size: 1288, mtime: now / 1000 - 86400 * 3, permissions: 0o100600 },
    { name: "docker-compose.yml", is_dir: false, size: 2146, mtime: now / 1000 - 86400 * 2, permissions: 0o100644 },
    { name: "nginx.conf", is_dir: false, size: 1873, mtime: now / 1000 - 86400 * 5, permissions: 0o100644 },
    { name: "deploy.sh", is_dir: false, size: 964, mtime: now / 1000 - 86400 * 7, permissions: 0o100755 },
    { name: "backup-2026-11-16.sql.gz", is_dir: false, size: 248_312_004, mtime: now / 1000 - 30000, permissions: 0o100640 },
    { name: "README.md", is_dir: false, size: 3410, mtime: now / 1000 - 86400 * 12, permissions: 0o100644 },
  ];
  const nginxConf = `server {
    listen 443 ssl http2;
    server_name shop.example.com;

    root /srv/shop/public;
    index index.php;

    ssl_certificate     /etc/letsencrypt/live/shop.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/shop.example.com/privkey.pem;

    location / {
        try_files $uri $uri/ /index.php?$query_string;
    }

    location ~ \\.php$ {
        fastcgi_pass app:9000;
        include fastcgi_params;
        fastcgi_param SCRIPT_FILENAME $realpath_root$fastcgi_script_name;
    }

    location ~* \\.(css|js|png|jpg|svg|woff2)$ {
        expires 30d;
        access_log off;
    }
}
`;

  // ---- S3 ---------------------------------------------------------------
  const s3Buckets = [
    { name: "shop-media", created: now - 400 * 86400e3 },
    { name: "shop-backups", created: now - 380 * 86400e3 },
    { name: "invoices-pdf", created: now - 200 * 86400e3 },
    { name: "static-site", created: now - 90 * 86400e3 },
  ];
  const s3Entries = [
    { key: "products/", name: "products", is_dir: true, size: 0, modified: null },
    { key: "banners/", name: "banners", is_dir: true, size: 0, modified: null },
    { key: "avatars/", name: "avatars", is_dir: true, size: 0, modified: null },
    { key: "hero-black-friday.jpg", name: "hero-black-friday.jpg", is_dir: false, size: 842_113, modified: now - 7200e3 },
    { key: "logo.svg", name: "logo.svg", is_dir: false, size: 4_210, modified: now - 40 * 86400e3 },
    { key: "price-list-2026.pdf", name: "price-list-2026.pdf", is_dir: false, size: 1_204_551, modified: now - 3 * 86400e3 },
    { key: "sitemap.xml", name: "sitemap.xml", is_dir: false, size: 58_221, modified: now - 86400e3 },
    { key: "robots.txt", name: "robots.txt", is_dir: false, size: 112, modified: now - 60 * 86400e3 },
  ];

  // ---- Redis / Mongo -----------------------------------------------------
  const redisKeys = [
    { name: "session:9f2c1a7e", kind: "hash", ttl: 1742 },
    { name: "session:3b81d0c4", kind: "hash", ttl: 3301 },
    { name: "cart:1004", kind: "hash", ttl: 86011 },
    { name: "cart:1010", kind: "hash", ttl: 85320 },
    { name: "rate:api:203.0.113.77", kind: "string", ttl: 42 },
    { name: "queue:emails", kind: "list", ttl: -1 },
    { name: "leaderboard:weekly", kind: "zset", ttl: -1 },
    { name: "feature:flags", kind: "set", ttl: -1 },
    { name: "stats:orders:today", kind: "string", ttl: -1 },
  ];
  const mongoDocs = [
    { _id: { $oid: "6739a1f0c2e4b1a7d0f10001" }, type: "checkout.completed", customer: 1004, total: 389.9, items: 3, ts: "2026-11-16T14:30:11Z" },
    { _id: { $oid: "6739a1f0c2e4b1a7d0f10002" }, type: "cart.updated", customer: 1010, items: 5, ts: "2026-11-16T14:28:03Z" },
    { _id: { $oid: "6739a1f0c2e4b1a7d0f10003" }, type: "user.login", customer: 1001, device: "iPhone", ts: "2026-11-16T14:21:47Z" },
    { _id: { $oid: "6739a1f0c2e4b1a7d0f10004" }, type: "checkout.completed", customer: 1003, total: 1240.0, items: 2, ts: "2026-11-16T13:58:20Z" },
  ];

  const tunnels = [];

  function handle(cmd, a) {
    switch (cmd) {
      case "profiles_load": return JSON.parse(JSON.stringify(store));
      case "current_platform": return window.__platform || "macos";
      case "plugin:app|version": return "0.7.0";
      case "plugin:event|listen": {
        const arr = listeners.get(a.event) || [];
        arr.push(a.handler);
        listeners.set(a.event, arr);
        return a.handler;
      }
      case "plugin:event|unlisten": return null;
      case "secret_exists": return true;
      case "gdrive_auth_status": return { configured: true, connected: true, email: "you@example.com", auto_sync: true, has_passphrase: true, last_push_ms: now - 600e3, last_pull_ms: now - 600e3 };
      case "tunnel_list": return tunnels;
      case "tunnel_start": {
        const t = { id: "tun" + (tunnels.length + 1), local_port: a.params.local_port || 5433, remote_host: a.params.remote_host, remote_port: a.params.remote_port, mode: a.params.mode || "local", ssh_host: a.params.host, ssh_user: a.params.user };
        tunnels.push(t);
        return t;
      }
      case "db_list_databases": {
        const e = a.params.engine;
        if (e === "postgres") return ["analytics", "shop", "postgres"];
        if (e === "mssql") return ["billing", "master"];
        return ["shop", "information_schema", "mysql", "performance_schema"];
      }
      case "db_schema_objects":
        return { tables: a.params && a.params.host && a.params.host.startsWith("198.") ? TABLES : [...TABLES, "reviews"], views: ["v_daily_sales", "v_top_products"], routines: [{ name: "sp_close_month", kind: "PROCEDURE" }, { name: "fn_tax", kind: "FUNCTION" }] };
      case "db_row_counts":
        return { customers: 48210, orders: 312877, order_items: 905122, products: 2310, categories: 42, inventory: 2310, payments: 298004, coupons: 120 };
      case "db_primary_key": return ["id"];
      case "db_foreign_keys": return [];
      case "db_table_schema": {
        const stg = a.params && a.params.host && a.params.host.startsWith("198.");
        return schemaFor(stg ? "stg" : "prod", a.table);
      }
      case "db_query":
      case "db_query_multi": {
        const r = { ...topSql };
        return cmd === "db_query_multi" ? [{ ...r, statement: a.sql }] : r;
      }
      case "sftp_connect": return "sftp1";
      case "sftp_home": return "/srv/shop";
      case "sftp_list": return sftpDir;
      case "sftp_preview": return { kind: "text", content: nginxConf, content_type: "text/plain", size: nginxConf.length, truncated: false };
      case "s3_list_buckets": return s3Buckets;
      case "s3_list_objects": return { entries: s3Entries, next_token: null };
      case "redis_scan": return { cursor: 0, keys: redisKeys };
      case "redis_get": return { kind: "hash", value: JSON.stringify({ user_id: "1004", cart_items: "3", locale: "en-MY", last_seen: "2026-11-16T14:30:11Z" }, null, 2) };
      case "redis_info": return "# Server\r\nredis_version:7.4.1\r\nuptime_in_days:95\r\n# Memory\r\nused_memory_human:182.4M\r\n# Keyspace\r\ndb0:keys=18234,expires=12011\r\n";
      case "mongo_databases": return ["events", "admin"];
      case "mongo_collections": return ["activity", "audit_log", "webhooks"];
      case "mongo_find": return mongoDocs.map((d) => JSON.stringify(d));
      case "mongo_count": return 1284551;
      case "ssh_open_shell": return "ssh1";
      case "local_open": return "local1";
      case "ssh_known_hosts": return {};
      case "list_shells": return [{ path: "/bin/zsh", label: "zsh" }];
      case "ai_key_exists": return true;
      case "ai_complete": {
        const n = (window.__aiTurn = (window.__aiTurn || 0) + 1);
        if (n === 1) return { content: [{ type: "text", text: "Let me check last week's paid orders." }, { type: "tool_use", id: "tu1", name: "run_sql", input: { database: "shop", sql: "SELECT DATE(placed_at) AS day,\n       COUNT(*)   AS orders,\n       SUM(total) AS revenue\nFROM orders\nWHERE status = 'paid'\n  AND placed_at >= NOW() - INTERVAL 7 DAY\nGROUP BY day;" } }], stopReason: "tool_use", usage: { inputTokens: 1200, outputTokens: 90 } };
        return { content: [{ type: "text", text: "Revenue over the last 7 days was **RM 184,320** from **1,912 paid orders**.\n\n- Best day: **Sat 14 Nov** — RM 36,410 (Black Friday preview)\n- Average order: **RM 96.40**, up 8% on the week before\n- Slowest day: Tue 10 Nov — RM 19,880\n\nWant me to break it down by category or save this as a query?" }], stopReason: "end_turn", usage: { inputTokens: 1600, outputTokens: 120 } };
      }
      case "store_latest_version": return null;
      default:
        return null;
    }
  }

  window.__TAURI_INTERNALS__ = {
    metadata: { currentWindow: { label: "main" }, currentWebview: { windowLabel: "main", label: "main" } },
    plugins: {},
    transformCallback(cb, once) {
      const id = nextCb++;
      cbs.set(id, (x) => { if (once) cbs.delete(id); return cb(x); });
      return id;
    },
    unregisterCallback(id) { cbs.delete(id); },
    convertFileSrc: (p) => p,
    invoke(cmd, args) {
      log.push(cmd);
      const hook = window.__mockHook && window.__mockHook(cmd, args || {});
      if (hook !== undefined) return Promise.resolve(hook);
      try { return Promise.resolve(handle(cmd, args || {})); } catch (e) { return Promise.reject(String(e)); }
    },
  };
  window.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener() {} };
  window.__mock = {
    emit(event, payload) {
      for (const id of listeners.get(event) || []) {
        const cb = cbs.get(id);
        if (cb) cb({ event, id, payload });
      }
    },
    channel(id, index, message) { const cb = cbs.get(id); if (cb) cb({ index, message }); },
    listeners,
  };
})();
