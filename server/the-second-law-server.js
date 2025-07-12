// --- WebSocket Server for Gamestate Broadcasting ---
// This script sets up a simple WebSocket server using the 'ws' library.
// Its primary job is to listen for messages from a single host client
// and broadcast those messages to all other connected clients.

// Import the WebSocket library.
const WebSocket = require("ws");

// Define the port the server will listen on.
const PORT = 8080;

// Create a new WebSocket server instance.
const wss = new WebSocket.Server({ port: PORT });

console.log(`[Server] WebSocket server started on port ${PORT}`);

// The 'connection' event fires whenever a new client connects to the server.
// The 'ws' object represents the individual connection to that client.
wss.on("connection", (ws) => {
  console.log("[Server] A new client has connected.");

  // The 'message' event fires when the server receives data from this specific client.
  // 'message' is the data received, usually as a string or buffer.
  ws.on("message", (message) => {
    console.log("[Server] Received message =>", message.toString());

    // We will now broadcast this message to all connected clients.
    // wss.clients is a Set of all currently connected client sockets.
    wss.clients.forEach((client) => {
      // We check if the client's connection is still open before sending.
      if (client.readyState === WebSocket.OPEN) {
        // We send the exact message we received. The host client sends a
        // JSON string, and we forward that same string to the listening clients.
        client.send(message.toString());
      }
    });

    console.log(`[Server] Broadcasted message to ${wss.clients.size} clients.`);
  });

  // The 'close' event fires when a client's connection is terminated.
  ws.on("close", () => {
    console.log("[Server] A client has disconnected.");
  });

  // The 'error' event fires if an error occurs on the connection.
  ws.on("error", (error) => {
    console.error("[Server] WebSocket error observed:", error);
  });
});

// A global error handler for the server itself.
wss.on("error", (error) => {
  console.error("[Server] An error occurred with the WebSocket server:", error);
});
