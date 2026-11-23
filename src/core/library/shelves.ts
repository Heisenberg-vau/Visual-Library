import type { BookMeta, Category } from "../types";

/** Pure helpers for the shelf tree and tags (no storage, unit-tested). */

export interface ShelfNode {
  category: Category;
  children: ShelfNode[];
  depth: number;
}

const collator = new Intl.Collator("vi", { sensitivity: "base", numeric: true });

export function compareNames(a: string, b: string): number {
  return collator.compare(a, b);
}

export function buildTree(categories: Category[]): ShelfNode[] {
  const byParent = new Map<string | null, Category[]>();
  const ids = new Set(categories.map((c) => c.id));
  for (const c of categories) {
    // An orphan (parent deleted elsewhere) is shown at the root, never lost.
    const p = c.parentId && ids.has(c.parentId) ? c.parentId : null;
    const list = byParent.get(p) ?? [];
    list.push(c);
    byParent.set(p, list);
  }
  const make = (parent: string | null, depth: number, seen: Set<string>): ShelfNode[] =>
    (byParent.get(parent) ?? [])
      .filter((c) => !seen.has(c.id))
      .sort((a, b) => compareNames(a.name, b.name))
      .map((c) => {
        const next = new Set(seen).add(c.id);
        return { category: c, depth, children: make(c.id, depth + 1, next) };
      });
  return make(null, 0, new Set());
}

/** Flattened tree in display order. */
export function flatten(nodes: ShelfNode[]): ShelfNode[] {
  const out: ShelfNode[] = [];
  const walk = (ns: ShelfNode[]) => {
    for (const n of ns) {
      out.push(n);
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** The shelf itself plus every shelf below it. */
export function subtreeIds(categories: Category[], id: string): Set<string> {
  const out = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const c of categories) {
      if (c.parentId && out.has(c.parentId) && !out.has(c.id)) {
        out.add(c.id);
        grew = true;
      }
    }
  }
  return out;
}

/** Root-to-shelf chain, for breadcrumbs: [Hàng không, Động cơ]. */
export function pathOf(categories: Category[], id: string | null): Category[] {
  const byId = new Map(categories.map((c) => [c.id, c]));
  const out: Category[] = [];
  let cur = id ? byId.get(id) : undefined;
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out;
}

/** Books per shelf, including books on shelves below it. */
export function countBooks(categories: Category[], books: BookMeta[]): Map<string, number> {
  const direct = new Map<string, number>();
  for (const b of books) if (b.categoryId) direct.set(b.categoryId, (direct.get(b.categoryId) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const c of categories) {
    let n = 0;
    for (const id of subtreeIds(categories, c.id)) n += direct.get(id) ?? 0;
    out.set(c.id, n);
  }
  return out;
}

/** "  Động  Cơ " -> "Động Cơ"; also strips a leading '#'. */
export function cleanTag(t: string): string {
  return t.trim().replace(/^#+/, "").replace(/\s+/g, " ").trim().slice(0, 40);
}

export function sameTag(a: string, b: string): boolean {
  return a.localeCompare(b, "vi", { sensitivity: "base" }) === 0;
}

/** Merges tags case-insensitively, keeping the first spelling seen. */
export function mergeTags(existing: string[], add: string[]): string[] {
  const out = [...existing];
  for (const raw of add) {
    const t = cleanTag(raw);
    if (t && !out.some((e) => sameTag(e, t))) out.push(t);
  }
  return out;
}

export function tagCounts(books: BookMeta[]): { tag: string; count: number }[] {
  const m = new Map<string, { tag: string; count: number }>();
  for (const b of books) {
    for (const t of b.tags) {
      const k = t.toLocaleLowerCase("vi");
      const e = m.get(k);
      if (e) e.count++;
      else m.set(k, { tag: t, count: 1 });
    }
  }
  return [...m.values()].sort((a, b) => b.count - a.count || compareNames(a.tag, b.tag));
}

/** Search by title or tag; diacritics-insensitive ("dong co" finds "Động cơ"). */
export function matchesQuery(b: BookMeta, q: string): boolean {
  const norm = (s: string) =>
    s.normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/g, "d").replace(/Đ/g, "D").toLowerCase();
  const terms = norm(q).split(/\s+/).filter(Boolean);
  const hay = norm(`${b.title} ${b.fileName} ${b.tags.map((t) => "#" + t).join(" ")}`);
  return terms.every((t) => hay.includes(t));
}
