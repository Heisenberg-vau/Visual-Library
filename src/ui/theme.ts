/** Day ("Giấy da", parchment) or night ("Ánh nến", candlelight). Remembered on this device. */
export type Theme = "day" | "night";

const KEY = "vl.theme";

export function currentTheme(): Theme {
  return document.documentElement.dataset.theme === "night" ? "night" : "day";
}

export function applyTheme(t: Theme): void {
  if (t === "night") document.documentElement.dataset.theme = "night";
  else delete document.documentElement.dataset.theme;
  const meta = document.querySelector('meta[name="theme-color"]');
  meta?.setAttribute("content", t === "night" ? "#140e09" : "#3b2719");
  try {
    localStorage.setItem(KEY, t);
  } catch {
    /* private mode */
  }
}

export function loadTheme(): void {
  let t: Theme = "day";
  try {
    if (localStorage.getItem(KEY) === "night") t = "night";
  } catch {
    /* ignore */
  }
  applyTheme(t);
}
