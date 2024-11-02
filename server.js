// Configuration du serveur Express et Socket.IO
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

// Structure de données pour un utilisateur
class User {
	constructor(socketId, userType, name = '') {
		this.socketId = socketId;     // ID unique de la connexion socket
		this.userType = userType;     // 'user' ou 'confident'
		this.name = name;             // Nom de l'utilisateur
		this.isAvailable = false;     // Par défaut, non disponible
		this.currentCallId = null;    // ID de l'appel en cours
	}
}

// Gestionnaire global des états
class StateManager {
	constructor() {
		this.users = new Map();       // Stockage des utilisateurs par ID
		this.calls = new Map();       // Stockage des appels actifs
		this.sockets = new Map();     // Liaison socket <-> userId
	}

	// Ajoute un nouvel utilisateur
	addUser(userId, socketId, userType, name = '') {
		console.log(`📝 Ajout utilisateur - Type: ${userType}, ID: ${userId}`);
		const user = new User(socketId, userType, name);
		this.users.set(userId, user);
		this.sockets.set(socketId, userId);
		return user;
	}

	// Supprime un utilisateur
	removeUser(userId) {
		const user = this.users.get(userId);
		if (user) {
			this.sockets.delete(user.socketId);
			this.users.delete(userId);
			console.log(`🗑️ Utilisateur supprimé: ${userId}`);
		}
	}

	// Récupère un utilisateur par son socketId
	getUserBySocket(socketId) {
		const userId = this.sockets.get(socketId);
		return userId ? this.users.get(userId) : null;
	}

	// Récupère la liste des confidents disponibles
	getAvailableConfidents() {
		console.log("🔍 Recherche des confidents disponibles...");
		const confidents = Array.from(this.users.entries())
			.filter(([_, user]) => user.userType === 'confident' && user.isAvailable)
			.map(([id, user]) => ({
				userId: id,
				name: user.name,
				isAvailable: true
			}));
		console.log(`👥 Confidents disponibles: ${confidents.length}`);
		return confidents;
	}
}

// Création de l'instance du gestionnaire d'état
const state = new StateManager();

// Configuration des middlewares CORS
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
// Routes HTTP de base
app.get('/', (req, res) => {
	res.send('Serveur de signaling WebRTC en fonctionnement');
});

// Route pour le statut du serveur
app.get('/status', (req, res) => {
	const status = {
		connectedUsers: state.users.size,
		availableConfidents: state.getAvailableConfidents().length,
		activeConnections: io.engine.clientsCount
	};
	res.json(status);
});

// Gestionnaire principal des connexions WebSocket
io.on('connection', (socket) => {
	console.log('🔌 Nouvelle connexion:', socket.id);

	// Gestion de l'enregistrement des utilisateurs
	socket.on('register', (data) => {
		try {
			console.log('📝 Données d\'enregistrement reçues:', data);
			const { userId, userType, name = '' } = data;
			
			if (!userId || !userType) {
				throw new Error('Données d\'enregistrement invalides');
			}

			const user = state.addUser(userId, socket.id, userType, name);
			console.log(`✅ ${userType} enregistré:`, userId);

			// Confirmation d'enregistrement
			socket.emit('registered', {
				success: true,
				userId: userId,
				userType: userType,
				isConfident: userType === 'confident'
			});

			// Envoi de la liste des confidents aux utilisateurs normaux
			if (userType === 'user') {
				socket.emit('available-confidents', {
					confidents: state.getAvailableConfidents()
				});
			}

			// Notification du statut des confidents
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

	// Gestion de la mise à jour de disponibilité
	socket.on('update-availability', (data) => {
		try {
			console.log('📝 Mise à jour disponibilité reçue:', data);
			const { available } = data;
			const user = state.getUserBySocket(socket.id);
			
			if (!user) {
				throw new Error('Utilisateur non trouvé');
			}

			if (user.userType !== 'confident') {
				throw new Error('Seuls les confidents peuvent modifier leur disponibilité');
			}

			user.isAvailable = available;
			
			// Notification globale du changement de statut
			const userId = state.sockets.get(socket.id);
			io.emit('confident-status-update', {
				confidentId: userId,
				isAvailable: available,
				name: user.name
			});

			// Confirmation à l'émetteur
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

	// Gestion des réponses WebRTC
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

	// Gestion des candidats ICE
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

	// Gestion de la fin d'appel
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

	// Gestion des déconnexions
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

// Gestion des erreurs Socket.IO
io.on('error', (error) => {
	console.error('🚨 Erreur Socket.IO:', error);
});

// Gestion des erreurs non attrapées
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

// Gestion de l'arrêt propre
process.on('SIGTERM', () => {
	console.log('Signal SIGTERM reçu. Arrêt du serveur...');
	server.close(() => {
		console.log('Serveur arrêté');
		process.exit(0);
	});
});