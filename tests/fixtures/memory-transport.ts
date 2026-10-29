import { createHash } from 'node:crypto';
import type { RemoteFile, SyncTransport } from '../../src/server/sync/drive';

/** An in-memory app data folder with Drive's semantics: ids, names that may repeat, md5 checksums. */
export class MemoryTransport implements SyncTransport {
  readonly files = new Map<string, { name: string; data: Buffer }>();
  private next = 1;

  private meta(id: string): RemoteFile {
    const f = this.files.get(id)!;
    return { id, name: f.name, checksum: createHash('md5').update(f.data).digest('hex'), size: f.data.length };
  }

  async list(): Promise<RemoteFile[]> {
    return [...this.files.keys()].map((id) => this.meta(id));
  }

  async read(id: string): Promise<Buffer> {
    const f = this.files.get(id);
    if (!f) throw new Error(`없는 파일: ${id}`);
    return f.data;
  }

  async create(name: string, data: Buffer): Promise<RemoteFile> {
    const id = `file-${this.next++}`;
    this.files.set(id, { name, data });
    return this.meta(id);
  }

  async update(id: string, data: Buffer): Promise<RemoteFile> {
    const f = this.files.get(id);
    if (!f) throw new Error(`없는 파일: ${id}`);
    f.data = data;
    return this.meta(id);
  }

  async remove(id: string): Promise<void> {
    this.files.delete(id);
  }

  /** Test helper: write a file under a name, replacing an existing file of that name. */
  put(name: string, data: Buffer): void {
    const existing = [...this.files].find(([, f]) => f.name === name)?.[0];
    if (existing) this.files.get(existing)!.data = data;
    else this.files.set(`file-${this.next++}`, { name, data });
  }

  get(name: string): Buffer | undefined {
    return [...this.files.values()].find((f) => f.name === name)?.data;
  }
}
