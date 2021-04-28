// Class
import { Project } from './project';
import { promises as fs } from 'fs';
import { join, relative } from 'path';
import type { Package } from './package';
import { git } from './git';
import { sync as glob } from 'fast-glob';

export class Workspace {
  // Constructor
  constructor(
    protected readonly pkg: Package,
    readonly root: string,
    readonly project?: Project
  ) {}

  private _dependencies: Set<Workspace>;

  // Statics
  protected static async loadPackage(root: string): Promise<Package> {
    const file = join(root, 'package.json');
    const data = await fs.readFile(file, 'utf-8');
    return JSON.parse(data);
  }

  static async loadWorkspace(root: string, project?: Project): Promise<Workspace> {
    return new Workspace(await this.loadPackage(root), root, project);
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

  resolveDependencies() {
    const _resolveDependencies = (deps: Generator<Workspace>) => {
      for (const dep of deps) {
        this._dependencies.add(dep);
        _resolveDependencies(dep.dependencies());
      }
    }
    _resolveDependencies(this.dependencies());
  }

  // Properties
  get name(): string {
    return this.pkg.name;
  }

  private async _testAffected(rev1: string, rev2?: string, pattern = '**'): Promise<boolean> {
    // Compute diff
    const diffs = rev2
      ? await git.diff('--name-only', rev1, rev2, '--', this.root)
      : await git.diff('--name-only', rev1, '--', this.root);

    // No pattern
    if (pattern === '**') {
      return diffs.length > 0;
    }

    const rel = relative(git.root, this.root);
    const files = glob(join(rel, pattern));
    return diffs.some((diff) => files.includes(diff));
  }

  private async _testDepsAffected(tested: Set<Workspace>,rev1: string, rev2?: string, pattern = '**'): Promise<boolean> {
    tested.add(this);

    // Test if is affected
    const affected = await this._testAffected(rev1, rev2, pattern);
    if (affected) return true;

    // Test dependencies if are affected
    for (const dep of this.dependencies()) {
      // Check if already tested
      if (tested.has(dep)) continue;

      // Test
      const affected = await dep._testDepsAffected(tested, rev1, rev2, pattern);
      if (affected) return true;
    }

    return false;
  }

  async isAffected(rev1: string, rev2?: string, pattern = '**'): Promise<boolean> {
    return await this._testDepsAffected(new Set(), rev1, rev2, pattern);
  }
}
