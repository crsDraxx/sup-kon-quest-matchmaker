const WebSocket = require('ws')
const http      = require('http')
const crypto    = require('crypto')
const { Pool }  = require('pg')

// ── Connexion PostgreSQL ──────────────────────────────────────
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
})

// ── Initialisation des tables ─────────────────────────────────
async function init_db() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS players (
      id           SERIAL PRIMARY KEY,
      username     VARCHAR(50) UNIQUE NOT NULL,
      password_hash VARCHAR(64) NOT NULL,
      pseudo       VARCHAR(50) NOT NULL,
      wins         INTEGER DEFAULT 0,
      losses       INTEGER DEFAULT 0,
      created_at   TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS sessions (
      token      VARCHAR(64) PRIMARY KEY,
      username   VARCHAR(50) NOT NULL,
      created_at TIMESTAMP DEFAULT NOW()
    )
  `)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS saves (
      id         SERIAL PRIMARY KEY,
      username   VARCHAR(50) NOT NULL,
      room_name  VARCHAR(100) NOT NULL,
      save_data  TEXT NOT NULL,
      saved_at   TIMESTAMP DEFAULT NOW()
    )
  `)
  console.log('Base de donnees initialisee')
}

// ── Utilitaires ───────────────────────────────────────────────
function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}

function generate_token() {
  return crypto.randomBytes(32).toString('hex')
}

// ── Stockage rooms en memoire ─────────────────────────────────
const rooms = {}

// ── WebSocket ─────────────────────────────────────────────────
const server = http.createServer()
const wss    = new WebSocket.Server({ server })

wss.on('connection', (ws) => {
  console.log('Client connecte')

  ws.on('message', async (message) => {
    try {
      const data = JSON.parse(message)

      // ════ COMPTES ════════════════════════════════════════════

      // Creer un compte
      if (data.action === 'register') {
        const { username, password, pseudo } = data
        if (!username || !password || !pseudo) {
          ws.send(JSON.stringify({ status: 'error', message: 'Champs manquants' }))
          return
        }
        try {
          const token = generate_token()
          await pool.query(
            'INSERT INTO players (username, password_hash, pseudo) VALUES ($1, $2, $3)',
            [username, hash(password), pseudo]
          )
          await pool.query(
            'INSERT INTO sessions (token, username) VALUES ($1, $2)',
            [token, username]
          )
          console.log(`Compte cree : ${username}`)
          ws.send(JSON.stringify({ status: 'registered', token, pseudo, username }))
        } catch (e) {
          if (e.code === '23505') {
            ws.send(JSON.stringify({ status: 'error', message: 'Nom d\'utilisateur deja pris' }))
          } else {
            ws.send(JSON.stringify({ status: 'error', message: 'Erreur serveur' }))
          }
        }
      }

      // Se connecter
      if (data.action === 'login') {
        const { username, password } = data
        const result = await pool.query(
          'SELECT * FROM players WHERE username = $1',
          [username]
        )
        if (result.rows.length === 0) {
          ws.send(JSON.stringify({ status: 'error', message: 'Compte introuvable' }))
          return
        }
        const player = result.rows[0]
        if (player.password_hash !== hash(password)) {
          ws.send(JSON.stringify({ status: 'error', message: 'Mot de passe incorrect' }))
          return
        }
        const token = generate_token()
        await pool.query(
          'INSERT INTO sessions (token, username) VALUES ($1, $2)',
          [token, username]
        )
        console.log(`Connexion : ${username}`)
        ws.send(JSON.stringify({
          status:   'logged_in',
          token,
          pseudo:   player.pseudo,
          username,
          wins:     player.wins,
          losses:   player.losses
        }))
      }

      // Verifier un token
      if (data.action === 'verify_token') {
        const session = await pool.query(
          'SELECT * FROM sessions WHERE token = $1',
          [data.token]
        )
        if (session.rows.length === 0) {
          ws.send(JSON.stringify({ status: 'invalid_token' }))
          return
        }
        const username = session.rows[0].username
        const player = await pool.query(
          'SELECT * FROM players WHERE username = $1',
          [username]
        )
        if (player.rows.length === 0) {
          ws.send(JSON.stringify({ status: 'invalid_token' }))
          return
        }
        ws.send(JSON.stringify({
          status:   'valid_token',
          pseudo:   player.rows[0].pseudo,
          username,
          wins:     player.rows[0].wins,
          losses:   player.rows[0].losses
        }))
      }

      // Se deconnecter
      if (data.action === 'logout') {
        await pool.query('DELETE FROM sessions WHERE token = $1', [data.token])
        ws.send(JSON.stringify({ status: 'logged_out' }))
      }

      // Mettre a jour les stats
      if (data.action === 'update_stats') {
        const session = await pool.query(
          'SELECT username FROM sessions WHERE token = $1',
          [data.token]
        )
        if (session.rows.length === 0) return
        const username = session.rows[0].username
        if (data.won) {
          await pool.query('UPDATE players SET wins = wins + 1 WHERE username = $1', [username])
        } else {
          await pool.query('UPDATE players SET losses = losses + 1 WHERE username = $1', [username])
        }
        ws.send(JSON.stringify({ status: 'stats_updated' }))
      }

      // ════ SAUVEGARDES ════════════════════════════════════════

      // Sauvegarder une partie
      if (data.action === 'save_game') {
        const session = await pool.query(
          'SELECT username FROM sessions WHERE token = $1',
          [data.token]
        )
        if (session.rows.length === 0) return
        const username = session.rows[0].username
        await pool.query(
          `INSERT INTO saves (username, room_name, save_data)
           VALUES ($1, $2, $3)
           ON CONFLICT DO NOTHING`,
          [username, data.room_name, JSON.stringify(data.save_data)]
        )
        ws.send(JSON.stringify({ status: 'game_saved' }))
      }

      // Charger une sauvegarde
      if (data.action === 'load_game') {
        const session = await pool.query(
          'SELECT username FROM sessions WHERE token = $1',
          [data.token]
        )
        if (session.rows.length === 0) return
        const username = session.rows[0].username
        const saves = await pool.query(
          'SELECT * FROM saves WHERE username = $1 ORDER BY saved_at DESC',
          [username]
        )
        ws.send(JSON.stringify({
          status: 'saves_loaded',
          saves:  saves.rows
        }))
      }

      // ════ ROOMS ══════════════════════════════════════════════

      if (data.action === 'create') {
        rooms[data.room] = {
          ip:          data.ip,
          format:      data.format,
          map:         data.map,
          mode:        data.mode   || 'multi',
          diff:        data.diff   || 'med',
          players:     data.players || 1,
          max_players: data.max_players || 2,
          started:     false
        }
        console.log(`Room creee : ${data.room}`)
        ws.send(JSON.stringify({ status: 'created', room: data.room }))
      }

      if (data.action === 'find') {
        const room = rooms[data.room]
        if (room) {
          ws.send(JSON.stringify({ status: 'found', ip: room.ip }))
        } else {
          ws.send(JSON.stringify({ status: 'not_found' }))
        }
      }

      if (data.action === 'list') {
        const available = Object.entries(rooms).map(([name, room]) => ({
          name,
          format:      room.format,
          map:         room.map,
          mode:        room.mode,
          diff:        room.diff,
          players:     room.players,
          max_players: room.max_players,
          started:     room.started,
          full:        room.players >= room.max_players
        }))
        ws.send(JSON.stringify({ status: 'list', rooms: available }))
      }

      if (data.action === 'update') {
        if (rooms[data.room]) {
          rooms[data.room].players = data.players
          rooms[data.room].started = data.started || false
        }
      }

      if (data.action === 'delete') {
        delete rooms[data.room]
        console.log(`Room supprimee : ${data.room}`)
      }

    } catch (e) {
      console.error('Erreur message:', e)
    }
  })

  ws.on('close', () => console.log('Client deconnecte'))
})

const PORT = process.env.PORT || 3000
init_db().then(() => {
  server.listen(PORT, () => console.log(`Serveur demarre sur le port ${PORT}`))
})
