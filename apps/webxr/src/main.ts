import { renderLibrary } from "./library";
import { renderViewer } from "./viewer";

const app = document.getElementById("app")!;
const id = new URLSearchParams(location.search).get("dream");
if (id) renderViewer(app, id);
else renderLibrary(app);
