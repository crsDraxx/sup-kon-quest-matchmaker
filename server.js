const WebSocket = require('ws')
const http = require('http')

const server = http.createServer()
const wss = new WebSocket.Server({ server })

// Annuaire des rooms { nom_room: ip_hote }
const rooms = {}

wss.on('connection', (ws) => {
  console.log('Nouveau client connecté')

  ws.on('message', (message) => {
    try {
      const data = JSON.parse(message)

      // Hôte crée une room
      if (data.action === 'create') {
        rooms[data.room] = data.ip
        console.log(`Room créée : ${data.room} → ${data.ip}`)
        ws.send(JSON.stringify({ status: 'created', room: data.room }))
      }

      // Client cherche une room
      if (data.action === 'find') {
        const ip = rooms[data.room]
        if (ip) {
          console.log(`Room trouvée : ${data.room} → ${ip}`)
          ws.send(JSON.stringify({ status: 'found', ip: ip }))
        } else {
          console.log(`Room introuvable : ${data.room}`)
          ws.send(JSON.stringify({ status: 'not_found' }))
        }
      }

      // Hôte supprime sa room
      if (data.action === 'delete') {
        delete rooms[data.room]
        console.log(`Room supprimée : ${data.room}`)
      }

    } catch (e) {
      console.error('Erreur message:', e)
    }
  })

  ws.on('close', () => {
    console.log('Client déconnecté')
  })
})

const PORT = process.env.PORT || 3000
server.listen(PORT, () => {
  console.log(`Matchmaker démarré sur le port ${PORT}`)
})
