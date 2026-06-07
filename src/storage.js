import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

export class JsonStore {
  constructor(storageDir) {
    this.storageDir = storageDir;
  }

  async readCollection(name) {
    await mkdir(this.storageDir, { recursive: true });
    try {
      const raw = await readFile(this.pathFor(name), 'utf8');
      return JSON.parse(raw);
    } catch (err) {
      if (err && err.code === 'ENOENT') return [];
      throw err;
    }
  }

  async writeCollection(name, value) {
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.pathFor(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  pathFor(name) {
    return join(this.storageDir, `${name}.json`);
  }
}
