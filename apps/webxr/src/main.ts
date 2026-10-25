import { renderLibrary } from "./library";
import { renderViewer } from "./viewer";
import "./xr/report"; // errors from the headset reach the Mac's log

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const id = params.get("dream");

// dev only: ?emulate runs Meta's WebXR emulator (IWER) as a Quest 3 with tracked hands, so hand play can be checked on
// a laptop (window.__xrDevice moves the hands and pinches)
const emulate = import.meta.env.DEV && params.has("emulate")
  ? import("iwer").then(({ XRDevice, metaQuest3 }) => {
      // ?xrhz=90 starts the headset at 90 Hz, ?xrrates=90,120 sets what it offers (Court Side's frame-rate e2e)
      const xrhz = Number(params.get("xrhz")) || metaQuest3.internalNominalFrameRate;
      const xrrates = params.get("xrrates")?.split(",").map(Number) ?? metaQuest3.supportedFrameRates;
      const device = new XRDevice({ ...metaQuest3, internalNominalFrameRate: xrhz, supportedFrameRates: xrrates });
      device.installRuntime({ forceInstall: true });
      device.primaryInputMode = "hand";
      (window as unknown as Record<string, unknown>).__xrDevice = device;
    })
  : Promise.resolve();

void emulate.then(() => {
  if (params.get("mode") === "chess") import("./chess/game").then((m) => m.renderChess(app));
  else if (params.get("mode") === "tennis") import("./tennis/game").then((m) => m.renderTennis(app));
  else if (params.get("mode") === "court") import("./court/court").then((m) => m.renderCourt(app));
  else if (id) renderViewer(app, id);
  else renderLibrary(app);
});
