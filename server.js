const WebSocket = require('ws')
const http = require('http')

const server = http.createServer()
const wss = new WebSocket.Server({ server })

// { nom_room: { ip, format, map, players, max_players, started } }
const rooms = {}

wss.on('connection', (ws) => {
  console.log('Nouveau client connecte')

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message)

      // Hote cree une room
      if (data.action === 'create') {
        rooms[data.room] = {
          ip:          data.ip,
          format:      data.format,
          map:         data.map,
          players:     data.players || 1,
          max_players: data.max_players || 2,
          started:     false
        }
        console.log(`Room creee : ${data.room}`)
        ws.send(JSON.stringify({ status: 'created', room: data.room }))
      }

      // Client cherche une room par nom
      if (data.action === 'find') {
        const room = rooms[data.room]
        if (room) {
          console.log(`Room trouvee : ${data.room}`)
          ws.send(JSON.stringify({ status: 'found', ip: room.ip, room: data.room }))
        } else {
          ws.send(JSON.stringify({ status: 'not_found' }))
        }
      }

      // Client demande la liste des rooms disponibles
      if (data.action === 'list') {
        const available = []
        for (const [name, room] of Object.entries(rooms)) {
          available.push({
            name:        name,
            format:      room.format,
            map:         room.map,
            players:     room.players,
            max_players: room.max_players,
            started:     room.started,
            full:        room.players >= room.max_players
          })
        }
        ws.send(JSON.stringify({ status: 'list', rooms: available }))
      }

      // Mettre a jour le nombre de joueurs
      if (data.action === 'update') {
        if (rooms[data.room]) {
          rooms[data.room].players = data.players
          rooms[data.room].started = data.started || false
        }
      }

      // Supprimer une room
      if (data.action === 'delete') {
        delete rooms[data.room]
        console.log(`Room supprimee : ${data.room}`)
      }

    } catch (e) {
      console.error('Erreur message:', e)
    }
  })

  ws.on('close', () => {
    console.log('Client deconnecte')
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Matchmaker demarre sur le port ${PORT}`)
})
