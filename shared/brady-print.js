// Wraps Brady's Web Bluetooth print SDK (./brady/bundle.js) so any page
// can print an asset's QR label directly to a paired Brady label printer
// (M211/M511/M610/M611/M710/S3700 — the SDK's own supported model list),
// instead of going through the OS print dialog.
//
// HARD REQUIREMENTS (Web Bluetooth, not something this file can work
// around): Chrome or Edge, on desktop or Android, and the page must be
// served over https:// or from http://localhost — it will not work in
// Safari/iOS at all (no Web Bluetooth support there), and will not work
// over a plain http:// LAN address such as http://192.168.x.x:5500.
//
// See ./brady/BRADY-SDK-LICENSE.txt for Brady's SDK license terms —
// integrating this SDK into an application for the purpose of printing
// to a Brady printer is explicitly permitted under section 1 of that
// agreement.

import { el, toast, openModal, closeModal } from "./common.js";

const SETTINGS_KEY = "bradyPrinterSettings";

// Defaults match the label size the app already uses for its OS-print
// "Print QR Label" button (25.4mm x 12.6mm => 1in x 0.5in) at the M211's
// native 203dpi. These are a best-effort starting point, not a
// hardware-verified calibration — Brady doesn't publish the exact
// substrate/orientation numbers in the SDK bundle itself, so treat the
// first print as a test: if it comes out the wrong size, rotated, or
// mis-cut, fix it here in Settings rather than needing a code change.
const DEFAULT_SETTINGS = {
  printerModel: "M211", // M211 | M511 | M610 | M611 | M710 | S3700
  supplyName: "", // exact label/supply name loaded in the printer — check the printer's own app or the label roll packaging. Leave blank to use whatever supply the printer already has loaded.
  // The M211's print head is only 0.63in wide (a hard limit baked into its
  // firmware), so substrateWidth — the dimension across the head — must be
  // 0.63 or less. substrateHeight is the length along the feed direction
  // and isn't capped the same way. These were swapped in an earlier
  // version of this file, which is almost certainly why the print job
  // was being rejected (0.63in cap exceeded) even though the Bluetooth
  // connection and data transfer both succeeded.
  substrateWidth: 0.5, // inches — across the print head, must stay <= 0.63
  substrateHeight: 0.5, // inches — length along the feed. Matches the printer's own reported supply (M21-500-595-WT, 0.5in x 0.5in continuous) — only used if the printer doesn't report in time; normally the real printer-reported value wins.
  orientation: "Landscape", // Landscape | Portrait
  mediaIsDieCut: false, // true if using pre-cut individual labels rather than a continuous roll
  cutOption: 1, // 0 = cut at end of job, 1 = cut after every label, 2 = never cut
};

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...DEFAULT_SETTINGS, ...JSON.parse(raw) } : { ...DEFAULT_SETTINGS };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

function saveSettings(settings) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

export function isBradyPrintSupported() {
  return window.isSecureContext && !!navigator.bluetooth;
}

let sdkModulePromise = null;
function loadSdk() {
  if (!sdkModulePromise) sdkModulePromise = import("./brady/bundle.js").then((m) => m.default);
  return sdkModulePromise;
}

let printerInstance = null;

// The printer streams its status back over Bluetooth as a series of
// "which fields just changed" notifications (battery, firmware, and —
// critically — what label/supply is actually loaded: SupplyName,
// SupplyWidth, SupplyHeight, SupplyIsPresized). That takes a moment after
// connecting to arrive. This tracks whether we've seen it yet, so a print
// isn't attempted before the printer has told us what's really in it.
let supplyInfoSeen = false;

// Must be triggered directly from a user click — Web Bluetooth's device
// picker only opens in response to a real user gesture, and browsers
// generally won't allow it once too much async work happens first.
export async function connectBradyPrinter() {
  const BradyPrinter = await loadSdk();
  if (!printerInstance) {
    supplyInfoSeen = false;
    // Second arg (false) disables Brady's own built-in analytics/telemetry.
    // The first arg is the SDK's own status-update callback — it fires as
    // printer status packets come in, each one naming which fields just
    // changed. We log it (for diagnosing failures) and watch for the
    // supply-related fields specifically.
    printerInstance = new BradyPrinter((update) => {
      console.log("Brady printer update:", update);
      if (Array.isArray(update) && update.some((f) => typeof f === "string" && f.startsWith("Supply"))) {
        supplyInfoSeen = true;
      }
    }, false);
  }
  if (printerInstance.isConnected()) return printerInstance;

  try {
    const ok = await printerInstance.showDiscoveredBleDevices();
    if (!ok || !printerInstance.isConnected()) {
      throw new Error(
        "Connected to the printer over Bluetooth, but it didn't finish setting up in time. This is a common one-off with Bluetooth — click Print again and it should go straight through."
      );
    }
    console.log("Brady printer connected. Status:", {
      battery: printerInstance.batteryLevelPercentage,
      onAcPower: printerInstance.isAcConnected,
      firmwareVersion: printerInstance.firmwareVersion,
      message: printerInstance.message,
      messageTitle: printerInstance.messageTitle,
      messageRemedy: printerInstance.messageRemedy,
    });
    if (printerInstance.batteryLevelPercentage != null && printerInstance.batteryLevelPercentage < 15 && !printerInstance.isAcConnected) {
      toast(`Brady printer battery is low (${printerInstance.batteryLevelPercentage}%) and not on AC power — this can cause print jobs to fail.`, "error");
    }
    return printerInstance;
  } catch (err) {
    // Don't leave a half-connected instance sitting around for the next
    // attempt to trip over — start the next click with a clean slate.
    try { printerInstance.disconnect(); } catch {}
    printerInstance = null;
    throw err;
  }
}

export function disconnectBradyPrinter() {
  if (printerInstance && printerInstance.isConnected()) {
    printerInstance.disconnect();
  }
  supplyInfoSeen = false;
}

// Waits for the printer to report what's actually loaded, up to timeoutMs.
// Returns true if it reported in time, false if we gave up waiting — a
// caller should fall back to configured defaults in that case rather than
// attempt to print with no substrate size at all (which the SDK rejects
// outright).
function waitForSupplyInfo(timeoutMs = 6000) {
  return new Promise((resolve) => {
    if (supplyInfoSeen) return resolve(true);
    const start = Date.now();
    (function check() {
      if (supplyInfoSeen) return resolve(true);
      if (Date.now() - start > timeoutMs) return resolve(false);
      setTimeout(check, 200);
    })();
  });
}

/* ------------------------------------------------------------------ */
/* Label rendering — draws the QR + Asset ID onto an offscreen canvas  */
/* at the printer's native 203dpi, sized from the Settings above, then */
/* hands back a loaded <img>. The SDK's own internals (setupBanding in */
/* bundle.js) read .src / .naturalWidth / .naturalHeight off whatever  */
/* is passed to printBitmap() — those don't exist on a plain <canvas>, */
/* so passing the canvas directly silently fails deep inside the SDK.  */
/* ------------------------------------------------------------------ */
function buildLabelImage({ qrCode, assetId }, settings) {
  return new Promise((resolve) => {
    const DPI = 203; // M211/M511 print head resolution
    const wIn = settings.orientation === "Portrait" ? settings.substrateHeight : settings.substrateWidth;
    const hIn = settings.orientation === "Portrait" ? settings.substrateWidth : settings.substrateHeight;
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(1, Math.round(wIn * DPI));
    canvas.height = Math.max(1, Math.round(hIn * DPI));
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const qrSize = canvas.height - 8;
    const qrHost = el("div", { style: "position:absolute; left:-9999px; top:-9999px;" });
    document.body.appendChild(qrHost);
    // eslint-disable-next-line no-new
    new window.QRCode(qrHost, {
      text: qrCode || "",
      width: qrSize,
      height: qrSize,
      correctLevel: window.QRCode.CorrectLevel.M,
    });

    setTimeout(() => {
      const src = qrHost.querySelector("canvas") || qrHost.querySelector("img");
      if (src) ctx.drawImage(src, 4, 4, qrSize, qrSize);
      qrHost.remove();

      const textX = qrSize + 14;
      ctx.fillStyle = "#000";
      ctx.font = `bold ${Math.round(canvas.height * 0.16)}px Arial`;
      ctx.textBaseline = "middle";
      drawWrappedText(ctx, assetId || "", textX, canvas.width - 6, canvas.height);

      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(img); // resolve regardless — printBitmap will surface any real problem
      img.src = canvas.toDataURL("image/png");
    }, 60);
  });
}

function drawWrappedText(ctx, text, x, maxX, canvasHeight) {
  const maxWidth = Math.max(10, maxX - x);
  const lineHeight = canvasHeight * 0.2;
  const chunks = text.split(/(?<=[A-Za-z])(?=[0-9])|(?<=[0-9])(?=[A-Za-z])/); // split at letter/number boundary so IDs like AST000123 wrap sensibly
  let line = "";
  const lines = [];
  chunks.forEach((chunk) => {
    const test = line + chunk;
    if (ctx.measureText(test).width > maxWidth && line) {
      lines.push(line);
      line = chunk;
    } else {
      line = test;
    }
  });
  if (line) lines.push(line);
  const startY = canvasHeight / 2 - ((lines.length - 1) * lineHeight) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, startY + i * lineHeight));
}

/* ------------------------------------------------------------------ */
/* Public: print one asset's QR label                                  */
/* ------------------------------------------------------------------ */
export async function printAssetQrLabel({ qrCode, assetId }) {
  if (!isBradyPrintSupported()) {
    toast("Direct printing needs Chrome or Edge, over https:// (or localhost), with Bluetooth available.", "error");
    return false;
  }
  const settings = loadSettings();
  try {
    const printer = await connectBradyPrinter();
    printer.printerModel = settings.printerModel;

    // Give the printer a chance to report what's actually loaded before we
    // touch supply/substrate fields at all — printing before that arrives
    // is a guaranteed failure, and it can take a couple of seconds over BLE.
    const gotSupplyInfo = await waitForSupplyInfo();
    console.log("Brady printer supply after waiting:", {
      gotSupplyInfo,
      supplyName: printer.supplyName,
      substrateWidth: printer.substrateWidth,
      substrateHeight: printer.substrateHeight,
      mediaIsDieCut: printer.mediaIsDieCut,
    });

    if (settings.supplyName) {
      // The user explicitly typed a supply name into Settings — respect
      // that override rather than whatever the printer auto-detected.
      printer.supplyName = settings.supplyName;
      printer.substrateWidth = settings.substrateWidth;
      printer.substrateHeight = settings.substrateHeight;
      printer.mediaIsDieCut = settings.mediaIsDieCut;
    } else if (!gotSupplyInfo || printer.substrateWidth == null || printer.substrateHeight == null) {
      // The printer never told us what's loaded (or we gave up waiting) —
      // fall back to the configured label size so there's at least
      // something to attempt, rather than a guaranteed-null print job.
      printer.substrateWidth = settings.substrateWidth;
      printer.substrateHeight = settings.substrateHeight;
      printer.mediaIsDieCut = settings.mediaIsDieCut;
    }
    // Otherwise: leave supplyName/substrateWidth/substrateHeight/mediaIsDieCut
    // exactly as the printer itself reported them — that's the ground truth
    // for what's physically loaded, which Settings can't know in advance.

    printer.orientation = settings.orientation;
    printer.rotation = 0;
    printer.leftOffset = 0;
    printer.verticalOffset = 0;
    printer.setCopies(1);
    printer.setCutOption(settings.cutOption);

    const labelImage = await buildLabelImage(
      { qrCode, assetId },
      { ...settings, substrateWidth: printer.substrateWidth, substrateHeight: printer.substrateHeight }
    );
    const ok = await printer.printBitmap(labelImage);
    if (ok) {
      toast(`Label sent to the Brady printer for ${assetId}.`, "success");
    } else {
      // The printer streams status back over Bluetooth as it goes, and the
      // SDK mirrors the latest of it onto these properties. message/
      // messageTitle/messageRemedy come back as untranslated internal keys
      // (e.g. "PrinterStatus_Initialized") rather than readable text, so
      // they're logged for reference but not shown as if they were an
      // explanation — the supply/battery facts below are more useful.
      const status = {
        message: printer.message,
        messageTitle: printer.messageTitle,
        messageRemedy: printer.messageRemedy,
        battery: printer.batteryLevelPercentage,
        onAcPower: printer.isAcConnected,
        supplyName: printer.supplyName,
        substrateWidth: printer.substrateWidth,
        substrateHeight: printer.substrateHeight,
      };
      console.error("Brady printer reported failure. Status at time of failure:", status);
      toast(
        `The Brady printer reported the print job failed` +
          (status.supplyName
            ? ` (loaded label: "${status.supplyName}", ${status.substrateWidth}in x ${status.substrateHeight}in)`
            : " — it hasn't reported a loaded label; check there's a cartridge in and the door/lid is fully closed") +
          `.`,
        "error"
      );
    }
    return ok;
  } catch (err) {
    console.error(err);
    toast(`Brady printer error: ${err.message || err}`, "error");
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* Settings modal — lets the exact physical/printer values be tuned    */
/* without a code change, since the correct supply name and orientation */
/* can only be confirmed against the real printer.                     */
/* ------------------------------------------------------------------ */
export function openBradyPrinterSettings() {
  const settings = loadSettings();
  const form = el("form", { style: "display:flex; flex-direction:column; gap:14px; min-width:320px;" });

  function field(label, inputNode) {
    return el("div", { class: "field" }, [el("label", {}, label), inputNode]);
  }

  const modelSelect = el(
    "select",
    { name: "printerModel" },
    ["M211", "M511", "M610", "M611", "M710", "S3700"].map((m) =>
      el("option", { value: m, ...(settings.printerModel === m ? { selected: "selected" } : {}) }, m)
    )
  );
  const supplyInput = el("input", {
    type: "text",
    name: "supplyName",
    value: settings.supplyName,
    placeholder: "e.g. M21-750-427 — leave blank to use the printer's loaded supply",
  });
  const widthInput = el("input", { type: "number", step: "0.01", min: "0.1", max: "0.63", name: "substrateWidth", value: String(settings.substrateWidth) });
  const heightInput = el("input", { type: "number", step: "0.01", min: "0.1", name: "substrateHeight", value: String(settings.substrateHeight) });
  const orientationSelect = el(
    "select",
    { name: "orientation" },
    ["Landscape", "Portrait"].map((o) => el("option", { value: o, ...(settings.orientation === o ? { selected: "selected" } : {}) }, o))
  );
  const dieCutCheckbox = el("input", {
    type: "checkbox",
    name: "mediaIsDieCut",
    id: "brady-die-cut",
    ...(settings.mediaIsDieCut ? { checked: "checked" } : {}),
  });
  const cutSelect = el("select", { name: "cutOption" }, [
    el("option", { value: "1", ...(settings.cutOption === 1 ? { selected: "selected" } : {}) }, "Cut after every label"),
    el("option", { value: "0", ...(settings.cutOption === 0 ? { selected: "selected" } : {}) }, "Cut at end of job only"),
    el("option", { value: "2", ...(settings.cutOption === 2 ? { selected: "selected" } : {}) }, "Never cut"),
  ]);

  form.append(
    el(
      "div",
      { class: "muted", style: "font-size:12.5px;" },
      "These default to the app's existing label size (25.4mm x 12.6mm). If your first test print is the wrong size, rotated, or mis-cut, adjust the values below — no code change needed."
    ),
    field("Printer Model", modelSelect),
    field("Label / Supply Name (optional)", supplyInput),
    field("Label Width — across the print head, inches (M211 max 0.63)", widthInput),
    field("Label Height — along the feed, inches", heightInput),
    field("Orientation", orientationSelect),
    el("div", { class: "field checkbox-row" }, [dieCutCheckbox, el("label", { for: "brady-die-cut" }, "Pre-cut (die-cut) labels, not a continuous roll")]),
    field("Cutting", cutSelect),
    el("button", { type: "submit", class: "btn btn-primary" }, "Save Settings")
  );

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    saveSettings({
      printerModel: modelSelect.value,
      supplyName: supplyInput.value.trim(),
      substrateWidth: parseFloat(widthInput.value) || DEFAULT_SETTINGS.substrateWidth,
      substrateHeight: parseFloat(heightInput.value) || DEFAULT_SETTINGS.substrateHeight,
      orientation: orientationSelect.value,
      mediaIsDieCut: dieCutCheckbox.checked,
      cutOption: parseInt(cutSelect.value, 10),
    });
    toast("Brady printer settings saved.", "success");
    closeModal();
  });

  openModal("Brady Printer Settings", form);
}
