// Where uploaded files live. Keys look like "<orgId>/<year>/<mediaId>" and are validated strictly, so a key can never
// point outside the storage root (no "..", no absolute paths, no extra segments).
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

export interface BlobStore {
  put(key: string, data: Buffer): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
}

const KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/\d{4}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const isValidBlobKey = (key: string) => KEY_RE.test(key);

export class MemoryBlobStore implements BlobStore {
  files = new Map<string, Buffer>();
  async put(key: string, data: Buffer) { if (!isValidBlobKey(key)) throw new Error('invalid blob key'); this.files.set(key, Buffer.from(data)); }
  async get(key: string) { if (!isValidBlobKey(key)) throw new Error('invalid blob key'); const b = this.files.get(key); return b ? Buffer.from(b) : null; }
  async delete(key: string) { if (!isValidBlobKey(key)) throw new Error('invalid blob key'); this.files.delete(key); }
}

export class DiskBlobStore implements BlobStore {
  private root: string;
  constructor(root: string) { this.root = root; }

  private path(key: string): string {
    if (!isValidBlobKey(key)) throw new Error('invalid blob key');
    return join(this.root, key);
  }

  /** Written to a temporary file and renamed, so readers never see a half-written file. */
  async put(key: string, data: Buffer): Promise<void> {
    const target = this.path(key);
    await mkdir(dirname(target), { recursive: true });
    const tmp = `${target}.${randomUUID()}.tmp`;
    await writeFile(tmp, data, { mode: 0o640 });
    await rename(tmp, target);
  }

  async get(key: string): Promise<Buffer | null> {
    try { return await readFile(this.path(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null; throw e; }
  }

  async delete(key: string): Promise<void> {
    try { await unlink(this.path(key)); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
