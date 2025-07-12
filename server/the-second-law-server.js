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
      });
      return;
    }

    room.players.set(client.id, playerData);
    client.join(roomCode);
    client.emit("joinSuccess", {
      roomCode,
      hostSkin: room.hostSkin,
    });
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

const PORT = process.env.PORT || 3000;
https.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
