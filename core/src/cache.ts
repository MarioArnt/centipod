import { ExecaReturnValue } from 'execa';
import { promises as fs } from 'fs';
import { Checksum } from './checksum';
import { Workspace } from './workspace';
import { join } from 'path';
import { F_OK } from 'constants';
import chalk from 'chalk';
import { isEqual } from 'lodash';

export class Cache {
  constructor (
    private readonly _workspace: Workspace,
    private readonly _cmd: string,
  ) {}

  get cacheFolder(): string {
    return join(this._workspace.root, '.caches', this._cmd);
  }

  get outputPath(): string {
    return join(this.cacheFolder, 'output.json');
  }

  get config() {
    return this._workspace.config[this._cmd];
  }

  get workspace() {
    return this._workspace;
  }

  private _checksums: Record<string, string> | undefined;

  async read(): Promise<ExecaReturnValue<string> | null> {
    try {
      const checksums = new Checksum(this);
      const [currentChecksums, storedChecksum] = await Promise.all([
        checksums.calculate(),
        checksums.read(),
      ]);
      this._checksums = currentChecksums;
      if (!isEqual(currentChecksums, storedChecksum)) {
        return null;
      }
      const output = await fs.readFile(this.outputPath);
      return JSON.parse(output.toString());
    } catch (e) {
      if (e.message === 'No path to cache') {
        console.warn(chalk.yellow(`Patterns ${this.config.src.join('|')} has no match: ignoring cache`));
        return null;
      }
      console.warn('Cannot read from cache', e);
      return null;
    }
  }

  async write(output: ExecaReturnValue<string>) {
    try {
      const checksums = new Checksum(this)
      const toWrite = this._checksums ?? await checksums.calculate();
      await this._createCacheDirectory();
      try {
        await Promise.all([
          fs.writeFile(checksums.checksumPath, JSON.stringify(checksums)),
          fs.writeFile(this.outputPath, JSON.stringify(output)),
        ]);
      } catch (e) {
        if (e.message === 'No path to cache') {
          await this.invalidate();
        } else {
          throw e;
        }
      }
    } catch (e) {
      console.warn('Error writing cache', e);
    }
  }

  async invalidate() {
    try {
      const checksums = new Checksum(this);
      const exists = async (path: string): Promise<boolean> => {
        try {
          await fs.access(path, F_OK);
          return true;
        } catch (e) {
          if (e.code === 'ENOENT') {
            return false;
          }
          throw e;
        }
      };
      const removeIfExists = async (path: string): Promise<void> => {
        if (await exists(path)) {
          await fs.unlink(path);
        }
      };
      await Promise.all([
        removeIfExists(checksums.checksumPath),
        removeIfExists(this.outputPath),
      ]);
    } catch (e) {
      throw Error('Fatal: error invalidating cache. Next command runs could have unexpected result !');
    }
  }

  private async _createCacheDirectory(): Promise<void> {
    try {
      await fs.access(this.cacheFolder, F_OK);
    } catch (e) {
      await fs.mkdir(this.cacheFolder, { recursive: true });
    }
  }
}
