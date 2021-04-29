import { ExecaReturnValue } from 'execa';
import { promises as fs } from 'fs';
import { Checksum } from './checksum';
import { Workspace } from './workspace';
import { join } from 'path';
import { F_OK } from 'constants';

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

  async read(): Promise<ExecaReturnValue<string> | null> {
    try {
      const checksums = new Checksum(this);
      const [currentChecksums, storedChecksum] = await Promise.all([
        checksums.calculate(),
        checksums.read(),
      ]);
      if (JSON.stringify(currentChecksums) !== JSON.stringify(storedChecksum)) {
        return null;
      }
      const output = await fs.readFile(this.outputPath);
      return JSON.parse(output.toString());
    } catch (e) {
      console.warn('Cannot read from cache', e);
      return null;
    }
  }

  async write(output: ExecaReturnValue<string>) {
    try {
      const checksums = new Checksum(this);
      await this._createCacheDirectory();
      await Promise.all([
        fs.writeFile(checksums.checksumPath, JSON.stringify(await checksums.calculate())),
        fs.writeFile(this.outputPath, JSON.stringify(output)),
      ]);
    } catch (e) {
      console.warn('Error writing cache', e);
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