const { WebSocketServer } = require("ws");
const http                = require("http");
const { Pool }            = require("pg");
const bcrypt              = require("bcrypt");
const jwt                 = require("jsonwebtoken");

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const PORT       = process.env.PORT       || 3000;
const JWT_SECRET = process.env.JWT_SECRET || "change_this_secret_in_render_env";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

// ─── INIT DB (crée la table si elle n'existe pas) ─────────────────────────────
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS users (
      id         SERIAL PRIMARY KEY,
      username   TEXT UNIQUE NOT NULL,
      pseudo     TEXT        NOT NULL,
      password   TEXT        NOT NULL,
      wins       INT         NOT NULL DEFAULT 0,
      losses     INT         NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  console.log("[DB] Table users prête");
}

// ─── ROOMS (en mémoire, comme avant) ─────────────────────────────────────────
const rooms = {};

// ─── SERVEUR HTTP (Render a besoin d'un port HTTP pour le health-check) ───────
const server = http.createServer(async(_req, res) => {
  res.writeHead(200);
  res.end("Matchmaker OK");
  if (_req.url === "/users") {
    const result = await pool.query(
      "SELECT id, username, pseudo, wins, losses, created_at FROM users"
    );
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(result.rows, null, 2));
    return;
  }
  res.writeHead(200);
  res.end("Matchmaker OK");
});

// ─── WEBSOCKET ────────────────────────────────────────────────────────────────
const wss = new WebSocketServer({ server });

wss.on("connection", (ws) => {
  console.log("[WS] Client connecté");

  ws.on("message", async (raw) => {
    let data;
    try { data = JSON.parse(raw); }
    catch { return ws.send(JSON.stringify({ status: "error", message: "JSON invalide" })); }

    const action = data.action || "";
    console.log(`[WS] action=${action}`);

    try {
      switch (action) {

        // ── AUTH ────────────────────────────────────────────────────────────

        case "register": {
          const { username, password, pseudo } = data;
          if (!username || !password || !pseudo)
            return send(ws, { status: "error", message: "Champs manquants" });
          if (username.length < 3)
            return send(ws, { status: "error", message: "Nom trop court (min 3)" });
          if (password.length < 6)
            return send(ws, { status: "error", message: "Mot de passe trop court (min 6)" });

          const exists = await pool.query("SELECT id FROM users WHERE username=$1", [username]);
          if (exists.rows.length > 0)
            return send(ws, { status: "error", message: "Nom d'utilisateur déjà pris" });

          const hash  = await bcrypt.hash(password, 10);
          const result = await pool.query(
            "INSERT INTO users (username, pseudo, password) VALUES ($1,$2,$3) RETURNING id",
            console.log(`[DB] Utilisateur créé : id=${result.rows[0].id}, username=${username}`);
            [username, pseudo, hash]
          );
          const token = jwt.sign({ id: result.rows[0].id, username }, JWT_SECRET, { expiresIn: "30d" });
          send(ws, { status: "registered", token, username, pseudo });
          break;
        }

        case "login": {
          const { username, password } = data;
          if (!username || !password)
            return send(ws, { status: "error", message: "Champs manquants" });

          const result = await pool.query(
            "SELECT id, password, pseudo, wins, losses FROM users WHERE username=$1",
            [username]
          );
          if (result.rows.length === 0)
            return send(ws, { status: "error", message: "Utilisateur introuvable" });

          const user = result.rows[0];
          const ok   = await bcrypt.compare(password, user.password);
          if (!ok)
            return send(ws, { status: "error", message: "Mot de passe incorrect" });

          const token = jwt.sign({ id: user.id, username }, JWT_SECRET, { expiresIn: "30d" });
          send(ws, { status: "logged_in", token, username, pseudo: user.pseudo, wins: user.wins, losses: user.losses });
          break;
        }

        case "verify_token": {
          const { token } = data;
          if (!token) return send(ws, { status: "invalid_token" });
          let payload;
          try { payload = jwt.verify(token, JWT_SECRET); }
          catch { return send(ws, { status: "invalid_token" }); }

          const result = await pool.query(
            "SELECT username, pseudo, wins, losses FROM users WHERE id=$1",
            [payload.id]
          );
          if (result.rows.length === 0) return send(ws, { status: "invalid_token" });

          const u = result.rows[0];
          send(ws, { status: "valid_token", username: u.username, pseudo: u.pseudo, wins: u.wins, losses: u.losses });
          break;
        }

        case "logout":
          // JWT est stateless : on répond juste OK, le client supprime son token local
          send(ws, { status: "logged_out" });
          break;

        case "update_stats": {
          const { token, won } = data;
          if (!token) return send(ws, { status: "error", message: "Token manquant" });
          let payload;
          try { payload = jwt.verify(token, JWT_SECRET); }
          catch { return send(ws, { status: "error", message: "Token invalide" }); }

          if (won) {
            await pool.query("UPDATE users SET wins=wins+1 WHERE id=$1", [payload.id]);
          } else {
            await pool.query("UPDATE users SET losses=losses+1 WHERE id=$1", [payload.id]);
          }
          send(ws, { status: "stats_updated" });
          break;
        }

        // ── ROOMS (inchangé) ─────────────────────────────────────────────────

        case "create": {
          const { room, ip, format, map, mode, diff, players, max_players } = data;
          rooms[room] = { ip, format, map, mode, diff, players, max_players, started: false };
          console.log(`[Rooms] Créée : ${room}`);
          send(ws, { status: "created", room });
          break;
        }

        case "find": {
          const r = rooms[data.room];
          if (r) send(ws, { status: "found", ip: r.ip, room: data.room });
          else   send(ws, { status: "not_found" });
          break;
        }

        case "list": {
          const list = Object.entries(rooms).map(([name, r]) => ({
            name, ...r,
            full: r.players >= r.max_players
          }));
          send(ws, { status: "list", rooms: list });
          break;
        }

        case "update": {
          if (rooms[data.room]) {
            rooms[data.room].players = data.players;
            rooms[data.room].started = data.started;
          }
          break;
        }

        case "delete": {
          delete rooms[data.room];
          console.log(`[Rooms] Supprimée : ${data.room}`);
          break;
        }

        default:
          send(ws, { status: "error", message: `Action inconnue : ${action}` });
      }
    } catch (err) {
      console.error("[WS] Erreur :", err);
      send(ws, { status: "error", message: "Erreur serveur" });
    }
  });

  ws.on("close", () => console.log("[WS] Client déconnecté"));
});

function send(ws, obj) {
  ws.send(JSON.stringify(obj));
}

// ─── DÉMARRAGE ────────────────────────────────────────────────────────────────
initDB().then(() => {
  server.listen(PORT, () => console.log(`[Server] Écoute sur le port ${PORT}`));
}).catch(err => {
  console.error("[DB] Erreur init :", err);
  process.exit(1);
});
