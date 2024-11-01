const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;

// Structure pour stocker les informations des utilisateurs connectés
// Format: { userId: { socketId, userType, isAvailable } }
const connectedUsers = new Map();

// Route de base pour vérifier que le serveur fonctionne
app.get('/', (req, res) => {
	res.send('Serveur de signaling en fonctionnement');
});

// Gestion des connexions WebSocket
io.on('connection', (socket) => {
	console.log('Nouvelle connexion établie:', socket.id);

	// Gestion de l'enregistrement des utilisateurs (users et confidents)
	socket.on('register', (data) => {
		const { userId, userType } = data;
		connectedUsers.set(userId, {
			socketId: socket.id,
			userType: userType, // 'user' ou 'confident'
			isAvailable: userType === 'user' ? true : false // Les confidents démarrent non disponibles
		});
		
		console.log(`${userType} enregistré:`, userId);

		// Si c'est un confident qui se connecte, informer tous les users
		if (userType === 'confident') {
			broadcastConfidentStatus(userId);
		}
		// Si c'est un user, lui envoyer la liste des confidents disponibles
		else {
			sendAvailableConfidents(socket);
		}
	});

	// Gestion du changement de disponibilité des confidents
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

	// Gestion des demandes d'appel
	socket.on('call-request', (targetConfidentId) => {
		const confidentData = connectedUsers.get(targetConfidentId);
		if (confidentData && confidentData.isAvailable) {
			console.log(`Demande d'appel vers le confident: ${targetConfidentId}`);
			io.to(confidentData.socketId).emit('incoming-call', {
				callerId: getUserIdBySocketId(socket.id)
			});
		} else {
			// Informer l'appelant que le confident n'est pas disponible
			socket.emit('call-failed', {
				reason: 'Confident non disponible'
			});
		}
	});

	// Gestion de la réponse à l'appel
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

	// Gestion des offres WebRTC
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

	// Gestion des réponses WebRTC
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

	// Gestion des candidats ICE
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

	// Gestion de la fin d'appel
	socket.on('end-call', (targetId) => {
		const targetData = connectedUsers.get(targetId);
		if (targetData) {
			io.to(targetData.socketId).emit('call-ended', {
				fromId: getUserIdBySocketId(socket.id)
			});
		}
	});

	// Gestion de la déconnexion
	socket.on('disconnect', () => {
		const userId = getUserIdBySocketId(socket.id);
		if (userId) {
			const userData = connectedUsers.get(userId);
			if (userData && userData.userType === 'confident') {
				// Informer les users de la déconnexion du confident
				io.emit('confident-disconnected', { confidentId: userId });
			}
			connectedUsers.delete(userId);
			console.log(`Utilisateur déconnecté: ${userId}`);
		}
	});
});

// Fonction pour diffuser le statut d'un confident à tous les users
function broadcastConfidentStatus(confidentId) {
	const confidentData = connectedUsers.get(confidentId);
	if (confidentData) {
		io.emit('confident-status-update', {
			confidentId,
			isAvailable: confidentData.isAvailable
		});
	}
}

// Fonction pour envoyer la liste des confidents disponibles à un user
function sendAvailableConfidents(socket) {
	const availableConfidents = Array.from(connectedUsers.entries())
		.filter(([_, data]) => data.userType === 'confident' && data.isAvailable)
		.map(([id, _]) => id);
	
	socket.emit('available-confidents', availableConfidents);
}

// Fonction utilitaire pour retrouver l'ID d'un utilisateur à partir de son socketId
function getUserIdBySocketId(socketId) {
	for (const [userId, data] of connectedUsers.entries()) {
		if (data.socketId === socketId) return userId;
	}
	return null;
}

// Démarrage du serveur
server.listen(PORT, () => {
	console.log(`Serveur de signaling démarré sur le port ${PORT}`);
});