import { describe, expect, it } from "vitest";
import { BackupError, BackupWriter, FRAME, needsPassword, openBackup, verifyBackup } from "../../src/core/backup/container";

const bytesOf = (n: number, seed = 1) => {
  const u = new Uint8Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    u[i] = x >>> 24;
  }
  return u;
};
const all = async (it: AsyncGenerator<Uint8Array>) => {
  const parts: Uint8Array[] = [];
  for await (const c of it) parts.push(c);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
};

async function make(password?: string) {
  const w = await BackupWriter.create({ app: "test", password, iterations: 1000 });
  await w.addBytes("db/books.json", new TextEncoder().encode('{"x":1}'));
  await w.addBlob("file/big", new Blob([bytesOf(9 * 1024 * 1024 + 123)])); // crosses 4 MiB blocks and 1 MiB frames
  await w.addBlob("file/empty", new Blob([]));
  return w.finish({ kind: "full", id: "b1" });
}

describe("backup file (.vlbak)", () => {
  for (const password of [undefined, "mật khẩu dài 123"]) {
    const label = password ? "locked" : "plain";
    it(`${label}: writes, opens, verifies and reads back every byte`, async () => {
      const file = await make(password);
      expect(await needsPassword(file)).toBe(!!password);
      const b = await openBackup(file, password);
      expect(b.manifest.kind).toBe("full");
      expect(b.manifest.entries.map((e) => e.name)).toEqual(["db/books.json", "file/big", "file/empty"]);
      expect(await verifyBackup(b)).toEqual([]);
      const big = await all(b.read(b.entry("file/big")!));
      expect(big).toEqual(bytesOf(9 * 1024 * 1024 + 123));
      expect(new TextDecoder().decode(await b.bytes(b.entry("db/books.json")!))).toBe('{"x":1}');
      expect((await all(b.read(b.entry("file/empty")!))).length).toBe(0);
      // plain backups hand out slices of the file itself (no copy); locked ones cannot
      expect(!!b.slice(b.entry("file/big")!)).toBe(!password);
    });

    it(`${label}: a changed byte is caught`, async () => {
      const file = await make(password);
      const u = new Uint8Array(await file.arrayBuffer());
      u[u.length - 3 * FRAME] ^= 0x40; // inside file/big
      const bad = new Blob([u]);
      if (password) {
        // a sealed frame refuses to open at all
        const b = await openBackup(bad, password);
        expect(await verifyBackup(b)).toEqual(["file/big"]);
      } else {
        const b = await openBackup(bad);
        expect(await verifyBackup(b)).toEqual(["file/big"]);
      }
    });

    it(`${label}: a cut-off file is refused`, async () => {
      const file = await make(password);
      for (const cut of [5, FRAME + 16, 2 * (FRAME + 16)]) {
        await expect(openBackup(file.slice(0, file.size - cut), password)).rejects.toBeInstanceOf(BackupError);
      }
    });
  }

  it("a wrong password is refused at once", async () => {
    const file = await make("đúng");
    await expect(openBackup(file, "sai")).rejects.toThrow(/Sai mật khẩu/);
    await expect(openBackup(file)).rejects.toThrow(/khóa bằng mật khẩu/);
  });

  it("a locked backup does not contain the content in clear", async () => {
    const w = await BackupWriter.create({ app: "test", password: "pw", iterations: 1000 });
    await w.addBytes("db/tasks.json", new TextEncoder().encode("Ôn ATA 72-30 BÍ MẬT"));
    const file = await w.finish({ kind: "notes", id: "b2" });
    const text = new TextDecoder("latin1").decode(await file.arrayBuffer());
    expect(text).not.toContain("72-30");
    expect(text).not.toContain("db/tasks.json");
  });

  it("other files are not backups", async () => {
    await expect(openBackup(new Blob(["%PDF-1.7 hello"]))).rejects.toThrow(/không phải file sao lưu/);
  });
});
