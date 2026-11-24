import { h } from "./dom";

/** Toasts and modal dialogs (no native alert/confirm, which block the UI). */

let toastHost: HTMLElement | null = null;

export function toast(message: string, kind: "info" | "error" = "info", ms = 3500, action?: { label: string; run: () => void }): void {
  if (!toastHost) {
    toastHost = h("div", { class: "toast-host", role: "status", "aria-live": "polite" });
    document.body.append(toastHost);
  }
  const t = h("div", { class: `toast toast-${kind}` }, message);
  if (action) {
    const b = h("button", { class: "toast-action", type: "button", "data-testid": "toast-action" }, action.label);
    b.addEventListener("click", () => {
      action.run();
      t.remove();
    });
    t.append(b);
  }
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
    if (e.target !== backdrop) return;
    const r = anchor.getBoundingClientRect();
    if (e.clientX >= r.left && e.clientX <= r.right && e.clientY >= r.top && e.clientY <= r.bottom) {
      // A second tap on the button that opened the menu closes it: that tap
      // lands on the backdrop first, then its click would reopen the menu.
      // Swallow exactly that one click.
      // Swallow only the click of this very tap: the next touch, wherever,
      // starts a new gesture and ends the swallowing (mouse clicks may never
      // reach the button at all once the backdrop is gone).
      const swallow = (ev: Event) => {
        ev.stopImmediatePropagation();
        ev.preventDefault();
        done();
      };
      const done = () => {
        anchor.removeEventListener("click", swallow, true);
        window.removeEventListener("pointerdown", done, true);
      };
      anchor.addEventListener("click", swallow, true);
      setTimeout(() => window.addEventListener("pointerdown", done, true), 0);
    }
    backdrop.remove();
  });
  backdrop.append(menu);
  document.body.append(backdrop);
  const r = anchor.getBoundingClientRect();
  const mw = menu.offsetWidth;
  menu.style.top = `${Math.min(window.innerHeight - menu.offsetHeight - 8, r.bottom + 4)}px`;
  menu.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.right - mw))}px`;
}
