const { chromium } = require("playwright-extra");
const stealth = require("puppeteer-extra-plugin-stealth")();

chromium.use(stealth);

(async () => {
  // Persistent profile folder — first run: log in manually here.
  // Future runs will reuse this same authenticated session.
  const userDataDir = "C:\\Bot_Streaming_Poc\\chrome-profile";

  const context = await chromium.launchPersistentContext(userDataDir, {
    headless: false,
    channel: "chrome", // use real installed Chrome instead of bundled Chromium
    slowMo: 300,
  });

  await context.grantPermissions(["camera", "microphone"], {
    origin: "https://meet.google.com",
  });

  // Inject WebRTC hook BEFORE Meet's own scripts run.
// Patches RTCPeerConnection so every new track (audio/video) gets logged
// with its id and kind the moment it's added.
await context.addInitScript(() => {
  const OriginalRTCPeerConnection = window.RTCPeerConnection;

  window.RTCPeerConnection = function (...args) {
    const pc = new OriginalRTCPeerConnection(...args);

    pc.addEventListener('track', (event) => {
      const track = event.track;
      console.log(
        `[WEBRTC_TRACK] kind=${track.kind} id=${track.id} label=${track.label}`
      );

      window.__capturedTracks = window.__capturedTracks || [];
      window.__capturedTracks.push({
        kind: track.kind,
        id: track.id,
        label: track.label,
        timestamp: Date.now(),
      });
    });

    return pc;
  };

  window.RTCPeerConnection.prototype = OriginalRTCPeerConnection.prototype;
});

  const page = context.pages()[0] || (await context.newPage());

  page.on("close", () => console.log("PAGE CLOSED EVENT FIRED"));
  context.on("close", () => console.log("CONTEXT CLOSED EVENT FIRED"));

  await page.goto("https://meet.google.com/wyr-cfzu-qmc");

  console.log("Page loaded, taking screenshot...");
  await page.screenshot({ path: "debug_screenshot.png" });
  console.log("Screenshot saved.");

  // Instead of a blind fixed wait, wait for something concrete to load
  await page.waitForLoadState("networkidle").catch(() => {});
  await page.waitForTimeout(1500); // small buffer for Meet's JS to finish rendering buttons

  // Try turning off camera/mic (best-effort)
  await page
    .getByRole("button", { name: /turn off camera/i })
    .click()
    .catch(() => console.log("Camera toggle not found"));

  await page
    .getByRole("button", { name: /turn off microphone/i })
    .click()
    .catch(() => console.log("Microphone toggle not found"));

  // Fill name if a guest name field appears (only relevant if not logged in)
  const nameInput = page.getByRole("textbox");
  if (await nameInput.isVisible().catch(() => false)) {
    await nameInput.fill("Meeting Bot");
    console.log("Filled in bot name");
  }

  // Click join
  try {
    await page.getByRole("button", { name: /ask to join|join now/i }).click();
    console.log("Clicked join button");
  } catch (e) {
    console.log("Join button not found:", e.message);
  }

  // Keep open to observe result
  await page.waitForTimeout(120000);
})();
