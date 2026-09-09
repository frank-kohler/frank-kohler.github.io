// Web server for Brötchen Roulette.
// Serves the static page and exposes GET/POST /api/counts.
// Speicherung: Postgres, sobald DATABASE_URL gesetzt ist (z. B. auf Render mit
// Supabase/Neon) – ansonsten eine lokale JSON-Datei als Fallback fuer die
// Entwicklung (start.bat/start.sh funktionieren damit weiter ohne Datenbank).
const http = require("http");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Startnamen, falls noch keine Daten existieren.
const DEFAULT_NAMES = ["Daniel", "Frank", "Hoai", "Judith", "Jürgen", "Mirco", "Ruben", "Xinyang"];

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".ico": "image/x-icon"
};

// Werte bereinigen: nur endliche Zahlen, sonst 0.
function sanitizeCounts(counts) {
  const clean = {};
  for (const [name, value] of Object.entries(counts)) {
    const n = Number(value);
    clean[name] = Number.isFinite(n) ? n : 0;
  }
  return clean;
}

// --- Speicher-Backend: Postgres (dauerhaft) oder JSON-Datei (lokal) ----------
let storage;

if (process.env.DATABASE_URL) {
  const { Pool } = require("pg");
  const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false } // verwaltete Anbieter (Supabase/Neon/Render) erwarten SSL
  });

  storage = {
    async init() {
      await pool.query(
        "CREATE TABLE IF NOT EXISTS counts (name TEXT PRIMARY KEY, value INTEGER NOT NULL DEFAULT 0)"
      );
      const { rows } = await pool.query("SELECT COUNT(*)::int AS n FROM counts");
      if (rows[0].n === 0) {
        await storage.write(Object.fromEntries(DEFAULT_NAMES.map((n) => [n, 0])));
      }
    },
    async read() {
      const { rows } = await pool.query("SELECT name, value FROM counts ORDER BY name");
      const out = {};
      for (const row of rows) out[row.name] = Number(row.value) || 0;
      return out;
    },
    // Ersetzt den kompletten Datensatz (die Seite sendet immer alle Namen).
    async write(counts) {
      const clean = sanitizeCounts(counts);
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query("TRUNCATE counts");
        const entries = Object.entries(clean);
        if (entries.length > 0) {
          const values = [];
          const params = [];
          entries.forEach(([name, value], i) => {
            values.push(`($${i * 2 + 1}, $${i * 2 + 2})`);
            params.push(name, value);
          });
          await client.query(
            `INSERT INTO counts (name, value) VALUES ${values.join(", ")}`,
            params
          );
        }
        await client.query("COMMIT");
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
      return clean;
    }
  };
} else {
  const DATA_DIR = fs.existsSync(path.join(ROOT, ".data")) ? path.join(ROOT, ".data") : ROOT;
  const DATA_FILE = path.join(DATA_DIR, "broetchen-zaehler.json");
  const LEGACY_FILE = path.join(ROOT, "broetchen-zaehler.json");

  storage = {
    async init() {
      if (fs.existsSync(DATA_FILE)) return;
      if (DATA_FILE !== LEGACY_FILE && fs.existsSync(LEGACY_FILE)) {
        fs.copyFileSync(LEGACY_FILE, DATA_FILE);
      } else {
        await storage.write(Object.fromEntries(DEFAULT_NAMES.map((n) => [n, 0])));
      }
    },
    async read() {
      try {
        return sanitizeCounts(JSON.parse(fs.readFileSync(DATA_FILE, "utf8")));
      } catch {
        return Object.fromEntries(DEFAULT_NAMES.map((n) => [n, 0]));
      }
    },
    async write(counts) {
      const clean = sanitizeCounts(counts);
      fs.writeFileSync(DATA_FILE, JSON.stringify(clean, null, 2) + "\n");
      return clean;
    }
  };
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
  res.end(body);
}

function serveStatic(req, res) {
  const urlPath = decodeURIComponent(req.url.split("?")[0]);
  const rel = urlPath === "/" ? "index.html" : urlPath.replace(/^\/+/, "");
  const filePath = path.join(ROOT, rel);

  // Prevent path traversal outside the project directory.
  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  fs.readFile(filePath, (err, content) => {
    if (err) {
      res.writeHead(404);
      res.end("Not found");
      return;
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(filePath)] || "application/octet-stream" });
    res.end(content);
  });
}

const server = http.createServer((req, res) => {
  if (req.url.split("?")[0] === "/api/counts") {
    if (req.method === "GET") {
      storage.read()
        .then((counts) => sendJson(res, 200, counts))
        .catch((err) => {
          console.error("Lesen fehlgeschlagen:", err);
          sendJson(res, 500, { error: "Read failed" });
        });
      return;
    }
    if (req.method === "POST") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk;
        if (body.length > 1e5) req.destroy(); // guard against oversized payloads
      });
      req.on("end", () => {
        let parsed;
        try {
          parsed = JSON.parse(body);
        } catch {
          sendJson(res, 400, { error: "Invalid JSON" });
          return;
        }
        storage.write(parsed)
          .then((saved) => sendJson(res, 200, saved))
          .catch((err) => {
            console.error("Speichern fehlgeschlagen:", err);
            sendJson(res, 500, { error: "Write failed" });
          });
      });
      return;
    }
    res.writeHead(405);
    res.end("Method not allowed");
    return;
  }

  serveStatic(req, res);
});

server.on("error", (err) => {
  if (err.code === "EADDRINUSE") {
    console.error(`Port ${PORT} ist bereits belegt – laeuft der Server schon in einem anderen Fenster?`);
    console.error(`Schliesse das andere Fenster oder starte mit einem anderen Port, z. B.: PORT=3001 node server.js`);
    process.exit(1);
  }
  throw err;
});

storage.init()
  .then(() => {
    server.listen(PORT, () => {
      const backend = process.env.DATABASE_URL ? "Postgres" : "JSON-Datei";
      console.log(`Brötchen Roulette läuft auf http://localhost:${PORT} (Speicher: ${backend})`);
    });
  })
  .catch((err) => {
    console.error("Initialisierung des Speichers fehlgeschlagen:", err);
    process.exit(1);
  });
