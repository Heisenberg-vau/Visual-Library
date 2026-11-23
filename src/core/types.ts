/** Domain types shared by every layer. No DOM, no pdf.js here. */

/** "notebook" = a blank exercise book written in the app (milestone 5). */
export type DocKind = "pdf" | "notebook"; // "docx" arrives later

export interface BookMeta {
  id: string;
  kind: DocKind;
  title: string;
  fileName: string;
  /** Size of the stored original, bytes. */
  size: number;
  pageCount: number;
  /** pdf.js fingerprint, used to detect the same document imported twice. */
  fingerprint: string;
  addedAt: number;
  lastOpenedAt: number | null;
  /** 1-based page the user was reading. */
  lastPage: number;
  /** Zoom relative to "fit width" (1 = fit width). */
  zoom: number;
  /** The one shelf the book lives on; null = "Chưa phân loại". */
  categoryId: string | null;
  /** Free labels; a book can have many. */
  tags: string[];
  /** Widened writing margin beside every page (fractions of page width). */
  margins: { left: number; right: number; pattern?: "blank" | "lines" | "grid" | "dots" };
  /** Notebooks only: paper of every page. */
  paper?: "blank" | "lines" | "grid" | "dots";
  /** Starred: shown first and under "Yêu thích". */
  favorite: boolean;
  /** Bookmarked pages (1-based, sorted). */
  bookmarks: number[];
}

/** A shelf. Shelves nest: "Hàng không" > "Động cơ". */
export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  createdAt: number;
}

export interface OutlineNode {
  title: string;
  /** 1-based page, or null if the destination could not be resolved. */
  page: number | null;
  children: OutlineNode[];
}

export interface PageSize {
  /** Width/height in PDF points at scale 1, rotation applied. */
  width: number;
  height: number;
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}
