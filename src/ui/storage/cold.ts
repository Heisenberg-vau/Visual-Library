import type { BookMeta } from "../../core/types";
import type { LibraryService } from "../../core/storage/LibraryService";
import type { MetaStore } from "../../core/storage/MetaStore";
import { originalKey } from "../../core/storage/LibraryService";
import { BACKUP_LOG_KEY, type BackupLog } from "../../core/backup/backup";
import { BackupError, needsPassword, openBackup, verifyBackup, type OpenedBackup } from "../../core/backup/container";
import { fileFingerprint } from "../../core/util/fingerprint";
import { UserFacingError } from "../../core/types";
import { h } from "../dom";
import { confirmDialog, modal, toast } from "../feedback";
import { askPassword } from "./BackupCard";

/*
 * Stage 3 · v2.3 — "kho lạnh": a book's file leaves the device, everything
 * else (notes, cover, place on the shelf, progress, search words) stays.
 * It comes back from the original file or from a backup that holds it.
 */

const day = (t: number) => new Date(t).toLocaleDateString("vi-VN");

/** Puts a book in cold storage after saying plainly where its file will still be. Returns true if done. */
export async function freezeFlow(book: BookMeta, library: LibraryService, meta: MetaStore, fileSize: number, origSize = 0): Promise<boolean> {
  const log = await meta.getSetting<BackupLog>(BACKUP_LOG_KEY, { last: null, files: {} });
  const backedUp = log.files[book.id] === fileSize && (!book.source || log.files[originalKey(book.id)] === origSize);
  const where = log.names?.[book.id];
  if (!backedUp && book.source) {
    toast("Sách nhập từ Word cần nằm trong một bản sao lưu trước khi cất kho lạnh. Hãy “Sao lưu phần mới” rồi thử lại.", "error", 8000);
    return false;
  }
  const ok = await confirmDialog(
    "Cất vào kho lạnh?",
    backedUp
      ? `File của “${book.title}” sẽ được gỡ khỏi máy để lấy lại chỗ. Ghi chú, bìa, chỗ trên kệ, tiến độ đọc vẫn giữ nguyên. File đang nằm trong bản sao lưu${where ? ` “${where}”` : ""}: khi cần, mở sách và chọn bản sao lưu đó (hoặc file PDF gốc) để đưa lại.`
      : `⚠ File của “${book.title}” CHƯA có trong bản sao lưu nào. Chỉ cất nếu bạn còn giữ file PDF gốc ở nơi khác (máy tính, ổ đám mây): muốn đọc lại thì phải chọn đúng file đó.`,
    "Cất kho lạnh",
    !backedUp,
  );
  if (!ok) return false;
  await library.freeze(book.id, backedUp ? where : undefined);
  return true;
}

/** Asks for the original file or a backup and brings a cold book back. Returns true if it is back. */
export async function thawFlow(book: BookMeta, library: LibraryService): Promise<boolean> {
  const pick = (await modal((close) => {
    const fromFile = h("button", { class: "btn btn-primary", type: "button", "data-testid": "thaw-file" }, book.source ? "Chọn file Word gốc" : "Chọn file PDF gốc");
    const fromBackup = h("button", { class: "btn", type: "button", "data-testid": "thaw-backup" }, "Chọn file sao lưu (.vlbak)");
    fromFile.addEventListener("click", () => close("file"));
    fromBackup.addEventListener("click", () => close("backup"));
    return h(
      "div",
      { class: "modal", role: "dialog", "aria-modal": "true", "data-testid": "thaw-dialog" },
      h("h2", {}, "❄ Sách đang ở kho lạnh"),
      h(
        "p",
        {},
        `“${book.title}” được cất ngày ${day(book.cold!.at)}: ghi chú vẫn còn, chỉ thiếu file. ${book.cold!.backup ? `File nằm trong bản sao lưu “${book.cold!.backup}”.` : "Hãy chọn đúng file gốc của sách."}`,
      ),
      h("div", { class: "modal-actions thaw-actions" }, h("button", { class: "btn", type: "button", onclick: () => close(null) }, "Để sau"), fromBackup, fromFile),
    );
  })) as "file" | "backup" | null;
  if (!pick) return false;
  const input = h("input", { type: "file", style: "display:none", "data-testid": "thaw-input" }) as HTMLInputElement;
  input.accept = pick === "backup" ? ".vlbak" : book.source ? ".docx" : ".pdf,application/pdf";
  document.body.append(input);
  const file = await new Promise<File | null>((resolve) => {
    input.addEventListener("change", () => resolve(input.files?.[0] ?? null), { once: true });
    input.addEventListener("cancel", () => resolve(null), { once: true });
    input.click();
  });
  input.remove();
  if (!file) return false;
  try {
    toast("Đang kiểm tra file…", "info", 2500);
    if (pick === "file") await library.thaw(book.id, file, fileFingerprint);
    else await thawFromBackupFile(book, file, library);
    toast(`Đã đưa “${book.title}” ra khỏi kho lạnh.`);
    return true;
  } catch (e) {
    toast(e instanceof UserFacingError || e instanceof BackupError ? e.message : "Không đưa sách về được.", "error", 8000);
    return false;
  }
}

async function thawFromBackupFile(book: BookMeta, file: File, library: LibraryService): Promise<void> {
  let b: OpenedBackup | null = null;
  let wrong = false;
  while (!b) {
    let password: string | undefined;
    if (await needsPassword(file)) {
      const p = await askPassword(file.name, wrong);
      if (p == null) throw new BackupError("Đã hủy.");
      password = p;
    }
    try {
      b = await openBackup(file, password);
    } catch (e) {
      if (password && e instanceof BackupError && /Sai mật khẩu/.test(e.message)) {
        wrong = true;
        continue;
      }
      throw e;
    }
  }
  const names = [`file/${book.id}`, ...(book.source ? [`file/${originalKey(book.id)}`] : [])];
  const entries = names.map((n) => b!.entry(n));
  if (entries.some((e) => !e)) throw new BackupError("Bản sao lưu này không có file của sách. Hãy chọn bản khác (bản được tạo trước khi cất kho lạnh).");
  const bad = await verifyBackup(b, undefined, undefined, names);
  if (bad.length) throw new BackupError("File của sách trong bản sao lưu bị hỏng.");
  const blobOf = async (n: number) => {
    const e = entries[n]!;
    const direct = b!.slice(e);
    if (direct) return direct;
    const parts: Blob[] = [];
    for await (const c of b!.read(e)) parts.push(new Blob([c as BlobPart]));
    return new Blob(parts);
  };
  await library.thawFromBackup(book.id, await blobOf(0), book.source ? await blobOf(1) : undefined);
}
