import { promises as fs } from 'fs';
import { sync as glob } from 'fast-glob';
import { join } from 'path';
import { fromFile } from 'hasha';
import { Cache } from "./cache";
import { CentipodError, CentipodErrorCode } from './error';

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
    const src = config.src.map((s) => glob(join(this._cache.workspace.root, s))).reduce((acc, val) => acc = acc.concat(val), []);
    if (!src.length) {
      throw new CentipodError(CentipodErrorCode.NO_FILES_TO_CACHE, 'No path to cache');
    }
    const checksums: Record<string, string> = {
      cmd: Array.isArray(config.cmd) ? config.cmd.join(',') : config.cmd,
      globs: config.src.join(','),
    };
    await Promise.all(src.map(async (path) => {
      // FIXME: Batch to avoid EMFILE
      checksums[path] = await fromFile(path, { algorithm: 'sha256' });
    }));
    return checksums;
  }
}
