// Class
import { Workspace } from './workspace';
import { join } from 'path';
import { sync as glob } from 'fast-glob';

export class Project extends Workspace {
  // Attributes
  private readonly _workspaces = new Map<string, Workspace>();

  // Getters
  get workspaces(): Map<string, Workspace> { return this._workspaces }

  // Statics
  static async loadProject(root: string): Promise<Project> {
    const prj = new Project(await this.loadPackage(root), root);
    await prj.loadWorkspaces();

    return prj;
  }

  // Methods
  private async loadWorkspaces() {
    // Load workspaces
    if (this.pkg.workspaces && this.pkg.workspaces.length > 0) {
      const patterns = this.pkg.workspaces.map(wks => glob(join(this.root, wks, 'package.json'))).reduce((acc, val) => acc = acc.concat(val), []);
      for await (let root of patterns) {
        root = root.replace(/[\\/]package\.json$/, '');
        try {
          // Store it
          const wks = await Workspace.loadWorkspace(root, this);
          this._workspaces.set(wks.name, wks);

        } catch (error) {
          console.warn(`Unable to load workspace at ${root}: ${error}`);
        }
      }
    }
  }

  getWorkspace(name: string): Workspace | null {
    return this._workspaces.get(name) || null;
  }

  runCommand(cmd: string, options: { parallel: boolean, to: Workspace }) {
    const concurrency = 4;
    if (options.parallel) {
      if (options.to) {
        // Only on targeted workspace
      } else {
        // All workspace in parallel with given concurrency
      }
    } else {
      // sort workspace topologically (until --to if given, or all of them otherwise)
      // run command on each branch
    }
  }

  *leaves(): Generator<Workspace, void>  {
    for (const worskpace of this.workspaces.values()) {
      let isLeaf = true;
      for (const dep of worskpace.dependencies()) {
        isLeaf = false;
        break;
      }
      if (isLeaf) yield worskpace;
    }
  }

  *roots(): Generator<Workspace, void>  {
    for (const worskpace of this.workspaces.values()) {
      let isRoot = true;
      for (const dep of worskpace.dependents()) {
        isRoot = false;
      }
      if (isRoot) yield worskpace;
    }
  }
}
