import "./ui/styles.css";
import { App } from "./app/App";
import { toast } from "./ui/feedback";

const root = document.getElementById("app")!;
const app = new App(root);
(window as unknown as { __app?: App }).__app = app;
void app.start();

// Offline support. Updates install in the background and apply on next launch.
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void import("virtual:pwa-register").then(({ registerSW }) => {
    registerSW({
      immediate: true,
      onOfflineReady: () => toast("App đã sẵn sàng dùng offline."),
    });
  });
}
