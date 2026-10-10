import ReactDOM from "react-dom/client";
import { getCurrentWindow } from "@tauri-apps/api/window";
import App from "./App";
import Mini from "./pages/Mini";
import "./styles.css";
import { setLang, systemLang } from "./lib/i18n";

// until the settings are read: the Windows display language
setLang(systemLang());

let isMini = false;
try {
  isMini = getCurrentWindow().label === "mini";
} catch {
  // not running inside Tauri (browser preview)
  isMini = location.hash === "#mini";
}
if (isMini) document.documentElement.classList.add("is-mini");

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(isMini ? <Mini /> : <App />);
