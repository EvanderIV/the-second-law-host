document.addEventListener("DOMContentLoaded", () => {
  const socket = new WebSocket("ws://localhost:3002");

  const DEFAULT_ZONE = "Commercial District";
  const DEFAULT_LOCATION = "Lablanc Coffee Shop";
  const DEFAULT_INTERACTION = "none";

  let gamestate = {
    zone: DEFAULT_ZONE,
    location: DEFAULT_LOCATION,
    interaction: DEFAULT_INTERACTION,
    timeOfDay: 0,
    weather: "sunny",
  };

  socket.onopen = () => {
    console.log("WebSocket connection established.");
    // Broadcast the initial state once connected.
    broadcastGamestate();
  };

  socket.onerror = (error) => {
    console.error("WebSocket Error: ", error);
    // Alert the user that the connection to the broadcast service failed.
    const errorDiv = document.getElementById("main-content");
    errorDiv.innerHTML =
      `<div style="background-color: #ffdddd; border-left: 6px solid #f44336; padding: 15px; margin: 20px 0;">
            <strong>Connection Failed!</strong> Could not connect to the WebSocket server. Ensure the server is running.
        </div>` + errorDiv.innerHTML;
  };

  fetch("script_data.json")
    .then((response) => {
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      return response.json();
    })
    .then((data) => {
      // Initialize the gamestate with the first available zone and location.
      if (data.zones && data.zones.length > 0) {
        const firstZone = data.zones[0];
        gamestate.zone = firstZone.name;
        if (firstZone.locations && firstZone.locations.length > 0) {
          gamestate.location = firstZone.locations[0].name;
        }
      }
      // Once data is loaded, render the entire UI.
      renderFullUI(data, DEFAULT_ZONE, DEFAULT_LOCATION, DEFAULT_INTERACTION);
    })
    .catch((error) => {
      console.error("Could not load script_data.json:", error);
      document.getElementById(
        "main-content"
      ).innerHTML = `<div style="background-color: #ffdddd; border-left: 6px solid #f44336; padding: 15px; margin: 20px 0;">
                <strong>Error!</strong> Failed to load <code>script_data.json</code>. Please ensure the file exists and is correctly formatted.
            </div>`;
    });

  function renderFullUI() {
    const mainContent = document.getElementById("main-content");
  }
});
