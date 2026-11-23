/** Domain types shared by every layer. No DOM, no pdf.js here. */

export type DocKind = "pdf"; // "docx" arrives in milestone 6

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
