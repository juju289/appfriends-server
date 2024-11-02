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
	pingTimeout: 120000,        // 2 minutes
	pingInterval: 10000,        // 10 secondes
	path: '/socket.io/',
	connectTimeout: 45000,
	upgradeTimeout: 30000,
	maxHttpBufferSize: 1e8,
	perMessageDeflate: false,
	closeOnBeforeunload: false
});

const PORT = process.env.PORT || 3000;

// Structure de données pour un utilisateur
class User {
	constructor(socketId, userType, name = '') {
		this.socketId = socketId;
		this.userType = userType;
		this.name = name;
		this.isAvailable = false;
		this.currentCallId = null;
		this.lastPing = Date.now();
		this.isInCall = false;
	}

	updateLastPing() {
		this.lastPing = Date.now();
	}

	isActive() {
		return Date.now() - this.lastPing < 180000; // 3 minutes
	}
}

// Gestionnaire global des états
class StateManager {
	constructor() {
		this.users = new Map();
		this.calls = new Map();
		this.sockets = new Map();
		this.pingIntervals = new Map();
	}

	addUser(userId, socketId, userType, name = '') {
		console.log(`📝 Ajout utilisateur - Type: ${userType}, ID: ${userId}`);
		const user = new User(socketId, userType, name);
		this.users.set(userId, user);
		this.sockets.set(socketId, userId);
		this.setupPingInterval(socketId, userId);
		return user;
	}

	removeUser(userId) {
		const user = this.users.get(userId);
		if (user) {
			this.clearPingInterval(user.socketId);
			this.sockets.delete(user.socketId);
			this.users.delete(userId);
			console.log(`🗑️ Utilisateur supprimé: ${userId}`);
		}
	}

	setupPingInterval(socketId, userId) {
		// Nettoyer l'ancien interval si existe
		this.clearPingInterval(socketId);
		
		// Créer un nouvel interval
		const interval = setInterval(() => {
			const user = this.users.get(userId);
			if (user && !user.isActive()) {
				console.log(`⚠️ Utilisateur inactif détecté: ${userId}`);
				// Ne pas déconnecter si en appel
				if (!user.isInCall) {
					this.removeUser(userId);
				}
			}
		}, 60000); // Vérification toutes les minutes

		this.pingIntervals.set(socketId, interval);
	}

	clearPingInterval(socketId) {
		const interval = this.pingIntervals.get(socketId);
		if (interval) {
			clearInterval(interval);
			this.pingIntervals.delete(socketId);
		}
	}

	getUserBySocket(socketId) {
		const userId = this.sockets.get(socketId);
		return userId ? this.users.get(userId) : null;
	}

	getAvailableConfidents() {
		console.log("🔍 Recherche des confidents disponibles...");
		const confidents = Array.from(this.users.entries())
			.filter(([_, user]) => user.userType === 'confident' && user.isAvailable && user.isActive())
			.map(([id, user]) => ({
				userId: id,
				name: user.name,
				isAvailable: true
			}));
		console.log(`👥 Confidents disponibles: ${confidents.length}`);
		return confidents;
	}

	startCall(userId1, userId2) {
		const user1 = this.users.get(userId1);
		const user2 = this.users.get(userId2);
		
		if (user1 && user2) {
			user1.isInCall = true;
			user2.isInCall = true;
			user1.currentCallId = userId2;
			user2.currentCallId = userId1;
		}
	}

	endCall(userId) {
		const user = this.users.get(userId);
		if (user && user.currentCallId) {
			const otherUser = this.users.get(user.currentCallId);
			if (otherUser) {
				otherUser.isInCall = false;
				otherUser.currentCallId = null;
			}
			user.isInCall = false;
			user.currentCallId = null;
		}
	}
}

const state = new StateManager();

// Configuration CORS
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

// Routes HTTP
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

	// Surveillance des paquets pour maintenir la connexion
	socket.conn.on('packet', (packet) => {
		if (packet.type === 'ping') {
			const user = state.getUserBySocket(socket.id);
			if (user) {
				user.updateLastPing();
			}
		}
	});

	// Gestion de l'enregistrement
	socket.on('register', (data) => {
		try {
			console.log('📝 Données d\'enregistrement reçues:', data);
			const { userId, userType, name = '' } = data;
			
			if (!userId || !userType) {
				throw new Error('Données d\'enregistrement invalides');
			}

			const user = state.addUser(userId, socket.id, userType, name);
			console.log(`✅ ${userType} enregistré:`, userId);

			socket.emit('registered', {
				success: true,
				userId: userId,
				userType: userType,
				isConfident: userType === 'confident'
			});

			if (userType === 'user') {
				socket.emit('available-confidents', {
					confidents: state.getAvailableConfidents()
				});
			}

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
			
			if (!user) {
				throw new Error('Utilisateur non trouvé');
			}

			if (user.userType !== 'confident') {
				throw new Error('Seuls les confidents peuvent modifier leur disponibilité');
			}

			user.isAvailable = available;
			const userId = state.sockets.get(socket.id);
			
			io.emit('confident-status-update', {
				confidentId: userId,
				isAvailable: available,
				name: user.name
			});

			socket.emit('availability-updated', {
				success: true,
				isAvailable: available
			});
		} catch (error) {
			console.error('❌ Erreur de mise à jour de disponibilité:', error);
			socket.emit('error', {
				type: 'AVAILABILITY_UPDATE_ERROR',
				message: error.message
			});
		}
	});

	// Gestion des offres WebRTC
	socket.on('webrtc-offer', (data) => {
		try {
			const { targetId, offer } = data;
			const fromUserId = state.sockets.get(socket.id);
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			// Marquer le début de l'appel
			state.startCall(fromUserId, targetId);

			io.to(targetUser.socketId).emit('webrtc-offer', {
				offer,
				userId: fromUserId
			});
		} catch (error) {
			console.error('❌ Erreur d\'envoi d\'offre WebRTC:', error);
			socket.emit('error', {
				type: 'WEBRTC_OFFER_ERROR',
				message: error.message
			});
		}
	});

	// Gestion des réponses WebRTC
	socket.on('webrtc-answer', (data) => {
		try {
			const { targetId, answer } = data;
			const fromUserId = state.sockets.get(socket.id);
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('webrtc-answer', {
				answer,
				userId: fromUserId
			});
		} catch (error) {
			console.error('❌ Erreur d\'envoi de réponse WebRTC:', error);
			socket.emit('error', {
				type: 'WEBRTC_ANSWER_ERROR',
				message: error.message
			});
		}
	});

	// Gestion des candidats ICE
	socket.on('ice-candidate', (data) => {
		try {
			const { targetId, candidate } = data;
			const fromUserId = state.sockets.get(socket.id);
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('ice-candidate', {
				candidate,
				userId: fromUserId
			});
		} catch (error) {
			console.error('❌ Erreur d\'envoi de candidat ICE:', error);
			socket.emit('error', {
				type: 'ICE_CANDIDATE_ERROR',
				message: error.message
			});
		}
	});

	// Gestion de la fin d'appel
	socket.on('end-call', (data) => {
		try {
			const { targetId } = data;
			const fromUserId = state.sockets.get(socket.id);
			const targetUser = state.users.get(targetId);

			if (!targetUser) {
				throw new Error('Utilisateur cible non trouvé');
			}

			io.to(targetUser.socketId).emit('call-ended', {
				userId: fromUserId
			});

			// Mettre fin à l'appel dans le state
			state.endCall(fromUserId);
			state.endCall(targetId);

		} catch (error) {
			console.error('❌ Erreur de fin d\'appel:', error);
			socket.emit('error', {
				type: 'END_CALL_ERROR',
				message: error.message
			});
		}
	});

	// Gestion de la déconnexion avec retry
	socket.on('disconnect', () => {
		const userId = state.sockets.get(socket.id);
		if (userId) {
			const user = state.users.get(userId);
			if (user) {
				// Si l'utilisateur est en appel, ne pas le supprimer immédiatement
				if (user.isInCall) {
					console.log(`⏳ Utilisateur en appel, maintien temporaire: ${userId}`);
					setTimeout(() => {
						// Vérifier à nouveau après délai
						const updatedUser = state.users.get(userId);
						if (updatedUser && !updatedUser.isActive() && !updatedUser.isInCall) {
							if (updatedUser.userType === 'confident') {
								io.emit('confident-disconnected', {
									confidentId: userId
								});
							}
							state.removeUser(userId);
						}
					}, 30000); // 30 secondes de délai
				} else {
					// Déconnexion normale
					if (user.userType === 'confident') {
						io.emit('confident-disconnected', {
							confidentId: userId
						});
					}
					state.removeUser(userId);
				}
			}
			console.log(`👋 Utilisateur déconnecté: ${userId}`);
		}
	});
});

// Gestion des erreurs
io.on('error', (error) => {
	console.error('🚨 Erreur Socket.IO:', error);
});

process.on('uncaughtException', (error) => {
	console.error('🚨 Erreur non gérée:', error);
});

process.on('unhandledRejection', (reason, promise) => {
	console.error('🚨 Promesse rejetée non gérée:', reason);
});

// Démarrage serveur
server.listen(PORT, () => {
	console.log(`
	🚀 Serveur de signaling démarré
	🌐 Port: ${PORT}
	📡 WebSocket prêt
	⚡ Mode: ${process.env.NODE_ENV || 'development'}
	`);
});

// Arrêt propre
process.on('SIGTERM', () => {
	console.log('Signal SIGTERM reçu. Arrêt du serveur...');
	server.close(() => {
		console.log('Serveur arrêté');
		process.exit(0);
	});
});