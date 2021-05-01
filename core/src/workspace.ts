// Class
import { Project } from './project';
import { promises as fs } from 'fs';
import { join, relative } from 'path';
import { INpmInfos, Package } from './package';
import { git } from './git';
import { sync as glob } from 'fast-glob';
import { command } from 'execa';
import { Config } from './config';
import { ICommandResult, IProcessResult } from './process';
import { Cache } from './cache';
import { Publish, PublishActions, PublishEvent, Upgrade } from './publish';
import { Observable } from 'rxjs';

export class Workspace {
  // Constructor
  constructor(
    protected readonly pkg: Package,
    readonly root: string,
    protected readonly _config: Config,
    readonly project?: Project
  ) {}

  // Statics
  protected static async loadPackage(root: string): Promise<Package> {
    const file = join(root, 'package.json');
    const data = await fs.readFile(file, 'utf-8');
    return JSON.parse(data);
  }

  static async loadWorkspace(root: string, project?: Project): Promise<Workspace> {
    return new Workspace(await this.loadPackage(root), root, await this._loadConfig(root), project);
  }

  protected static async _loadConfig(root: string): Promise<Config> {
    const file = join(root, 'centipod.json');
    try {
      const data = await fs.readFile(file, 'utf-8');
      return JSON.parse(data);
    } catch (e) {
      if (e.code === 'ENOENT') {
        return {};
      }
      throw e;
    }
  }

  // Methods
  *dependencies(): Generator<Workspace, void> {
    if (!this.project) {
      console.warn(`Cannot load dependencies of workspace ${this.name}: loaded outside of a project`);
      return;
    }

    // Generate dependencies
    for (const deps of [this.pkg.dependencies, this.pkg.devDependencies]) {
      if (!deps) continue;

      for (const dep of Object.keys(deps)) {
        const wks = this.project.getWorkspace(dep);
        if (wks) yield wks;
      }
    }
  }

  *dependents(): Generator<Workspace, void> {
    if (!this.project) {
      console.warn(`Cannot load dependencies of workspace ${this.name}: loaded outside of a project`);
      return;
    }
    for (const workspace of this.project.workspaces.values()) {
      if (workspace === this) continue;
      for (const dep of workspace.dependencies()) {
        if (dep === this) {
          yield workspace;
          break;
        } 
      }
    }
  }

  // Properties
  get config(): Config {
    return this._config;
  }

  get name(): string {
    return this.pkg.name;
  }

  get version(): string | undefined {
    return this.pkg.version;
  }

  private _publish: Publish | undefined;

  private async _testAffected(rev1: string, rev2?: string, patterns: string[] = ['**']): Promise<boolean> {
    // Compute diff
    const diffs = rev2
      ? await git.diff('--name-only', rev1, rev2, '--', this.root)
      : await git.diff('--name-only', rev1, '--', this.root);

    // No pattern
    if (patterns.length === 0 && patterns[0] === '**') {
      return diffs.length > 0;
    }

    const rel = relative(git.root, this.root);
    const files = patterns.map((pattern) => glob(join(rel, pattern))).reduce((acc, val) => acc = acc.concat(val), []);
    return diffs.some((diff) => files.includes(diff));
  }

  private async _testDepsAffected(tested: Set<Workspace>,rev1: string, rev2?: string, patterns: string[] = ['**']): Promise<boolean> {
    tested.add(this);

    // Test if is affected
    const affected = await this._testAffected(rev1, rev2, patterns);
    if (affected) return true;

    // Test dependencies if are affected
    for (const dep of this.dependencies()) {
      // Check if already tested
      if (tested.has(dep)) continue;

      // Test
      const affected = await dep._testDepsAffected(tested, rev1, rev2, patterns);
      if (affected) return true;
    }

    return false;
  }

  async isAffected(rev1: string, rev2?: string, patterns: string[] = ['**'], topological = true): Promise<boolean> {
    if (!topological) {
      return await this._testAffected(rev1, rev2, patterns);
    }
    return await this._testDepsAffected(new Set(), rev1, rev2, patterns);
  }

  async hasCommand(cmd: string): Promise<boolean> {
    return !!this.config[cmd];
  }

  async run(cmd: string, force = false): Promise<IProcessResult> {
    let now = Date.now();
    const cache = new Cache(this, cmd);
    const cachedOutputs = await cache.read();
    if (!force && cachedOutputs) {
      return { commands: cachedOutputs, overall: Date.now() - now, fromCache: true }
    }
    try {
      const results: ICommandResult[] = [];
      const cmds = this.config[cmd].cmd;
      for (const _cmd of Array.isArray(cmds) ? cmds : [cmds]) {
        now = Date.now();
        const result = await command(_cmd, {
          cwd: this.root,
          env: { ...process.env, FORCE_COLOR: '2' },
          shell: process.platform === 'win32',
        });
        results.push({...result, took: Date.now() - now });
      }
      await cache.write(results);
      return { commands: results, fromCache: false, overall: results.reduce((acc, val) => acc + val.took, 0) };
    } catch (e) {
      cache.invalidate();
      throw e;
    }
  }

  async invalidate(cmd: string) {
    const cache = new Cache(this, cmd);
    await cache.invalidate();
  }

  async bumpVersions(bump: Upgrade, identifier?: string): Promise<PublishActions> {
    this._publish = new Publish(this, bump, identifier);
    return this._publish.determineActions();   
  }

  publish(accessPublic = false): Observable<PublishEvent> {
    if (!this._publish) {
      throw Error('You must bump versions before publishing');
    }
    return this._publish.release(accessPublic);   
  }

  async getNpmInfos(): Promise<INpmInfos> {
    const infos = await command(`yarn npm info ${this.name} --json`);
    return JSON.parse(infos.stdout);
  }

  async isPublished(version: string): Promise<boolean> {
    const infos = await this.getNpmInfos();
    return infos.versions.includes(version);
  }

  async setVersion(version: string) {
    const manifest = await Workspace.loadPackage(this.root);
    manifest.version = version;
    await fs.writeFile(join(this.root, 'package.json'), JSON.stringify(manifest, null, 2));
  }
}
