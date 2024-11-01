const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST"],
		allowedHeaders: ["*"],
		credentials: true
	},
	transports: ['websocket'],
	pingTimeout: 60000,
	pingInterval: 25000
});

const PORT = process.env.PORT || 3000;

// Stockage des utilisateurs connectés
const connectedUsers = new Map();

// Middleware CORS pour les routes Express
app.use((req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Methods', 'GET, POST');
	res.header('Access-Control-Allow-Headers', '*');
	next();
});

// Route de test
app.get('/', (req, res) => {
	res.send('Serveur de signaling en fonctionnement');
});

// Gestion des connexions WebSocket
io.on('connection', (socket) => {
	console.log('Nouvelle connexion établie:', socket.id);

	// Enregistrement des utilisateurs
	socket.on('register', (data) => {
		const { userId, userType } = data;
		connectedUsers.set(userId, {
			socketId: socket.id,
			userType: userType,
			isAvailable: userType === 'user' ? true : false
		});
		
		console.log(`${userType} enregistré:`, userId);

		if (userType === 'confident') {
			broadcastConfidentStatus(userId);
		} else {
			sendAvailableConfidents(socket);
		}
	});

	// Gestion de la disponibilité
	socket.on('update-availability', (available) => {
		const userId = getUserIdBySocketId(socket.id);
		if (userId) {
			const userData = connectedUsers.get(userId);
			if (userData && userData.userType === 'confident') {
				userData.isAvailable = available;
				console.log(`Statut du confident ${userId} mis à jour: ${available ? 'disponible' : 'indisponible'}`);
				broadcastConfidentStatus(userId);
			}
		}
	});

	// Gestion des appels
	socket.on('call-request', (targetConfidentId) => {
		const confidentData = connectedUsers.get(targetConfidentId);
		if (confidentData && confidentData.isAvailable) {
			console.log(`Demande d'appel vers le confident: ${targetConfidentId}`);
			io.to(confidentData.socketId).emit('incoming-call', {
				callerId: getUserIdBySocketId(socket.id)
			});
		} else {
			socket.emit('call-failed', {
				reason: 'Confident non disponible'
			});
		}
	});

	// Réponse aux appels
	socket.on('call-response', (data) => {
		const { callerId, accepted } = data;
		const callerData = connectedUsers.get(callerId);
		if (callerData) {
			io.to(callerData.socketId).emit('call-answered', {
				accepted,
				confidentId: getUserIdBySocketId(socket.id)
			});
		}
	});

	// Signaling WebRTC
	socket.on('webrtc-offer', (data) => {
		const { targetId, offer } = data;
		const targetData = connectedUsers.get(targetId);
		if (targetData) {
			io.to(targetData.socketId).emit('webrtc-offer', {
				offer,
				callerId: getUserIdBySocketId(socket.id)
			});
		}
	});

	socket.on('webrtc-answer', (data) => {
		const { targetId, answer } = data;
		const targetData = connectedUsers.get(targetId);
		if (targetData) {
			io.to(targetData.socketId).emit('webrtc-answer', {
				answer,
				confidentId: getUserIdBySocketId(socket.id)
			});
		}
	});

	socket.on('ice-candidate', (data) => {
		const { targetId, candidate } = data;
		const targetData = connectedUsers.get(targetId);
		if (targetData) {
			io.to(targetData.socketId).emit('ice-candidate', {
				candidate,
				fromId: getUserIdBySocketId(socket.id)
			});
		}
	});

	// Fin d'appel
	socket.on('end-call', (targetId) => {
		const targetData = connectedUsers.get(targetId);
		if (targetData) {
			io.to(targetData.socketId).emit('call-ended', {
				fromId: getUserIdBySocketId(socket.id)
			});
		}
	});

	// Déconnexion
	socket.on('disconnect', () => {
		const userId = getUserIdBySocketId(socket.id);
		if (userId) {
			const userData = connectedUsers.get(userId);
			if (userData && userData.userType === 'confident') {
				io.emit('confident-disconnected', { confidentId: userId });
			}
			connectedUsers.delete(userId);
			console.log(`Utilisateur déconnecté: ${userId}`);
		}
	});
});

// Fonctions utilitaires
function broadcastConfidentStatus(confidentId) {
	const confidentData = connectedUsers.get(confidentId);
	if (confidentData) {
		io.emit('confident-status-update', {
			confidentId,
			isAvailable: confidentData.isAvailable
		});
	}
}

function sendAvailableConfidents(socket) {
	const availableConfidents = Array.from(connectedUsers.entries())
		.filter(([_, data]) => data.userType === 'confident' && data.isAvailable)
		.map(([id, _]) => id);
	
	socket.emit('available-confidents', availableConfidents);
}

function getUserIdBySocketId(socketId) {
	for (const [userId, data] of connectedUsers.entries()) {
		if (data.socketId === socketId) return userId;
	}
	return null;
}

// Démarrage du serveur
server.listen(PORT, () => {
	console.log(`Serveur de signaling démarré sur le port ${PORT}`);
	console.log(`WebSocket prêt à accepter les connexions`);
});