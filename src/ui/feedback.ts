import { h } from "./dom";

/** Toasts and modal dialogs (no native alert/confirm, which block the UI). */

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "error" = "info", ms = 3500): void {
  if (!toastHost) {
    toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = h("div", { class: `toast toast-${kind}` }, message);
  toastHost.append(t);
  setTimeout(() => {
    t.classList.add("toast-out");
    setTimeout(() => t.remove(), 300);
  }, ms);
}

export function modal(build: (close: (v: unknown) => void) => HTMLElement): Promise<unknown> {
  return new Promise((resolve) => {
    const backdrop = h("div", { class: "modal-backdrop" });
    const close = (v: unknown) => {
      backdrop.remove();
      resolve(v);
    };
    const box = build(close);
    backdrop.append(box);
    backdrop.addEventListener("pointerdown", (e) => {
      if (e.target === backdrop) close(null);
    });
    document.body.append(backdrop);
    (box.querySelector("input, .btn-primary") as HTMLElement | null)?.focus();
  });
}

export async function confirmDialog(
  title: string,
  message: string,
  okLabel = "Đồng ý",
  danger = false,
): Promise<boolean> {
  const r = await modal((close) =>
    h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true" },
      h("h2", {}, title),
      h("p", {}, message),
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close(false) }, "Hủy"),
        h(
          "button",
          { class: `btn btn-primary ${danger ? "btn-danger" : ""}`, type: "button", onclick: () => close(true) },
          okLabel,
        ),
      ),
    ),
  );
  return r === true;
}

export async function promptDialog(title: string, value: string, okLabel = "Lưu"): Promise<string | null> {
  const r = await modal((close) => {
    const input = h("input", { class: "text-input", type: "text", value });
    const form = h(
      "form",
      { class: "modal", role: "dialog", "aria-modal": "true" },
      h("h2", {}, title),
      input,
      h(
        "div",
        { class: "modal-actions" },
        h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Hủy"),
        h("button", { class: "btn btn-primary", type: "submit" }, okLabel),
      ),
    );
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      close(input.value);
    });
    setTimeout(() => input.select(), 0);
    return form;
  });
  return typeof r === "string" ? r : null;
}

/** Simple anchored popup menu. */
export function popupMenu(anchor: HTMLElement, items: { label: string; danger?: boolean; run: () => void }[]): void {
  const backdrop = h("div", { class: "menu-backdrop" });
  const menu = h("div", { class: "menu", role: "menu" });
  for (const it of items) {
    menu.append(
      h(
        "button",
        {
          class: `menu-item ${it.danger ? "danger" : ""}`,
          type: "button",
          role: "menuitem",
          onclick: () => {
            backdrop.remove();
            it.run();
          },
        },
        it.label,
      ),
    );
  }
  backdrop.addEventListener("pointerdown", (e) => {
    if (e.target === backdrop) backdrop.remove();
  });
  backdrop.append(menu);
  document.body.append(backdrop);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
}
