import { renderLibrary } from "./library";
import { renderViewer } from "./viewer";

const app = document.getElementById("app")!;
const params = new URLSearchParams(location.search);
const id = params.get("dream");
if (params.get("mode") === "chess") import("./chess/game").then((m) => m.renderChess(app));
else if (id) renderViewer(app, id);
else renderLibrary(app);
