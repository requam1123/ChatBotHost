import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createLogger } from './logger.js';

const log = createLogger('storage');

export class JsonStore {
  constructor(storageDir) {
    this.storageDir = storageDir;
    log.info(`存储目录: ${storageDir}`);
  }

  async readCollection(name) {
    await mkdir(this.storageDir, { recursive: true });
    try {
      const raw = await readFile(this.pathFor(name), 'utf8');
      const data = JSON.parse(raw);
      const count = Array.isArray(data) ? data.length : 0;
      log.info(`读取集合 [${name}]: ${count} 条记录`);
      return data;
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        log.info(`读取集合 [${name}]: 文件不存在，返回空数组`);
        return [];
      }
      log.error(`读取集合 [${name}] 失败`, err);
      throw err;
    }
  }

  async writeCollection(name, value) {
    const count = Array.isArray(value) ? value.length : 0;
    log.info(`写入集合 [${name}]: ${count} 条记录`);
    await mkdir(this.storageDir, { recursive: true });
    await writeFile(this.pathFor(name), `${JSON.stringify(value, null, 2)}\n`);
  }

  pathFor(name) {
    return join(this.storageDir, `${name}.json`);
  }
}
