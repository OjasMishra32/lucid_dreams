import { renderLibrary } from "./library";
import { renderViewer } from "./viewer";
import { META, showable } from "./event";
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
      // ?planes: a room for plane detection (IWER has none of its own): the floor and a 1.2 x 0.8 m table, its top at
      // 0.74 m and its near edge 0.35 m in front of where the headset starts (?planes=low: a 0.45 m coffee table)
      if (params.has("planes")) {
        const y = params.get("planes") === "low" ? 0.45 : 0.74;
        const at = (x: number, py: number, z: number) => ({ matrix: new Float32Array([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, x, py, z, 1]) });
        const box = (w: number, d: number) => [[-w / 2, -d / 2], [w / 2, -d / 2], [w / 2, d / 2], [-w / 2, d / 2]].map(([x, z]) => ({ x, y: 0, z, w: 1 }));
        const planes = new Set([
          { transform: at(0, 0, 0), polygon: box(6, 6), semanticLabel: "floor" },
          { transform: at(0, y, -0.75), polygon: box(1.2, 0.8), semanticLabel: "table" },
        ]);
        device.installSEM(
          class {
            environmentCanvas = document.createElement("canvas");
            trackedPlanes = planes;
            trackedMeshes = new Set();
            render() {}
            computeHitTestResults() {
              return [];
            }
            computeDepthBuffer() {
              return null; // (no emulated depth: depth sensing is on but sees nothing)
            }
          } as never,
        );
      }
      (window as unknown as Record<string, unknown>).__xrDevice = device;
    })
  : Promise.resolve();

void emulate.then(() => {
  const mode = params.get("mode");
  // the competition (event.ts): tennis and Court Side show people who aren't entrants, so they go to the library, and so
  // does a link to anyone else's dream
  if (META && (mode === "tennis" || mode === "court" || (!mode && id && !showable(id)))) {
    history.replaceState(null, "", `${location.pathname}?library`);
    return renderLibrary(app);
  }
  // and its front door is Vishal himself, standing in your room (Talk, Reality check, then Play chess from his palm
  // menu); the library is ?library
  if (mode === "chess") import("./chess/game").then((m) => m.renderChess(app));
  else if (mode === "tennis") import("./tennis/game").then((m) => m.renderTennis(app));
  else if (mode === "court") import("./court/court").then((m) => m.renderCourt(app));
  else if (META && !id && !params.has("library")) renderViewer(app, "vishal");
  else if (id) renderViewer(app, id);
  else renderLibrary(app);
});
