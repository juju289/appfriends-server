const express = require('express');
const app = express();
const server = require('http').createServer(app);
const io = require('socket.io')(server, {
	cors: {
		origin: "*",
		methods: ["GET", "POST", "OPTIONS"],
		allowedHeaders: ["*"],
		credentials: true
	},
	allowEIO3: true,
	transports: ['websocket', 'polling'],
	pingTimeout: 60000,
	pingInterval: 25000,
	path: '/socket.io/'
});

const PORT = process.env.PORT || 3000;

// Structure de données pour les utilisateurs
class User {
	constructor(socketId, userType, name = '') {
		this.socketId = socketId;
		this.userType = userType;
		this.name = name;
		this.isAvailable = userType === 'confident' ? true : false;
		this.currentCallId = null;
	}
}

// Gestionnaire d'état global
class StateManager {
	constructor() {
		this.users = new Map();       // userId -> User
		this.calls = new Map();       // callId -> Call
		this.sockets = new Map();     // socketId -> userId
	}

	addUser(userId, socketId, userType, name = '') {
		const user = new User(socketId, userType, name);
		this.users.set(userId, user);
		this.sockets.set(socketId, userId);
		return user;
	}

	removeUser(userId) {
		const user = this.users.get(userId);
		if (user) {
			this.sockets.delete(user.socketId);
			this.users.delete(userId);
		}
	}

	getUserBySocket(socketId) {
		const userId = this.sockets.get(socketId);
		return userId ? this.users.get(userId) : null;
	}

	getAvailableConfidents() {
		return Array.from(this.users.entries())
			.filter(([_, user]) => user.userType === 'confident' && user.isAvailable)
			.map(([id, user]) => ({
				userId: id,
				name: user.name,
				isAvailable: true
			}));
	}
}

const state = new StateManager();

// Middleware CORS
app.use((req, res, next) => {
	res.header('Access-Control-Allow-Origin', '*');
	res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
	res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Sec-WebSocket-Protocol');
	res.header('Access-Control-Allow-Credentials', 'true');
	
	if (req.method === 'OPTIONS') {
		return res.status(200).end();
	}
	next();
});

// Routes API
app.get('/', (req, res) => {
	res.send('Serveur de signaling WebRTC en fonctionnement');
});

app.get('/status', (req, res) => {
	const status = {
		connectedUsers: state.users.size,
		availableConfidents: state.getAvailableConfidents().length,
		activeConnections: io.engine.clientsCount
	};
	res.json(status);
});

// Gestionnaire WebSocket
io.on('connection', (socket) => {
	console.log('🔌 Nouvelle connexion:', socket.id);

	// Enregistrement
	socket.on('register', (data) => {
		try {
			const { userId, userType, name = '' } = data;
			
			if (!userId || !userType) {
				throw new Error('Données d\'enregistrement invalides');
			}

			const user = state.addUser(userId, socket.id, userType, name);
			console.log(`✅ ${userType} enregistré:`, userId);

			// Envoi de la confirmation
			socket.emit('registered', {
				success: true,
				userId: userId,
				userType: userType
			});

			// Si c'est un utilisateur, envoi la liste des confidents disponibles
			if (userType === 'user') {
				socket.emit('available-confidents', {
					confidents: state.getAvailableConfidents()
				});
			}

			// Notification aux autres utilisateurs
			if (userType === 'confident') {
				socket.broadcast.emit('confident-status-update', {
					confidentId: userId,
					isAvailable: user.isAvailable,
					name: user.name
				});
			}
		} catch (error) {
			console.error('❌ Erreur d\'enregistrement:', error);
			socket.emit('error', {
				type: 'REGISTRATION_ERROR',
				message: error.message
			});
		}
	});

	// Gestion de la disponibilité
	socket.on('update-availability', (data) => {
		try {
			const { available } = data;
			const user = state.getUserBySocket(socket.id);
			
			if (!user || user.userType !== 'confident') {
				throw new Error('Utilisateur non autorisé');
			}

			user.isAvailable = available;
			
			// Notification du changement de statut
			io.emit('confident-status-update', {
				confidentId: state.sockets.get(socket.id),
				isAvailable: available,
				name: user.name
			});
		} catch (error) {
			console.error('❌ Erreur de mise à jour de disponibilité:', error);
			socket.emit('error', {
				type: 'AVAILABILITY_UPDATE_ERROR',
				message: error.message
			});
		}
	});

	// Signaling WebRTC
	socket.on('webrtc-offer', (data) => {
		try {
			const { targetId, offer } = data;
			const user = state.getUserBySocket(socket.id);
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('webrtc-offer', {
				offer,
				userId: state.sockets.get(socket.id)
			});
		} catch (error) {
			console.error('❌ Erreur d\'envoi d\'offre WebRTC:', error);
			socket.emit('error', {
				type: 'WEBRTC_OFFER_ERROR',
				message: error.message
			});
		}
	});

	socket.on('webrtc-answer', (data) => {
		try {
			const { targetId, answer } = data;
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('webrtc-answer', {
				answer,
				userId: state.sockets.get(socket.id)
			});
		} catch (error) {
			console.error('❌ Erreur d\'envoi de réponse WebRTC:', error);
			socket.emit('error', {
				type: 'WEBRTC_ANSWER_ERROR',
				message: error.message
			});
		}
	});

	socket.on('ice-candidate', (data) => {
		try {
			const { targetId, candidate } = data;
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('ice-candidate', {
				candidate,
				userId: state.sockets.get(socket.id)
			});
		} catch (error) {
			console.error('❌ Erreur d\'envoi de candidat ICE:', error);
			socket.emit('error', {
				type: 'ICE_CANDIDATE_ERROR',
				message: error.message
			});
		}
	});

	// Gestion de fin d'appel
	socket.on('end-call', (data) => {
		try {
			const { targetId } = data;
			const user = state.getUserBySocket(socket.id);
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('call-ended', {
				userId: state.sockets.get(socket.id)
			});

			// Réinitialisation des états
			if (user) user.currentCallId = null;
			targetUser.currentCallId = null;
		} catch (error) {
			console.error('❌ Erreur de fin d\'appel:', error);
			socket.emit('error', {
				type: 'END_CALL_ERROR',
				message: error.message
			});
		}
	});

	// Gestion de la déconnexion
	socket.on('disconnect', () => {
		const userId = state.sockets.get(socket.id);
		if (userId) {
			const user = state.users.get(userId);
			if (user && user.userType === 'confident') {
				io.emit('confident-disconnected', {
					confidentId: userId
				});
			}
			state.removeUser(userId);
			console.log(`👋 Utilisateur déconnecté: ${userId}`);
		}
	});
});

// Gestion des erreurs globales
io.on('error', (error) => {
	console.error('🚨 Erreur Socket.IO:', error);
});

process.on('uncaughtException', (error) => {
	console.error('🚨 Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('🚨 Promesse rejetée non gérée:', reason);
});

// Démarrage du serveur
server.listen(PORT, () => {
	console.log(`
	🚀 Serveur de signaling démarré
	🌐 Port: ${PORT}
	📡 WebSocket prêt
	⚡ Mode: ${process.env.NODE_ENV || 'development'}
	`);
});

// Nettoyage à la fermeture
process.on('SIGTERM', () => {
	console.log('Signal SIGTERM reçu. Arrêt du serveur...');
	server.close(() => {
		console.log('Serveur arrêté');
		process.exit(0);
	});
});