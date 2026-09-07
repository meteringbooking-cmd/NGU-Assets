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
  substrateWidth: 1, // inches
  substrateHeight: 0.5, // inches
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

// Must be triggered directly from a user click — Web Bluetooth's device
// picker only opens in response to a real user gesture, and browsers
// generally won't allow it once too much async work happens first.
export async function connectBradyPrinter() {
  const BradyPrinter = await loadSdk();
  if (!printerInstance) {
    // Second arg (false) disables Brady's own built-in analytics/telemetry.
    printerInstance = new BradyPrinter(() => {}, false);
  }
  if (printerInstance.isConnected()) return printerInstance;

  try {
    const ok = await printerInstance.showDiscoveredBleDevices();
    if (!ok || !printerInstance.isConnected()) {
      throw new Error(
        "Connected to the printer over Bluetooth, but it didn't finish setting up in time. This is a common one-off with Bluetooth — click Print again and it should go straight through."
      );
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
}

/* ------------------------------------------------------------------ */
/* Label rendering — draws the QR + Asset ID onto an offscreen canvas  */
/* at the printer's native 203dpi, sized from the Settings above.      */
/* ------------------------------------------------------------------ */
function buildLabelCanvas({ qrCode, assetId }, settings) {
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

      resolve(canvas);
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
    if (settings.supplyName) printer.supplyName = settings.supplyName;
    printer.substrateWidth = settings.substrateWidth;
    printer.substrateHeight = settings.substrateHeight;
    printer.orientation = settings.orientation;
    printer.mediaIsDieCut = settings.mediaIsDieCut;
    printer.rotation = 0;
    printer.leftOffset = 0;
    printer.verticalOffset = 0;
    printer.setCopies(1);
    printer.setCutOption(settings.cutOption);

    const canvas = await buildLabelCanvas({ qrCode, assetId }, settings);
    const ok = await printer.printBitmap(canvas);
    if (ok) {
      toast(`Label sent to the Brady printer for ${assetId}.`, "success");
    } else {
      toast("The Brady printer reported the print job failed. Check the printer and try again.", "error");
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
  const widthInput = el("input", { type: "number", step: "0.01", min: "0.1", name: "substrateWidth", value: String(settings.substrateWidth) });
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
    field("Label Width (inches)", widthInput),
    field("Label Height (inches)", heightInput),
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
