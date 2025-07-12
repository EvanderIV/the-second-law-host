// --- WebSocket Server with Room Management (using Socket.IO) ---
// This script sets up a more advanced server using Express and Socket.IO.
// It allows a "host" to create a room, and "clients" to join that room.
// All gamestate and event messages are broadcast only to members of a specific room.

// --- Module Imports ---
const fs = "fs"; // Node.js file system module for reading certificate files.
const express = require("express"); // Web server framework.
const { createServer } = require("https"); // Node's native HTTPS server.
const { Server } = require("socket.io"); // The Socket.IO server library.

// --- Configuration ---
const PORT = process.env.PORT || 3002; // The port for the server to listen on.

// --- HTTPS Configuration ---
// IMPORTANT: You must provide your own SSL certificate files for HTTPS to work.
// These paths are placeholders. Update them to point to your actual certificate files.
// For local testing without a domain, you can generate self-signed certificates.
const options = {
  // key: fs.readFileSync('/path/to/your/privkey.pem'),
  // cert: fs.readFileSync('/path/to/your/fullchain.pem'),
};

// --- Server Setup ---
const app = express();
// Create an HTTPS server if certificate options are provided, otherwise fallback to HTTP.
// Note: The 'ws' library from the previous version is no longer needed.
const httpServer = createServer(options, app);

const io = new Server(httpServer, {
  // Socket.IO configuration options, mimicking the provided example.
  cors: {
    origin: "*", // For development, allow all origins. For production, restrict this to your domain.
    methods: ["GET", "POST"],
  },
  transports: ["websocket", "polling"], // Specify allowed transport methods.
});

// --- State Management ---
// A Map to store all active rooms.
// The key is the roomCode (string), and the value is an object containing room info.
const activeRooms = new Map();

// --- Socket.IO Connection Logic ---
io.on("connection", (client) => {
  console.log(`[Server] Client connected with ID: ${client.id}`);
  let currentRoomCode = null; // Store the room code for this specific client connection.

  // --- Host Events ---
  // Event for a host to create a new room.
  client.on("create-room", (data) => {
    const { roomCode } = data;
    if (!roomCode) {
      client.emit("error", {
        message: "roomCode is required to create a room.",
      });
      return;
    }

    if (activeRooms.has(roomCode)) {
      client.emit("error", {
        message: `Room with code '${roomCode}' already exists.`,
      });
      return;
    }

    // Create and store the new room information.
    activeRooms.set(roomCode, {
      hostId: client.id,
      clients: new Set(), // A set to store the socket IDs of clients in the room.
    });

    currentRoomCode = roomCode;
    client.join(roomCode); // Have the host's socket join the socket.io room.
    client.emit("roomCreated", { roomCode });
    console.log(
      `[Server] Host ${client.id} created and joined room: ${roomCode}`
    );
  });

  // --- Client Events ---
  // Event for a client to join an existing room.
  client.on("join-room", (data) => {
    const { roomCode } = data;
    if (!activeRooms.has(roomCode)) {
      client.emit("error", {
        message: `Room with code '${roomCode}' not found.`,
      });
      return;
    }

    const room = activeRooms.get(roomCode);
    currentRoomCode = roomCode;
    room.clients.add(client.id); // Add this client's ID to our room management set.
    client.join(roomCode); // Have the client's socket join the socket.io room.

    client.emit("joinSuccess", { roomCode });
    console.log(`[Server] Client ${client.id} joined room: ${roomCode}`);
  });

  // --- Game Data Broadcasting (from Host) ---
  // These are the original events, now adapted for the room system.
  // We expect these to be sent only by the host.
  const broadcastHandler = (eventName) => (payload) => {
    if (currentRoomCode) {
      const room = activeRooms.get(currentRoomCode);
      // Ensure the message is coming from the host of this room.
      if (room && room.hostId === client.id) {
        // Broadcast to all other clients in the room, excluding the sender (the host).
        client.to(currentRoomCode).emit(eventName, payload);
        console.log(
          `[Server] Host broadcasted '${eventName}' to room: ${currentRoomCode}`
        );
      }
    }
  };

  client.on("gamestateUpdate", broadcastHandler("gamestateUpdate"));
  client.on("event", broadcastHandler("event"));

  // --- Disconnection Logic ---
  client.on("disconnect", () => {
    console.log(`[Server] Client disconnected: ${client.id}`);
    if (currentRoomCode) {
      const room = activeRooms.get(currentRoomCode);
      if (!room) return;

      // Check if the disconnected client was the host.
      if (room.hostId === client.id) {
        // The host disconnected. Notify all clients in the room and delete the room.
        io.to(currentRoomCode).emit("roomClosed", {
          message: "The host has disconnected.",
        });
        activeRooms.delete(currentRoomCode);
        console.log(
          `[Server] Host disconnected. Room '${currentRoomCode}' closed.`
        );
      } else {
        // A regular client disconnected. Remove them from the set.
        room.clients.delete(client.id);
        console.log(
          `[Server] Client ${client.id} left room '${currentRoomCode}'.`
        );
      }
    }
  });
});

// --- Start Server ---
httpServer.listen(PORT, () => {
  console.log(`[Server] Server running on port ${PORT}`);
});
