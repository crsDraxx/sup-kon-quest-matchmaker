const WebSocket = require('ws')
const http      = require('http')
const crypto    = require('crypto')

const server = http.createServer()
const wss    = new WebSocket.Server({ server })

// ── Stockage en mémoire ──────────────────────────────────────
const rooms   = {}   // { room_name: { ip, format, map, mode, diff, players, max_players, started } }
const players = {}   // { username: { password_hash, pseudo, wins, losses, created_at } }
const sessions = {}  // { token: username }

// ── Utilitaires ───────────────────────────────────────────────
function hash(str) {
  return crypto.createHash('sha256').update(str).digest('hex')
}

function generate_token() {
  return crypto.randomBytes(32).toString('hex')
}

// ── WebSocket ─────────────────────────────────────────────────
wss.on('connection', (ws) => {
  console.log('Client connecte')

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message)

      // ════ COMPTES ════════════════════════════════════════════

      // Créer un compte
      if (data.action === 'register') {
        const { username, password, pseudo } = data
        if (!username || !password || !pseudo) {
          ws.send(JSON.stringify({ status: 'error', message: 'Champs manquants' }))
          return
        }
        if (players[username]) {
          ws.send(JSON.stringify({ status: 'error', message: 'Nom d\'utilisateur deja pris' }))
          return
        }
        players[username] = {
          password_hash: hash(password),
          pseudo,
          wins:       0,
          losses:     0,
          created_at: Date.now()
        }
        const token = generate_token()
        sessions[token] = username
        console.log(`Compte cree : ${username} (${pseudo})`)
        ws.send(JSON.stringify({ status: 'registered', token, pseudo, username }))
      }

      // Se connecter
      if (data.action === 'login') {
        const { username, password } = data
        if (!players[username]) {
          ws.send(JSON.stringify({ status: 'error', message: 'Compte introuvable' }))
          return
        }
        if (players[username].password_hash !== hash(password)) {
          ws.send(JSON.stringify({ status: 'error', message: 'Mot de passe incorrect' }))
          return
        }
        const token = generate_token()
        sessions[token] = username
        console.log(`Connexion : ${username}`)
        ws.send(JSON.stringify({
          status:   'logged_in',
          token,
          pseudo:   players[username].pseudo,
          username,
          wins:     players[username].wins,
          losses:   players[username].losses
        }))
      }

      // Verifier un token
      if (data.action === 'verify_token') {
        const username = sessions[data.token]
        if (!username || !players[username]) {
          ws.send(JSON.stringify({ status: 'invalid_token' }))
          return
        }
        ws.send(JSON.stringify({
          status:   'valid_token',
          pseudo:   players[username].pseudo,
          username,
          wins:     players[username].wins,
          losses:   players[username].losses
        }))
      }

      // Se deconnecter
      if (data.action === 'logout') {
        delete sessions[data.token]
        ws.send(JSON.stringify({ status: 'logged_out' }))
      }

      // Mettre a jour les stats
      if (data.action === 'update_stats') {
        const username = sessions[data.token]
        if (!username || !players[username]) return
        if (data.won) players[username].wins++
        else          players[username].losses++
        ws.send(JSON.stringify({ status: 'stats_updated' }))
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
server.listen(PORT, () => console.log(`Serveur demarre sur le port ${PORT}`))
