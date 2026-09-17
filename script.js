
// Elements
const button = document.getElementById("theButton");
const timer = document.getElementById("timer");
const message = document.getElementById("message");
const displayStartTime = document.getElementById('displayStartTime');
const displayPenalty = document.getElementById('displayPenalty');
const displayTimeToPress = document.getElementById('displayTimeToPress');
const fomoMessagesEl = document.getElementById("fomoMessages");
const timeElapsedEl = document.getElementById("timeElapsed");

// Config
const startTime = 10  * 60 * 1000; // 10 minutes
const punishmentTime = 45 * 1000;  // 45 seconds
const earlyClickPenaltyTime = 60 * 1000; // 1 minute for clicking while inactive
const timeToPress = 2 * 1000;      // 2 seconds
const minTimeBetweenActivations = 3 * 1000;
const maxTimeBetweenActivations = 20 * 1000;
const successChance = 1;

let currentMode = 'princessyBrat'; // 'sexyDomme' or 'princessyBrat'

// State
let timeRemaining = startTime;
let isButtonActive = false;
let timerInterval = null;
let fomoInterval = null;
let fomoStartTime = null;
let flashTimeout = null;
let sessionActive = false;
let sessionEndsAt = null;
let fullscreenWasEntered = false;
let historyGuardActive = false;
let pageWasHidden = false;
let pageHiddenAt = null;
let lockOverlay = null;

// JSON storage
let sexyDommeSuccess = [];
let princessyBratSuccess = [];
let fomoLinesEarlyRamp = {};

// ---------------------------
// Utility Functions
// ---------------------------
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));

const randomDelay = () => Math.floor(Math.random() * (maxTimeBetweenActivations - minTimeBetweenActivations + 1)) + minTimeBetweenActivations;

function formatTime(ms) {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds < 10 ? "0" : ""}${seconds}`;
}

function updateTimerDisplay() {
    timer.innerText = `Time remaining: ${formatTime(timeRemaining)}`;
}

function flashMessage(text, duration) {
    if (flashTimeout) clearTimeout(flashTimeout);
    message.innerText = text;
    message.style.opacity = 1;
    flashTimeout = setTimeout(() => {
        message.style.opacity = 0;
        flashTimeout = setTimeout(() => {
            message.innerText = "";
        }, 100);
    }, duration);
}

function displaySettings() {
    displayStartTime.innerText = `${Math.floor(startTime / 60000)} minutes`;
    displayPenalty.innerText = `${punishmentTime / 1000} seconds`;
    displayTimeToPress.innerText = `${timeToPress / 1000} seconds`;
}

// ---------------------------
// Session / Fullscreen Guard
// ---------------------------
function getFullscreenElement() {
    return document.fullscreenElement || document.webkitFullscreenElement || null;
}

function getFullscreenRequest() {
    const root = document.documentElement;
    return root.requestFullscreen || root.webkitRequestFullscreen || null;
}

async function requestPageFullscreen() {
    if (getFullscreenElement()) return true;

    const root = document.documentElement;
    const request = getFullscreenRequest();
    if (!request) return false;

    try {
        // Keep this argument-free for the broadest Safari/Firefox/Chromium support.
        await Promise.resolve(request.call(root));
        return true;
    } catch (err) {
        console.warn("Fullscreen request failed:", err);
        return false;
    }
}

async function exitPageFullscreen() {
    if (!getFullscreenElement()) return;

    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (!exit) return;

    try {
        await Promise.resolve(exit.call(document));
    } catch (err) {
        console.warn("Fullscreen exit failed:", err);
    }
}

function ensureLockOverlay() {
    if (lockOverlay) return lockOverlay;

    lockOverlay = document.createElement("div");
    lockOverlay.id = "fullscreenLockOverlay";
    lockOverlay.setAttribute("role", "button");
    lockOverlay.setAttribute("tabindex", "0");
    lockOverlay.innerHTML = `
        <div style="max-width: 520px; text-align: center; padding: 28px;">
            <h2 style="margin-top: 0;">Session still running</h2>
            <p>You left fullscreen while the timer is active.</p>
            <p><strong>Click or tap here to return to fullscreen.</strong></p>
        </div>
    `;

    Object.assign(lockOverlay.style, {
        position: "fixed",
        inset: "0",
        zIndex: "2147483647",
        display: "none",
        alignItems: "center",
        justifyContent: "center",
        background: "rgba(0, 0, 0, 0.96)",
        color: "white",
        cursor: "pointer"
    });

    const restoreFullscreen = async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const entered = await requestPageFullscreen();
        if (entered) {
            fullscreenWasEntered = true;
            hideLockOverlay();
        }
    };

    lockOverlay.addEventListener("click", restoreFullscreen);
    lockOverlay.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
            restoreFullscreen(event);
        }
    });

    document.body.appendChild(lockOverlay);
    return lockOverlay;
}

function showLockOverlay() {
    if (!sessionActive || !fullscreenWasEntered) return;
    ensureLockOverlay().style.display = "flex";
}

function hideLockOverlay() {
    if (lockOverlay) lockOverlay.style.display = "none";
}

function handleFullscreenChange() {
    if (!sessionActive) return;

    if (getFullscreenElement()) {
        fullscreenWasEntered = true;
        hideLockOverlay();
    } else if (fullscreenWasEntered) {
        showLockOverlay();
    }
}

function handleBeforeUnload(event) {
    if (!sessionActive) return;

    event.preventDefault();
    event.returnValue = true;
    return true;
}

function armHistoryGuard() {
    if (historyGuardActive) return;

    historyGuardActive = true;
    history.pushState({ ...(history.state || {}), cornerSessionGuard: true }, "", location.href);
}

function disarmHistoryGuard() {
    historyGuardActive = false;

    // Remove the extra same-page history entry we created at session start.
    if (history.state && history.state.cornerSessionGuard) {
        history.back();
    }
}

function handlePopState() {
    if (!sessionActive || !historyGuardActive) return;

    history.pushState({ ...(history.state || {}), cornerSessionGuard: true }, "", location.href);
    flashMessage("Back navigation is disabled while the timer is running.", 1800);
}

function handleVisibilityChange() {
    if (!sessionActive) return;

    if (document.visibilityState === "hidden") {
        // Record exactly when they left. While hidden, the main timer is frozen
        // so it cannot finish before we get a chance to apply the away penalty.
        if (!pageWasHidden) {
            pageWasHidden = true;
            pageHiddenAt = Date.now();

            if (sessionEndsAt !== null) {
                timeRemaining = Math.max(0, sessionEndsAt - pageHiddenAt);
                updateTimerDisplay();
            }
        }
        return;
    }

    if (pageWasHidden) {
        const returnedAt = Date.now();
        const awayMs = pageHiddenAt === null
            ? 0
            : Math.max(0, returnedAt - pageHiddenAt);

        pageWasHidden = false;
        pageHiddenAt = null;

        // Add exactly the amount of time spent away. Extending the absolute
        // deadline this way effectively pauses the countdown while they are gone.
        if (awayMs > 0 && sessionEndsAt !== null) {
            sessionEndsAt += (awayMs*2);
            timeRemaining = Math.max(0, sessionEndsAt - returnedAt);
            updateTimerDisplay();
        }

        if (fullscreenWasEntered && !getFullscreenElement()) {
            showLockOverlay();
        } else if (awayMs > 0) {
            flashMessage(`You were away for ${formatTime(awayMs)}. That time was added to the timer.`, 2500);
        } else {
            flashMessage("Stay on this page until the timer reaches zero.", 1800);
        }
    }
}

function handleSessionLinkClick(event) {
    if (!sessionActive) return;

    const link = event.target.closest ? event.target.closest("a[href]") : null;
    if (!link) return;

    event.preventDefault();
    event.stopPropagation();
    flashMessage("Links are disabled while the timer is running.", 1800);
}

function handleSessionShortcut(event) {
    if (!sessionActive) return;

    const key = String(event.key || "").toLowerCase();
    const cmdOrCtrl = event.metaKey || event.ctrlKey;
    const blocked =
        key === "f5" ||
        (cmdOrCtrl && ["l", "r", "t", "n", "w"].includes(key)) ||
        (event.altKey && ["arrowleft", "arrowright"].includes(key));

    if (!blocked) return;

    // Browser-reserved shortcuts may still win; this is best-effort only.
    event.preventDefault();
    event.stopPropagation();
    flashMessage("Stay on this page until the timer reaches zero.", 1200);
}

function startSessionGuards() {
    window.addEventListener("beforeunload", handleBeforeUnload);
    window.addEventListener("popstate", handlePopState);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    document.addEventListener("click", handleSessionLinkClick, true);
    document.addEventListener("keydown", handleSessionShortcut, true);
    document.addEventListener("fullscreenchange", handleFullscreenChange);
    document.addEventListener("webkitfullscreenchange", handleFullscreenChange);
    armHistoryGuard();
}

function stopSessionGuards() {
    window.removeEventListener("beforeunload", handleBeforeUnload);
    window.removeEventListener("popstate", handlePopState);
    document.removeEventListener("visibilitychange", handleVisibilityChange);
    document.removeEventListener("click", handleSessionLinkClick, true);
    document.removeEventListener("keydown", handleSessionShortcut, true);
    document.removeEventListener("fullscreenchange", handleFullscreenChange);
    document.removeEventListener("webkitfullscreenchange", handleFullscreenChange);
    hideLockOverlay();
    pageWasHidden = false;
    pageHiddenAt = null;
    disarmHistoryGuard();
}

function addPenalty(ms) {
    timeRemaining += ms;
    if (sessionEndsAt !== null) sessionEndsAt += ms;
    updateTimerDisplay();
}

// ---------------------------
// JSON Loading
// ---------------------------
async function loadJsonFiles() {
    try {
        const [bratRes, fomoRes] = await Promise.all([
            fetch('./data/princessyBratSuccess.json'),
            fetch('./data/fomoLines.json')
        ]);

        princessyBratSuccess = (await bratRes.json()).princessyBratSuccess || [];
        fomoLinesEarlyRamp = (await fomoRes.json()).fomoLinesEarlyRamp || [];

        console.log("JSON loaded");
    } catch (err) {
        console.error("Failed to load JSON files:", err);
    }
}
loadJsonFiles();

// ---------------------------
// FOMO Tracking
// ---------------------------
function startFomoTracking() {
    fomoStartTime = Date.now();
    let lastMinute = -1;

    fomoInterval = setInterval(() => {
        const elapsedMs = Date.now() - fomoStartTime;
        const elapsedMinutes = Math.floor(elapsedMs / 60000);
        const elapsedSeconds = Math.floor((elapsedMs % 60000) / 1000);

        timeElapsedEl.innerText = `Time elapsed: ${elapsedMinutes}:${elapsedSeconds < 10 ? '0' : ''}${elapsedSeconds}`;

        if (elapsedMinutes !== lastMinute) {
            lastMinute = elapsedMinutes;
            const lines = fomoLinesEarlyRamp[String(elapsedMinutes)];
            if (Array.isArray(lines) && lines.length > 0) {
                const randomLine = lines[Math.floor(Math.random() * lines.length)];
                const p = document.createElement("p");
                p.innerText = randomLine;
                fomoMessagesEl.appendChild(p);
                fomoMessagesEl.scrollTop = fomoMessagesEl.scrollHeight;
            }
        }

        if (elapsedMinutes >= 60 || timeRemaining <= 0) {
            clearInterval(fomoInterval);
        }
    }, 1000);
}

// ---------------------------
// Success Line Picker
// ---------------------------
function pickSuccessLine() {
    const lines = currentMode === 'sexyDomme' ? sexyDommeSuccess : princessyBratSuccess;
    if (!lines || lines.length === 0) return null;
    return lines[Math.floor(Math.random() * lines.length)];
}

// ---------------------------
// Button Cycle
// ---------------------------
async function buttonCycle() {
    while (sessionActive && timeRemaining > 0) {
        const delay = randomDelay();
        await wait(delay);
        if (!sessionActive || timeRemaining <= 0) break;

        isButtonActive = true;
        button.classList.add("active");

        await wait(timeToPress);
        if (!sessionActive || timeRemaining <= 0) break;

        if (isButtonActive) {
            button.classList.remove("active");
            isButtonActive = false;

            addPenalty(punishmentTime);
            flashMessage(`Wow, disappointing, added ${punishmentTime / 1000} seconds`, 2000);
        }
    }
}

// ---------------------------
// Button Click
// ---------------------------
button.addEventListener("click", () => {
    if (!isButtonActive) {
        if (timeRemaining <= 0) return;

        addPenalty(earlyClickPenaltyTime);
        flashMessage(`Wow, disappointing, added ${earlyClickPenaltyTime / 1000} seconds`, 2000);
        return;
    }

    isButtonActive = false;
    button.classList.remove("active");

    const lines = currentMode === 'sexyDomme' ? sexyDommeSuccess : princessyBratSuccess;

    if (lines && lines.length > 0) {
        const useSuccessLine = Math.random() < successChance;
        const line = useSuccessLine ? lines[Math.floor(Math.random() * lines.length)] : '';
        flashMessage(line || "Good job… barely.", 3000);
    } else {
        flashMessage("Good job… barely.", 2000);
    }
});

// ---------------------------
// Timer
// ---------------------------
function startTimer() {
    sessionEndsAt = Date.now() + timeRemaining;

    timerInterval = setInterval(() => {
        // Do not let the session expire while the page is hidden. The exact
        // hidden duration is added to sessionEndsAt when visibility returns.
        if (pageWasHidden && pageHiddenAt !== null) return;

        timeRemaining = Math.max(0, sessionEndsAt - Date.now());

        if (timeRemaining <= 0) {
            timeRemaining = 0;
            updateTimerDisplay();
            clearInterval(timerInterval);
            clearInterval(fomoInterval);

            endGame();

            button.classList.remove("active");
            button.style.opacity = 0;

            return;
        }

        updateTimerDisplay();
    }, 250);
}

async function endGame() {
    sessionActive = false;
    isButtonActive = false;
    stopSessionGuards();
    await exitPageFullscreen();

    message.innerText = "You're free now, but remember, I own you.\n\n behave yourself in the future.";
    message.style.opacity = 1;
}


// ---------------------------
// Start Game
// ---------------------------
document.getElementById("startButton").addEventListener("click", async () => {
    // Fullscreen must be requested directly from this user gesture.
    const enteredFullscreen = await requestPageFullscreen();
    fullscreenWasEntered = enteredFullscreen;

    sessionActive = true;
    startSessionGuards();

    document.getElementById("setupScreen").style.display = "none";
    document.getElementById("gameScreen").style.display = "block";

    updateTimerDisplay();
    startTimer();
    buttonCycle();
    startFomoTracking();
});

displaySettings();
