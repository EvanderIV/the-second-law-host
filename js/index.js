// --- Audio Context Setup ---
let audioContext;
let masterGainNode;

// Initialize audio context on user interaction
function initAudioContext() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
    masterGainNode = audioContext.createGain();
    masterGainNode.connect(audioContext.destination);
  }
  return audioContext.state === "suspended"
    ? audioContext.resume()
    : Promise.resolve();
}

// Audio buffer cache
const audioBufferCache = new Map();

// Fetch and cache audio buffer
async function getAudioBuffer(url) {
  if (audioBufferCache.has(url)) {
    return audioBufferCache.get(url);
  }

  try {
    const response = await fetch(url);
    const arrayBuffer = await response.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    audioBufferCache.set(url, audioBuffer);
    return audioBuffer;
  } catch (error) {
    console.error("Error loading audio file:", error);
    return null;
  }
}

// Track management
let currentTrack = null;
let nextTrackTimeout = null;
const LOOP_POINT = 104; // Loop point in seconds

class MusicTrack {
  constructor(buffer, gainNode, startTime, trackVolume) {
    this.buffer = buffer;
    this.gainNode = gainNode;
    this.startTime = startTime;
    this.trackVolume = trackVolume; // This might be equivalent to currentTrackNominalVolume at time of creation
    this.sources = new Set();
  }

  createSource() {
    const source = audioContext.createBufferSource();
    source.buffer = this.buffer;
    source.connect(this.gainNode);
    this.sources.add(source);

    source.addEventListener("ended", () => {
      this.sources.delete(source);
    });

    return source;
  }

  stop() {
    this.sources.forEach((source) => {
      try {
        source.stop();
      } catch (e) {
        // Ignore errors from already stopped sources
      }
    });
    this.sources.clear();
    if (this.gainNode) {
      this.gainNode.disconnect();
    }
  }
}

// --- Updated Audio Playback Functions ---
// Helper function to set cookies with 6-month expiration
function setCookie(name, value) {
  const sixMonths = new Date();
  sixMonths.setMonth(sixMonths.getMonth() + 6);
  document.cookie = `${name}=${value}; expires=${sixMonths.toUTCString()}; path=/`;
}

let SKIN_COUNT = 5;

var cookies = document.cookie
  .split(";")
  .map((cookie) => cookie.split("="))
  .reduce(
    (accumulator, [key, value]) => ({
      ...accumulator,
      [key.trim()]: decodeURIComponent(value),
    }),
    {}
  );

const sillyNames = [
  "SailingSquid",
  "Captain Jellyfish",
  "TidalTurtle",
  "WaveMaster",
  "BuoyBouncer",
  "Marine",
  "MarinerMango",
  "Ocean Otter",
  "Banana Boat",
  "ShipShape",
  "AnchorApple",
  "CompassCake",
  "DolphinDancer",
  "FishFinder",
  "iplayseaofthieves",
  "nacho avg sailor",
];

async function getEvents() {
  return fetch("../the-second-law-client/js/events.json")
    .then((response) => response.json())
    .then((data) => {
      for (let i = 0; i < data["events"].length; i++) {
        const event = data["events"][i];
        event.art = `assets/icons/events/${event.art}`;
        event.sound = `../the-second-law-client/assets/audio/${event.sound}`;

        let eventIcon = document.createElement("img");
        eventIcon.classList.add("event-icon");
        eventIcon.src = event.art;
        eventIcon.addEventListener("click", () => {
          if (typeof networkManager !== "undefined") {
            networkManager.sendEvent(event.name);
          } else {
            console.error("networkManager not available for sendEvent");
          }
        });
        document.getElementById("event-icons").appendChild(eventIcon);
      }
    })
    .catch((error) => {
      console.error("Error loading events:", error);
      return [];
    });
}
getEvents();

function getRandomSillyName() {
  const adjIndex = Math.floor(Math.random() * sillyNames.length);
  return `${sillyNames[adjIndex]}`;
}

// Audio settings
if (!document.cookie.includes("musicVolume")) {
  setCookie("musicVolume", "0.5");
}
if (!document.cookie.includes("sfxVolume")) {
  setCookie("sfxVolume", "0.5");
}
if (!document.cookie.includes("playJoinSounds")) {
  setCookie("playJoinSounds", "1");
}
let musicVolume = cookies.musicVolume ? parseFloat(cookies.musicVolume) : 0.5;
let sfxVolume = cookies.sfxVolume ? parseFloat(cookies.sfxVolume) : 0.5;
let playJoinSounds = cookies.playJoinSounds !== "0";

// --- Updated Audio Handling Logic Starts ---
async function playOneShot(url, volume) {
  if (!volume) return; // Don't play if volume is 0
  await initAudioContext();

  try {
    const buffer = await getAudioBuffer(url);
    if (!buffer) return;

    const source = audioContext.createBufferSource();
    const gainNode = audioContext.createGain();

    source.buffer = buffer;
    gainNode.gain.value = volume; // Volume is pre-calculated with sfxVolume at call site

    source.connect(gainNode);
    gainNode.connect(masterGainNode);

    source.start();

    source.onended = () => {
      gainNode.disconnect();
    };
  } catch (error) {
    console.error("Error playing sound effect:", error, { url });
  }
}

let backgroundMusic; // This variable seems unused.
let currentTrackNominalVolume = 0.5; // Represents the actual gain of the current track (musicVolume * currentTrackModifier)
let currentMusicUrl = "";
let currentTrackModifier = 1.0; // Stores the modifierVolume of the current track
let activeAudioInstances = new Set(); // Likely for HTML5 audio, background music uses Web Audio API.
let activeLoopTimeouts = []; // Stores IDs of pending setTimeout calls for loops

/**
 * Plays background music with precise looping at 104 seconds using Web Audio API.
 * @param {string} url - The URL of the audio file.
 * @param {number} modifierVolume - A volume modifier specific to this track.
 * @param {number} [globalVolume=musicVolume] - The base global music volume.
 */
async function playBackgroundMusic(
  url,
  modifierVolume,
  globalVolume = musicVolume,
  customLoopTime
) {
  await initAudioContext();

  const AUDIO_BUFFER_OFFSET = 0.0; // Offset to ensure smooth looping

  currentMusicUrl = url;
  currentTrackModifier = modifierVolume;
  // currentTrackNominalVolume stores the actual gain: base global volume * track-specific modifier
  currentTrackNominalVolume = globalVolume * modifierVolume;

  // Stop current track if exists
  if (currentTrack) {
    currentTrack.stop();
  }
  if (nextTrackTimeout) {
    clearTimeout(nextTrackTimeout);
    nextTrackTimeout = null;
  }

  // Create new gain node for this track
  const trackGainNode = audioContext.createGain();
  trackGainNode.connect(masterGainNode);
  trackGainNode.gain.value = currentTrackNominalVolume; // Set initial gain

  // Load and play the audio
  const buffer = await getAudioBuffer(url);
  if (!buffer) {
    console.error("Failed to load audio:", url);
    return;
  }

  function scheduleNextLoop(trackInstance) {
    // Renamed parameter for clarity
    const loopTime = customLoopTime || LOOP_POINT;
    const currentTime = audioContext.currentTime;
    const source = trackInstance.createSource(); // Use the passed trackInstance
    const startTime = currentTime;

    source.start(startTime);

    nextTrackTimeout = setTimeout(() => {
      // Ensure we are still on the same track URL and this specific track instance before re-scheduling
      if (currentTrack === trackInstance && currentMusicUrl === url) {
        scheduleNextLoop(trackInstance);
      }
    }, (loopTime - AUDIO_BUFFER_OFFSET - (audioContext.currentTime - startTime)) * 1000); // Adjust timeout based on actual start and loop duration
  }

  currentTrack = new MusicTrack(
    buffer,
    trackGainNode,
    audioContext.currentTime,
    currentTrackNominalVolume
  );
  scheduleNextLoop(currentTrack);
}

/**
 * Fades background music to a target volume over a specified duration using Web Audio API.
 * @param {number} targetAbsoluteVolume - The absolute target base volume (e.g., global musicVolume, 0.0 to 1.0).
 * @param {number} duration - The duration of the fade in milliseconds.
 */
function fadeBackgroundMusic(targetAbsoluteVolume, duration) {
  if (!audioContext || !currentTrack || !currentTrack.gainNode) {
    return;
  }

  const now = audioContext.currentTime;
  // Calculate the final target gain for the track's gain node
  const finalTrackVolume = targetAbsoluteVolume * currentTrackModifier;

  currentTrack.gainNode.gain.cancelScheduledValues(now);
  currentTrack.gainNode.gain.setValueAtTime(
    currentTrack.gainNode.gain.value,
    now
  ); // Start from current value
  currentTrack.gainNode.gain.linearRampToValueAtTime(
    finalTrackVolume,
    now + duration / 1000
  );

  // Update currentTrackNominalVolume to reflect the new actual gain of the track
  currentTrackNominalVolume = finalTrackVolume;
}
// --- Updated Audio Handling Logic Ends ---

let skin = 1;
if (document.cookie.includes("skin")) {
  skin = parseInt(cookies.skin) || 1; // Ensure skin is a number
  const skinIdElement = document.getElementById("skin-id");
  if (skinIdElement) skinIdElement.innerHTML = "Skin #" + skin;
  const boatUr = document.getElementById("boat_ur");
  const boatUl = document.getElementById("boat_ul");
  const boatLl = document.getElementById("boat_ll");
  const boatLr = document.getElementById("boat_lr");
  if (boatUr) boatUr.src = "./assets/boats/" + skin + "/ur.png";
  if (boatUl) boatUl.src = "./assets/boats/" + skin + "/ul.png";
  if (boatLl) boatLl.src = "./assets/boats/" + skin + "/ll.png";
  if (boatLr) boatLr.src = "./assets/boats/" + skin + "/lr.png";
}

let darkMode = false;
if (cookies.darkMode === "1") {
  darkMode = true; // Set global darkMode state
  let darkableElems = document.getElementsByClassName("darkable");
  for (let i = 0; i < darkableElems.length; i++) {
    darkableElems[i].classList.add("darkmode");
  }
  const darkModeToggle = document.getElementById("dark-mode-toggle");
  if (darkModeToggle) darkModeToggle.checked = true;
} else {
}

const gameCodeLength = 4;

window.mobileAndTabletCheck = function () {
  let check = false;
  (function (a) {
    if (
      /(android|bb\d+|meego).+mobile|avantgo|bada\/|blackberry|blazer|compal|elaine|fennec|hiptop|iemobile|ip(hone|od)|iris|kindle|lge |maemo|midp|mmp|mobile.+firefox|netfront|opera m(ob|in)i|palm( os)?|phone|p(ixi|re)\/|plucker|pocket|psp|series(4|6)0|symbian|treo|up\.(browser|link)|vodafone|wap|windows ce|xda|xiino|android|ipad|playbook|silk/i.test(
        a
      ) ||
      /1207|6310|6590|3gso|4thp|50[1-6]i|770s|802s|a wa|abac|ac(er|oo|s\-)|ai(ko|rn)|al(av|ca|co)|amoi|an(ex|ny|yw)|aptu|ar(ch|go)|as(te|us)|attw|au(di|\-m|r |s )|avan|be(ck|ll|nq)|bi(lb|rd)|bl(ac|az)|br(e|v)w|bumb|bw\-(n|u)|c55\/|capi|ccwa|cdm\-|cell|chtm|cldc|cmd\-|co(mp|nd)|craw|da(it|ll|ng)|dbte|dc\-s|devi|dica|dmob|do(c|p)o|ds(12|\-d)|el(49|ai)|em(l2|ul)|er(ic|k0)|esl8|ez([4-7]0|os|wa|ze)|fetc|fly(\-|_)|g1 u|g560|gene|gf\-5|g\-mo|go(\.w|od)|gr(ad|un)|haie|hcit|hd\-(m|p|t)|hei\-|hi(pt|ta)|hp( i|ip)|hs\-c|ht(c(\-| |_|a|g|p|s|t)|tp)|hu(aw|tc)|i\-(20|go|ma)|i230|iac( |\-|\/)|ibro|idea|ig01|ikom|im1k|inno|ipaq|iris|ja(t|v)a|jbro|jemu|jigs|kddi|keji|kgt( |\/)|klon|kpt |kwc\-|kyo(c|k)|le(no|xi)|lg( g|\/(k|l|u)|50|54|\-[a-w])|libw|lynx|m1\-w|m3ga|m50\/|ma(te|ui|xo)|mc(01|21|ca)|m\-cr|me(rc|ri)|mi(o8|oa|ts)|mmef|mo(01|02|bi|de|do|t(\-| |o|v)|zz)|mt(50|p1|v )|mwbp|mywa|n10[0-2]|n20[2-3]|n30(0|2)|n50(0|2|5)|n7(0(0|1)|10)|ne((c|m)\-|on|tf|wf|wg|wt)|nok(6|i)|nzph|o2im|op(ti|wv)|oran|owg1|p800|pan(a|d|t)|pdxg|pg(13|\-([1-8]|c))|phil|pire|pl(ay|uc)|pn\-2|po(ck|rt|se)|prox|psio|pt\-g|qa\-a|qc(07|12|21|32|60|\-[2-7]|i\-)|qtek|r380|r600|raks|rim9|ro(ve|zo)|s55\/|sa(ge|ma|mm|ms|ny|va)|sc(01|h\-|oo|p\-)|sdk\/|se(c(\-|0|1)|47|mc|nd|ri)|sgh\-|shar|sie(\-|m)|sk\-0|sl(45|id)|sm(al|ar|b3|it|t5)|so(ft|ny)|sp(01|h\-|v\-|v )|sy(01|mb)|t2(18|50)|t6(00|10|18)|ta(gt|lk)|tcl\-|tdg\-|tel(i|m)|tim\-|t\-mo|to(pl|sh)|ts(70|m\-|m3|m5)|tx\-9|up(\.b|g1|si)|utst|v400|v750|veri|vi(rg|te)|vk(40|5[0-3]|\-v)|vm40|voda|vulc|vx(52|53|60|61|70|80|81|83|85|98)|w3c(\-| )|webc|whit|wi(g |nc|nw)|wmlb|wonu|x700|yas\-|your|zeto|zte\-/i.test(
        a.substr(0, 4)
      )
    )
      check = true;
  })(navigator.userAgent || navigator.vendor || window.opera);
  return check;
};

let isMobileUser = window.mobileAndTabletCheck();

if (isMobileUser) {
  let desktopElems = document.getElementsByClassName("desktop-only");
  for (let i = 0; i < desktopElems.length; i++) {
    desktopElems[i].classList.add("hidden");
  }
  const sqrElement = document.getElementById("sqr");
  if (sqrElement) sqrElement.classList.add("ship-display");
} else {
  let mobileElems = document.getElementsByClassName("mobile-only");
  for (let i = 0; i < mobileElems.length; i++) {
    mobileElems[i].classList.add("hidden");
  }
  const sqrElement = document.getElementById("sqr");
  if (sqrElement) sqrElement.classList.add("grid");
  const rootElement = document.getElementById("root");
  if (rootElement) {
    rootElement.classList.add("flex-center");
    rootElement.classList.remove("column");
  }
}

// Global player management
let players = [];
let isHost = false;

function addPlayer(name, skinId, isHostPlayer = false) {
  if (isHostPlayer) {
    isHost = true;
    return;
  }
  players.push({ name, skinId, ready: false });
  updatePlayerList();
}

function updatePlayerList() {
  const playerList = document.getElementById("player-list");
  if (!playerList) return;

  playerList.innerHTML = "";

  const header = document.createElement("h2");
  header.textContent = `Players (${players.length})`;
  playerList.appendChild(header);

  players.forEach((player) => {
    const playerItem = document.createElement("div");
    playerItem.className = "player-item";
    playerItem.dataset.name = player.name;

    const boatImg = document.createElement("img");
    boatImg.src = `./assets/boats/${player.skinId}/icon.png`;

    const playerName = document.createElement("span");
    playerName.textContent = player.name;

    const readyCheckbox = document.createElement("div");
    readyCheckbox.className =
      "ready-checkbox " + (player.ready ? "checked" : "");
    readyCheckbox.innerHTML = player.ready ? "&check;" : "";

    playerItem.appendChild(boatImg);
    playerItem.appendChild(playerName);
    playerItem.appendChild(readyCheckbox);
    playerList.appendChild(playerItem);
  });
}

function addPlayerToList(name, skinId, ready = false) {
  const playerList = document.getElementById("player-list");
  if (!playerList) return;

  players.push({ name, skinId, ready });
  updatePlayerList();

  const playerItem = playerList.querySelector(`[data-name="${name}"]`);
  if (playerItem) {
    playerItem.classList.add("highlight");
    setTimeout(() => playerItem.classList.remove("highlight"), 2000);
  }

  if (playJoinSounds) {
    playOneShot(getRandomJoinSound(), 0.3 * sfxVolume);
  }
}

function removePlayerFromList(name) {
  const playerList = document.getElementById("player-list");
  if (!playerList) return;

  players = players.filter((p) => p.name !== name);
  updatePlayerList();

  if (playJoinSounds) {
    playOneShot("./assets/audio/player_leave.mp3", 0.1 * sfxVolume);
  }
}

if (typeof networkManager !== "undefined") {
  networkManager.setCallbacks({
    onPlayerJoined: (name, skinId, ready) => {
      addPlayerToList(name, skinId, ready);
      updatePlayerCount();
    },
    onPlayerLeft: (name) => {
      removePlayerFromList(name);
      updatePlayerCount();
      if (countdownTimer) {
        cancelCountdown();
      }
    },
    onReadyStateUpdate: (name, ready) => {
      const player = players.find((p) => p.name === name);
      if (player) {
        player.ready = ready;
        updatePlayerList();
        if (isHost) {
          if (checkAllPlayersReady() && players.length > 1) {
            // Ensure there's more than just the host
            startCountdown();
          } else if (!ready) {
            cancelCountdown();
          }
        }
      }
    },
    onPlayerInfoUpdate: (oldName, newName, newSkinId) => {
      const player = players.find((p) => p.name === oldName);
      if (player) {
        const playerItem = document.querySelector(`[data-name="${oldName}"]`);
        if (playerItem) {
          if (newName) {
            player.name = newName;
            playerItem.dataset.name = newName;
            const nameSpan = playerItem.querySelector("span");
            if (nameSpan) nameSpan.classList.add("nickname-changed");
            setTimeout(() => {
              if (nameSpan) nameSpan.classList.remove("nickname-changed");
            }, 2000);
          }
          if (newSkinId !== undefined && newSkinId !== player.skinId) {
            player.skinId = newSkinId;
            const boatImg = playerItem.querySelector("img");
            if (boatImg) {
              boatImg.src = `./assets/boats/${newSkinId}/icon.png`;
              boatImg.classList.add("skin-changed");
              setTimeout(() => boatImg.classList.remove("skin-changed"), 2000);
            }
          }
        }
        updatePlayerList();
      }
    },
    onGameStarting: () => {
      startGame();
    },
    onRoomClosed: () => {
      // New handler for host disconnection
      resetGameState();
    },
  });
} else {
  console.warn("networkManager is not defined. Callbacks not set.");
}

if (!isMobileUser) {
  const settingsModal = document.getElementById("settings-modal");
  const settingsBtnDesktop = document.getElementById("settings-btn-desktop");
  const closeSettingsBtn = document.getElementById("close-settings"); // Renamed for clarity
  const tabButtons = document.querySelectorAll(".tab-button");
  const tabPanels = document.querySelectorAll(".tab-panel");
  const createLobbyBtn = document.getElementById("create-lobby");
  const lobbyOverlay = document.getElementById("lobby-overlay");
  const roomCodeDisplay = document.getElementById("room-code");

  function openSettings() {
    if (settingsModal) settingsModal.style.display = "block";
  }

  function closeSettingsModal() {
    if (settingsModal) settingsModal.style.display = "none";
  }

  if (tabButtons.length > 0 && tabPanels.length > 0) {
    tabButtons.forEach((button) => {
      button.addEventListener("click", () => {
        tabButtons.forEach((btn) => btn.classList.remove("active"));
        tabPanels.forEach((panel) => panel.classList.remove("active"));
        button.classList.add("active");
        const tabName = button.getAttribute("data-tab");
        const targetPanel = document.getElementById(tabName + "-tab");
        if (targetPanel) targetPanel.classList.add("active");
      });
    });
  }

  if (document.getElementById("player-list")) {
    updatePlayerList();
  }

  if (createLobbyBtn) {
    createLobbyBtn.addEventListener("click", () => {
      const code = generateRoomCode();
      if (roomCodeDisplay) roomCodeDisplay.textContent = "Room Code: " + code;
      if (lobbyOverlay) lobbyOverlay.style.display = "none";
      if (typeof networkManager !== "undefined") {
        networkManager.createRoom(code, skin);
      } else {
        console.error("networkManager not available for createRoom");
      }
      addPlayer("You (Host)", skin, true);
    });
  }

  if (settingsBtnDesktop)
    settingsBtnDesktop.addEventListener("click", openSettings);
  if (closeSettingsBtn)
    closeSettingsBtn.addEventListener("click", closeSettingsModal);

  window.addEventListener("click", (event) => {
    if (settingsModal && event.target === settingsModal) {
      closeSettingsModal();
    }
  });

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      if (settingsModal && settingsModal.style.display === "block") {
        closeSettingsModal();
      } else if (!isMobileUser && settingsBtnDesktop) {
        openSettings();
      }
    }
  });
}

function getRandomJoinSound() {
  const joinSounds = [
    "./assets/audio/player_join_1.mp3",
    "./assets/audio/player_join_2.mp3",
    "./assets/audio/player_join_3.mp3",
  ];
  return joinSounds[Math.floor(Math.random() * joinSounds.length)];
}

let lastCountdownSound = "";
function getRandomCountdownSound() {
  const countdownSounds = [
    "./assets/audio/game_countdown_1.mp3",
    "./assets/audio/game_countdown_2.mp3",
    "./assets/audio/game_countdown_3.mp3",
    "./assets/audio/game_countdown_4.mp3",
    "./assets/audio/game_countdown_5.mp3",
  ];
  let availableSounds = countdownSounds.filter(
    (sound) => sound !== lastCountdownSound
  );
  if (availableSounds.length === 0) availableSounds = countdownSounds;
  const selectedSound =
    availableSounds[Math.floor(Math.random() * availableSounds.length)];
  lastCountdownSound = selectedSound;
  return selectedSound;
}

function getRandomStartSound() {
  const startSounds = [
    // Corrected variable name
    "./assets/audio/game_start_1.mp3",
    "./assets/audio/game_start_2.mp3",
    "./assets/audio/game_start_3.mp3",
  ];
  return startSounds[Math.floor(Math.random() * startSounds.length)];
}

function generateRoomCode() {
  const letters = "ABCDEFGHJKLMNPQRSTUWXYZ";
  const badWords = [
    "FUCK",
    "FVCK",
    "SHIT",
    "DAMN",
    "CUNT",
    "DICK",
    "COCK",
    "TWAT",
    "CRAP",
    "STFU",
  ];
  while (true) {
    let code = "";
    for (let i = 0; i < 4; i++) {
      code += letters.charAt(Math.floor(Math.random() * letters.length));
    }
    if (!badWords.some((word) => code.includes(word))) return code;
  }
}

const gameCodeInput = document.getElementById("game-code");
if (gameCodeInput) {
  gameCodeInput.addEventListener("input", function (event) {
    const joinBtn = document.getElementById("join-button"); // Renamed for clarity
    if (joinBtn) {
      joinBtn.disabled = event.target.value.length !== gameCodeLength;
    }
  });
}

let settingsOpen = false;
let settingsDiv = document.getElementById("settings-div");
let settingsBtn = document.getElementById("settings-button");
let touchStartY = 0;
let touchEndY = 0;
const minSwipeDistance = 50;
let settingsOpenSFX = document.getElementById("settings-open-sfx");
let settingsCloseSFX = document.getElementById("settings-close-sfx");

function toggleSettings(open) {
  if (settingsBtn && settingsDiv) {
    if (open && !settingsOpen) {
      if (settingsOpenSFX && settingsOpenSFX.play) settingsOpenSFX.play();
      settingsBtn.style.top = "75%";
      settingsDiv.style.top = "85%";
      settingsOpen = true;
    } else if (!open && settingsOpen) {
      if (settingsCloseSFX && settingsCloseSFX.play) settingsCloseSFX.play();
      settingsBtn.style.top = "90%";
      settingsDiv.style.top = "100%";
      settingsOpen = false;
    }
  }
}

function handleTouchStart(event) {
  touchStartY = event.touches[0].clientY;
}
function handleTouchEnd(event) {
  touchEndY = event.changedTouches[0].clientY;
  const swipeDistance = touchEndY - touchStartY;
  if (Math.abs(swipeDistance) >= minSwipeDistance) {
    if (swipeDistance > 0 && settingsOpen) toggleSettings(false);
    else if (swipeDistance < 0 && !settingsOpen) toggleSettings(true);
  }
}

if (settingsBtn) {
  settingsBtn.addEventListener("touchstart", handleTouchStart);
  settingsBtn.addEventListener("touchend", handleTouchEnd);
  settingsBtn.addEventListener("click", () => toggleSettings(!settingsOpen));
}
if (settingsDiv) {
  settingsDiv.addEventListener("touchstart", handleTouchStart);
  settingsDiv.addEventListener("touchend", handleTouchEnd);
}

let darkModeSwitch = document.getElementById("dark-mode-toggle");
if (darkModeSwitch) {
  darkModeSwitch.addEventListener("change", function (event) {
    toggleDarkMode(event.target.checked);
    const desktopSwitch = document.getElementById("dark-mode-toggle-desktop");
    if (desktopSwitch) desktopSwitch.checked = event.target.checked;
  });
}

let currentPlayerName = cookies.nickname || getRandomSillyName();

let nextSkinBtn = document.getElementById("skin-next"); // Renamed for clarity
if (nextSkinBtn) {
  nextSkinBtn.addEventListener("click", function (event) {
    if (isReady) {
      event.preventDefault();
      return;
    }
    skin++;
    if (skin > SKIN_COUNT) skin = 1; // Use > SKIN_COUNT for wrap around
    setCookie("skin", skin.toString());
    const skinIdEl = document.getElementById("skin-id");
    if (skinIdEl) skinIdEl.innerHTML = "Skin #" + skin;

    ["ur", "ul", "ll", "lr"].forEach((suffix) => {
      const boatImg = document.getElementById(`boat_${suffix}`);
      if (boatImg) boatImg.src = `./assets/boats/${skin}/${suffix}.png`;
    });

    if (typeof networkManager !== "undefined") {
      networkManager.updatePlayerInfo({
        oldName: currentPlayerName,
        newSkin: skin,
      });
    }
  });
}

let backSkinBtn = document.getElementById("skin-back"); // Renamed for clarity
if (backSkinBtn) {
  backSkinBtn.addEventListener("click", function (event) {
    if (isReady) {
      event.preventDefault();
      return;
    }
    skin--;
    if (skin < 1) skin = SKIN_COUNT;
    setCookie("skin", skin.toString());
    const skinIdEl = document.getElementById("skin-id");
    if (skinIdEl) skinIdEl.innerHTML = "Skin #" + skin;

    ["ur", "ul", "ll", "lr"].forEach((suffix) => {
      const boatImg = document.getElementById(`boat_${suffix}`);
      if (boatImg) boatImg.src = `./assets/boats/${skin}/${suffix}.png`;
    });

    if (typeof networkManager !== "undefined") {
      networkManager.updatePlayerInfo({
        oldName: currentPlayerName,
        newSkin: skin,
      });
    }
  });
}

let nicknameInput = document.getElementById("nickname");
if (nicknameInput) {
  nicknameInput.value = currentPlayerName; // Set from already initialized currentPlayerName
  nicknameInput.addEventListener("input", function (event) {
    const newNickname = event.target.value.trim();
    if (newNickname && newNickname !== currentPlayerName) {
      // Only update if changed
      const oldNickname = currentPlayerName;
      currentPlayerName = newNickname;
      setCookie("nickname", newNickname);
      if (typeof networkManager !== "undefined") {
        networkManager.updatePlayerInfo({
          oldName: oldNickname,
          newNickname: newNickname,
        });
      }
    }
  });
}

const joinButton = document.getElementById("join-button");
if (gameCodeInput && joinButton) {
  gameCodeInput.addEventListener("input", function (event) {
    const value = event.target.value.toUpperCase();
    event.target.value = value; // Force uppercase
    joinButton.disabled = value.length !== gameCodeLength;
  });

  joinButton.addEventListener("click", function () {
    const roomCode = gameCodeInput.value; // Already uppercase
    if (roomCode.length === gameCodeLength) {
      const nickname = nicknameInput
        ? nicknameInput.value.trim()
        : getRandomSillyName();
      if (!nickname) {
        // If nickname became empty after trim
        currentPlayerName = getRandomSillyName();
        if (nicknameInput) nicknameInput.value = currentPlayerName;
      } else {
        currentPlayerName = nickname;
      }
      if (typeof networkManager !== "undefined") {
        networkManager.joinRoom(roomCode, currentPlayerName, skin);
      } else {
        console.error("networkManager not available for joinRoom");
      }
    }
  });
}

if (!document.getElementById("error-message")) {
  const errorDiv = document.createElement("div");
  errorDiv.id = "error-message";
  errorDiv.style.cssText =
    "display: none; color: red; position: fixed; top: 20%; left: 50%; transform: translateX(-50%); z-index: 1000; background-color: #ffdddd; padding: 10px; border-radius: 5px; border: 1px solid red;";
  document.body.appendChild(errorDiv);
}

if (!isMobileUser) {
  const musicVolumeSlider = document.getElementById("music-volume");
  const sfxVolumeSlider = document.getElementById("sfx-volume");
  const playJoinSoundsToggle = document.getElementById("play-join-sounds");

  if (musicVolumeSlider) {
    musicVolumeSlider.value = musicVolume * 100; // Initialize slider position
    musicVolumeSlider.addEventListener("input", (e) => {
      const newMusicVolume = parseFloat(e.target.value) / 100; // Get new base volume from slider
      musicVolume = newMusicVolume; // Update the global musicVolume variable
      setCookie("musicVolume", musicVolume.toString()); // Save to cookie

      // If there's a current track and audio context, fade its volume.
      // fadeBackgroundMusic will use the new global musicVolume and the track's
      // currentTrackModifier to set the correct gain. It also updates
      // currentTrackNominalVolume internally.
      if (currentTrack && audioContext) {
        fadeBackgroundMusic(newMusicVolume, 50); // Fade to newMusicVolume over 50ms (short for responsiveness)
      }
    });
  }

  if (sfxVolumeSlider) {
    sfxVolumeSlider.value = sfxVolume * 100;
    sfxVolumeSlider.addEventListener("input", (e) => {
      sfxVolume = parseFloat(e.target.value) / 100; // Ensure float
      setCookie("sfxVolume", sfxVolume.toString());
      // No direct action needed on current SFX; new sfxVolume applies to future playOneShot calls.
    });
  }

  if (playJoinSoundsToggle) {
    playJoinSoundsToggle.checked = playJoinSounds;
    playJoinSoundsToggle.addEventListener("change", (e) => {
      playJoinSounds = e.target.checked;
      setCookie("playJoinSounds", playJoinSounds ? "1" : "0");
    });
  }
}

let isReady = false;
const readyButton = document.getElementById("ready-button");
const skinBackArrow = document.getElementById("skin-back"); // Use consistent naming with other btn vars
const skinNextArrow = document.getElementById("skin-next");

let darkModeSwitchDesktop = document.getElementById("dark-mode-toggle-desktop");

function toggleDarkMode(isDark) {
  darkMode = isDark;
  let darkableElems = document.getElementsByClassName("darkable");
  for (let i = 0; i < darkableElems.length; i++) {
    if (isDark) darkableElems[i].classList.add("darkmode");
    else darkableElems[i].classList.remove("darkmode");
  }
  setCookie("darkMode", isDark ? "1" : "0");
}

if (darkModeSwitchDesktop) {
  if (cookies.darkMode === "1") {
    darkModeSwitchDesktop.checked = true;
    if (!darkMode) toggleDarkMode(true); // Ensure state is applied if not already
  }
  darkModeSwitchDesktop.addEventListener("change", function (event) {
    toggleDarkMode(event.target.checked);
    if (darkModeSwitch) darkModeSwitch.checked = event.target.checked;
  });
}
// Apply initial dark mode if only mobile switch exists and cookie is set
if (
  cookies.darkMode === "1" &&
  !darkModeSwitchDesktop &&
  darkModeSwitch &&
  !darkModeSwitch.checked
) {
  darkModeSwitch.checked = true;
  toggleDarkMode(true);
}

const suitSquares = document.querySelectorAll(".suit-square");
const boatSections = document.querySelectorAll(".playerBoat");
const placedSuits = new Map();
let isDragging = false;
let currentSquare = null;
let offsetX = 0,
  offsetY = 0;
let originalPosition = null;

let countdownTimer = null;
let gameStarting = false;
const countdownDisplay = document.createElement("div");
countdownDisplay.id = "countdown-display";
countdownDisplay.style.cssText =
  "display: none; position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%); font-size: 48px; font-weight: bold; color: #fff; text-shadow: 2px 2px 4px rgba(0,0,0,0.5); z-index: 1000;";
document.body.appendChild(countdownDisplay);

function startCountdown() {
  if (countdownTimer || gameStarting) return;
  let countdown = 3;
  countdownDisplay.style.display = "block";
  gameStarting = true;
  fadeBackgroundMusic(0, 3000); // Fade to zero (base volume 0) over the countdown duration

  function updateCountdown() {
    if (countdown > 0) {
      countdownDisplay.textContent = countdown;
      playOneShot(getRandomCountdownSound(), 0.1 * sfxVolume);
      countdown--;
      countdownTimer = setTimeout(updateCountdown, 1000);
    } else {
      countdownDisplay.textContent = "GO!";
      playOneShot(getRandomStartSound(), 0.07 * sfxVolume);

      if (isHost && typeof networkManager !== "undefined") {
        const socket = networkManager.getSocket();
        if (socket && socket.connected) {
          socket.emit("gameStart");
        } else {
          console.warn("Socket not connected for game start");
          startGame();
        }
      } else if (!isHost) {
        // Clients will wait for onGameStarting event, but for local/testing:
        // startGame();
      } else {
        // Host but no networkManager (offline testing)
        startGame();
      }

      setTimeout(() => {
        countdownDisplay.style.display = "none";
        // startGame() is called by onGameStarting event from server for host too,
        // or directly if no network.
      }, 1000);
      countdownTimer = null;
    }
  }
  updateCountdown();
}

function cancelCountdown() {
  if (countdownTimer) {
    clearTimeout(countdownTimer);
    countdownTimer = null;
  }
  gameStarting = false;
  countdownDisplay.style.display = "none";
  // Restore to global musicVolume (fadeBackgroundMusic will apply track modifier)
  fadeBackgroundMusic(musicVolume, 2000);
}

function checkAllPlayersReady() {
  if (players.length === 0 && isHost) return false; // Host alone cannot start
  if (players.length > 0) {
    // For host, this means at least one other player
    return players.every((player) => player.ready);
  }
  // If not host and no players array (e.g. client only connected to server), rely on server.
  // For UI purposes if players array is maintained on client:
  return players.length > 1 && players.every((player) => player.ready);
}

function resetGameState() {
  isReady = false;
  players = [];
  updatePlayerList(); // Visually clear player list
  //updatePlayerCount(); // Update count display

  if (countdownTimer) {
    cancelCountdown();
  }
  gameStarting = false;

  document.querySelectorAll(".suit-square").forEach((square) => {
    square.style.pointerEvents = "auto";
    square.style.opacity = "1";
    // Potentially reset positions of placed suits if they should return to a holding area
    // resetSquarePosition(square, findOriginalPositionDataFor(square)); // Example
  });
  placedSuits.clear(); // Clear map of placed suits

  // Restore lobby music or default state music if applicable
  // For simplicity, stopping current and letting user/host re-initiate
  if (currentTrack) {
    currentTrack.stop();
    currentTrack = null;
  }
  // Example: playBackgroundMusic('./assets/audio/lobby_music.mp3', 0.4, musicVolume, 104);
  // This should probably be triggered by returning to lobby UI state explicitly.

  const nicknameInputElem = document.getElementById("nickname"); // Renamed to avoid conflict
  if (nicknameInputElem) {
    nicknameInputElem.disabled = false;
    nicknameInputElem.style.display = "";
  }
  const readyWrapper = document.getElementById("ready-wrapper");
  const settingsButton = document.getElementById("settings-button");
  const settingsDivElem = document.getElementById("settings-div"); // Renamed
  const lobbyOverlay = document.getElementById("lobby-overlay");

  if (settingsButton) settingsButton.style.display = "";
  if (settingsDivElem) settingsDivElem.style.display = "";
  if (readyWrapper) readyWrapper.style.display = "";
  if (lobbyOverlay && isHost) lobbyOverlay.style.display = "block";
  // Show lobby creation if host disconnected.
  else if (lobbyOverlay && !isHost) {
    /* Client logic for returning to join screen */
  }

  // Reset ready button visuals
  if (readyButton) {
    readyButton.style.backgroundColor = "#AA4444";
    readyButton.classList.add("not-ready");
    readyButton.setAttribute(
      "aria-label",
      "Place all ship sections to ready up"
    );
    readyButton.setAttribute("aria-disabled", "true"); // Assuming suits need to be placed again
    if (skinBackArrow) skinBackArrow.classList.remove("disabled");
    if (skinNextArrow) skinNextArrow.classList.remove("disabled");
  }

  console.log("Game state reset (host disconnected?).");
}

// Game state management
const gameState = {
  sector: null,
  location: null,
  weather: "default",
  timeOfDay: "default",
};

// Load and handle world data
async function loadWorldData() {
  try {
    const response = await fetch("../the-second-law-client/js/world.json");
    const worldData = await response.json();

    const sectorSelect = document.getElementById("sector-select");
    const locationsList = document.getElementById("locations");
    const stateControls = document.getElementById("location-selector");

    // Add environment controls if they don't exist
    if (!document.getElementById("game-state-controls") && stateControls) {
      const controlsDiv = document.createElement("div");
      controlsDiv.id = "game-state-controls";
      controlsDiv.innerHTML = `
        <h3>Environment Controls</h3>
        <div class="control-group">
          <label for="weather-select">Weather:</label>
          <select id="weather-select" class="darkable themeable">
            <option value="default">Default</option>
            <option value="clear">Clear</option>
            <option value="rain">Rain</option>
            <option value="storm">Storm</option>
            <option value="fog">Fog</option>
          </select>
        </div>
        <div class="control-group">
          <label for="time-select">Time of Day:</label>
          <select id="time-select" class="darkable themeable">
            <option value="default">Default</option>
            <option value="dawn">Dawn</option>
            <option value="day">Day</option>
            <option value="dusk">Dusk</option>
            <option value="night">Night</option>
          </select>
        </div>
      `;
      stateControls.appendChild(controlsDiv);

      // Add event listeners for environment controls
      const weatherSelect = document.getElementById("weather-select");
      const timeSelect = document.getElementById("time-select");

      if (weatherSelect) {
        weatherSelect.addEventListener("change", (e) => {
          gameState.weather = e.target.value;
          sendGameState();
        });
      }

      if (timeSelect) {
        timeSelect.addEventListener("change", (e) => {
          gameState.timeOfDay = e.target.value;
          sendGameState();
        });
      }
    }

    // Populate sectors dropdown
    worldData.sectors.forEach((sector) => {
      const option = document.createElement("option");
      option.value = sector.name;
      option.textContent = sector.name;
      sectorSelect.appendChild(option);
    });

    // Handle sector selection
    sectorSelect.addEventListener("change", (e) => {
      locationsList.innerHTML = ""; // Clear current locations
      const selectedSector = worldData.sectors.find(
        (s) => s.name === e.target.value
      );

      if (selectedSector) {
        gameState.sector = selectedSector.name;
        gameState.location = null;
        sendGameState();

        selectedSector.locations.forEach((location) => {
          const li = document.createElement("li");
          li.textContent = location.name;
          li.title = location.description;
          li.addEventListener("click", () => {
            gameState.location = location.name;
            sendGameState();
          });
          locationsList.appendChild(li);
        });
      }
    });
  } catch (error) {
    console.error("Error loading world data:", error);
  }
}

function sendGameState() {
  if (window.networkManager) {
    window.networkManager.sendGameState(
      JSON.stringify({
        type: "gameState",
        state: {
          sector: gameState.sector,
          location: gameState.location,
          weather: gameState.weather,
          timeOfDay: gameState.timeOfDay,
        },
      })
    );
  }
}

document.addEventListener("DOMContentLoaded", () => {
  // Load world data when the page loads
  loadWorldData();
});

function updatePlayerCount() {
  const playerList = document.getElementById("player-list");
  const playerCountDisplay = document.getElementById("player-count");
  const header = playerList?.querySelector("h2");

  if (!playerList) return;

  const count = players.length;

  if (playerCountDisplay) {
    playerCountDisplay.textContent = `Players: ${count}`;
  }

  if (header) {
    header.textContent = `Players (${count})`;
  }
}

// Add card dealing to game start
function startGame() {
  gameStarting = false; // Ensure this is reset

  // Stop current lobby music if playing
  if (currentTrack) {
    currentTrack.stop();
    currentTrack = null; // Clear current track
  }

  if (isMobileUser && !isHost) {
    const nicknameInput = document.getElementById("nickname");
    const readyWrapper = document.getElementById("ready-wrapper");
    const suitSquares = document.getElementById("suit-squares");
    const settingsButton = document.getElementById("settings-button");
    const settingsDiv = document.getElementById("settings-div");

    if (nicknameInput) nicknameInput.style.display = "none";
    if (readyWrapper) readyWrapper.style.display = "none";
    if (suitSquares) suitSquares.style.display = "none";
    if (settingsButton) settingsButton.style.display = "none";
    if (settingsDiv) settingsDiv.style.display = "none";
  } else {
    // For host and desktop clients, or if it's a general game start scenario
    playBackgroundMusic(
      "./assets/audio/background_music.mp3",
      0.4,
      musicVolume,
      209.4
    );
  }
  dealStartingHand(); // Deal cards when game starts

  console.log("Game starting!");
}
