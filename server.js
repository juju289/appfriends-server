const express = require('express');
const app = express();
const server = require('http').Server(app);
const io = require('socket.io')(server);

const PORT = process.env.PORT || 3000;

// Stockage des utilisateurs connectés
const connectedUsers = new Map();

io.on('connection', (socket) => {
	console.log('Un utilisateur connecté:', socket.id);

	// Quand un utilisateur s'enregistre
	socket.on('register', (userId) => {
		connectedUsers.set(userId, socket.id);
		console.log(`Utilisateur ${userId} enregistré`);
	});

	// Pour initier un appel
	socket.on('call-user', (data) => {
		const { targetUserId, offer } = data;
		const targetSocketId = connectedUsers.get(targetUserId);
		
		if (targetSocketId) {
			io.to(targetSocketId).emit('incoming-call', {
				callerId: socket.id,
				offer: offer
			});
		}
	});

	// Pour répondre à un appel
	socket.on('answer-call', (data) => {
		const { targetUserId, answer } = data;
		const targetSocketId = connectedUsers.get(targetUserId);
		
		if (targetSocketId) {
			io.to(targetSocketId).emit('call-answered', {
				answer: answer
			});
		}
	});

	// Pour les candidats ICE
	socket.on('ice-candidate', (data) => {
		const { targetUserId, candidate } = data;
		const targetSocketId = connectedUsers.get(targetUserId);
		
		if (targetSocketId) {
			io.to(targetSocketId).emit('ice-candidate', {
				candidate: candidate
			});
		}
	});

	socket.on('disconnect', () => {
		// Retirer l'utilisateur de la liste des connectés
		for (const [userId, socketId] of connectedUsers.entries()) {
			if (socketId === socket.id) {
				connectedUsers.delete(userId);
				break;
			}
		}
	});
});

// Route de base pour vérifier que le serveur fonctionne
app.get('/', (req, res) => {
	res.send('Serveur de signaling AppFriends en fonctionnement!');
});

server.listen(PORT, () => {
	console.log(`Server is running on port ${PORT}`);
});