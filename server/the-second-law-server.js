const CERT_PATH =
  process.env.CERT_PATH || "/etc/letsencrypt/live/eminich.com/fullchain.pem";
const KEY_PATH =
  process.env.KEY_PATH || "/etc/letsencrypt/live/eminich.com/privkey.pem";
const fs = require("fs");
const options = {
  key: fs.readFileSync(KEY_PATH),
  cert: fs.readFileSync(CERT_PATH),
};

const express = require("express");
const app = express();
const https = require("https").createServer(options, app);

const io = require("socket.io")(https, {
  cors: {
    origin: "eminich.com",
    methods: ["GET", "POST"],
  },
  maxHttpBufferSize: 1e8,
  pingTimeout: 60000,
  pingInterval: 25000,
  transports: ["websocket", "polling"],
  allowEIO3: true,
});

// Store active rooms and their hosts
const activeRooms = new Map();

io.on("connection", (client) => {
  let roomCode = null;
  let lastPing = Date.now();
  let pingInterval;

  client.on("create-room", (data) => {
    roomCode = data.roomCode;
    console.log(`Creating room with code: ${roomCode}`);
    if (activeRooms.has(roomCode)) {
      client.emit("roomError", { message: "Room already exists" });
      return;
    }
    activeRooms.set(roomCode, {
      hostId: client.id,
      hostSkin: data.hostSkin,
      players: new Map(),
      gameState: {
        sector: null,
        location: null,
        weather: "default",
        timeOfDay: "default",
      },
    });
    client.join(roomCode);
    client.emit("roomCreated", { roomCode });
    console.log(`Host created room: ${roomCode}`);
  });

  client.on("join-room", (data) => {
    roomCode = data.roomCode;
    console.log(`Join room attempt: ${roomCode}`);
    const playerData = {
      name: data.name,
      skinId: data.skinId,
      ready: false,
    };

    if (!activeRooms.has(roomCode)) {
      client.emit("roomError", { message: "Room not found" });
      return;
    }

    const room = activeRooms.get(roomCode);
    if (room.players.size >= 4) {
      client.emit("roomError", { message: "Room is full" });
      return;
    }

    // Check if this client is already in the room
    if (room.players.has(client.id)) {
      console.log(`Client ${client.id} already in room ${roomCode}`);
      client.emit("joinSuccess", {
        roomCode,
        hostSkin: room.hostSkin,
        gameState: room.gameState,
      });
      return;
    }

    room.players.set(client.id, playerData);
    client.join(roomCode);

    // Send initial game state with join success
    const joinData = {
      roomCode,
      hostSkin: room.hostSkin,
      gameState: room.gameState,
    };
    console.log(`Sending join data with game state:`, joinData);
    client.emit("joinSuccess", joinData);

    // Also emit current game state separately to ensure it's received
    client.emit("gameState", room.gameState);
    io.to(room.hostId).emit("playerJoined", playerData);
    console.log(`Player ${data.name} joined room: ${roomCode}`);
  });

  client.on("ping", () => {
    client.emit("pong");
    lastPing = Date.now();
  });

  // Handle ready state changes
  client.on("ready-state-change", (data) => {
    if (!roomCode) return;

    const room = activeRooms.get(roomCode);
    if (!room) return;

    const playerData = room.players.get(client.id);
    if (!playerData) return;

    playerData.ready = data.ready;
    // Notify all clients about ready state change
    io.to(roomCode).emit("ready-state-update", {
      name: playerData.name,
      ready: data.ready,
    });
  });

  // Handle game start from host
  client.on("gameStart", () => {
    if (!roomCode) return;

    const room = activeRooms.get(roomCode);
    if (!room) return;

    // Only allow host to start the game
    if (client.id === room.hostId) {
      // Notify all clients in the room that the game is starting
      io.to(roomCode).emit("gameStarting");
      console.log(`Game starting in room: ${roomCode}`);
    }
  });

  // Handle player info updates (nickname and skin changes)
  client.on("updatePlayerInfo", (data) => {
    if (!roomCode) return;

    const room = activeRooms.get(roomCode);
    if (!room) return;

    const playerData = room.players.get(client.id);
    if (!playerData) return;

    const oldName = playerData.name;

    // Update player data in the room
    if (data.newNickname) {
      playerData.name = data.newNickname;
    }
    if (data.newSkin !== undefined) {
      playerData.skinId = data.newSkin;
    }

    console.log(`Player ${client.id} updated info:`, playerData);

    // Notify host about the changes
    io.to(room.hostId).emit("player-info-update", {
      oldName: oldName,
      newName: data.newNickname,
      newSkin: data.newSkin,
    });
  });

  // Handle game state updates
  client.on("gameState", (data) => {
    if (!roomCode) return;

    const room = activeRooms.get(roomCode);
    if (!room) return;

    // Only allow host to update game state
    if (client.id === room.hostId) {
      try {
        // Parse the game state if it's a string (JSON)
        const gameState = typeof data === "string" ? JSON.parse(data) : data;

        // Validate and ensure all required fields are present
        const validatedState = {
          sector: gameState.state.sector || null,
          location: gameState.state.location || null,
          weather: gameState.state.weather || "default",
          timeOfDay: gameState.state.timeOfDay || "default",
          actor: gameState.state.actor || null,
          action: gameState.state.action || "Interact",
        };

        // Update the room's game state
        room.gameState = validatedState;

        // Log the state being saved and broadcast
        console.log(`Updating game state in room ${roomCode}:`, validatedState);

        // Broadcast the new state to all clients in the room
        io.to(roomCode).emit("gameState", validatedState);
      } catch (error) {
        console.error("Error processing game state:", error);
        console.error("Received data:", data);
      }
    }
  });

  // Handle generic game events
  client.on("event", (eventData) => {
    if (!roomCode) return;

    const room = activeRooms.get(roomCode);
    if (!room) return;

    if (client.id === room.hostId) {
      // If host sends event, broadcast to all players in room
      io.to(roomCode).emit("event", eventData);
      console.log(`Host broadcasted event in room ${roomCode}:`, eventData);
    } else {
      // If player sends event, forward to host only
      io.to(room.hostId).emit("event", eventData);
      console.log(
        `Player ${client.id} sent event to host in room ${roomCode}:`,
        eventData
      );
    }
  });

  const handleDisconnect = () => {
    if (roomCode) {
      const room = activeRooms.get(roomCode);
      if (room) {
        if (client.id === room.hostId) {
          // Host disconnected, notify all players and close room
          io.to(roomCode).emit("roomClosed");
          activeRooms.delete(roomCode);
        } else {
          // Player disconnected, notify host
          const playerData = room.players.get(client.id);
          if (playerData) {
            io.to(room.hostId).emit("playerLeft", { name: playerData.name });
            room.players.delete(client.id);
          }
        }
        // Leave the room
        client.leave(roomCode);
      }
    }

    // Clean up ping interval
    if (pingInterval) {
      clearInterval(pingInterval);
    }
  };

  client.on("disconnect", handleDisconnect);
});

const PORT = process.env.PORT || 3002;
https.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
