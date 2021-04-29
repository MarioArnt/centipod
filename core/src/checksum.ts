import { Workspace } from "./workspace";
import { promises as fs } from 'fs';
import { sync as glob } from 'fast-glob';
import { join } from 'path';
import { fromFile } from 'hasha';
import { Cache } from "./cache";

export class Checksum {

  constructor (
    private readonly _cache: Cache,
  ) {}

  get checksumPath(): string {
    return join(this._cache.cacheFolder, 'checksums.json');
  }

  async read(): Promise<Record<string, string>> {
    try {
      const checksums = await fs.readFile(this.checksumPath);
      return JSON.parse(checksums.toString());
    } catch (e) {
      return {};
    }
  }

  async calculate(): Promise<Record<string, string>> {
    const config = this._cache.config;
    const src = config.src.map((s) => glob(s)).reduce((acc, val) => acc = acc.concat(val), []);
    const checksums: Record<string, string> = {
      cmd: config.cmd,
      globs: config.src.join(','),
    };
    await Promise.all(src.map(async (path) => {
      checksums[path] = await fromFile(path, { algorithm: 'sha256' });
    }));
    return checksums;
  }
}
