// Class
import { Workspace } from './workspace';
import { join } from 'path';
import { sync as glob } from 'fast-glob';
import { RunOptions, Runner } from './runner';
import { Publish } from './publish';
import { ReleaseType } from 'semver';
import { CentipodError, CentipodErrorCode } from './error';
import { Observable } from 'rxjs';
import { RunCommandEvent } from './process';

export class Project extends Workspace {
  // Attributes
  protected readonly _workspaces = new Map<string, Workspace>();
  readonly project = this;
  // Getters
  get workspaces(): Map<string, Workspace> { return this._workspaces }

  // Statics
  static async loadProject(root: string): Promise<Project> {
    const prj = new Project(await this.loadPackage(root), root, await this.loadConfig(root));
    await prj.loadWorkspaces();
    return prj;
  }

  // Methods
  async loadWorkspaces(): Promise<void> {
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
          throw new CentipodError(CentipodErrorCode.UNABLE_TO_LOAD_WORKSPACE, `Unable to load workspace at ${root}: ${error}`);
        }
      }
    }
  }

  getWorkspace(name: string): Workspace | null {
    return this._workspaces.get(name) || null;
  }

  *leaves(): Generator<Workspace, void>  {
    for (const workspace of this.workspaces.values()) {
      let isLeaf = true;
      for (const dep of workspace.dependencies()) {
        isLeaf = false;
        break;
      }
      if (isLeaf) yield workspace;
    }
  }

  *roots(): Generator<Workspace, void>  {
    for (const workspace of this.workspaces.values()) {
      let isRoot = true;
      for (const dep of workspace.dependents()) {
        isRoot = false;
      }
      if (isRoot) yield workspace;
    }
  }

  getTopologicallySortedWorkspaces(to?: Workspace): Workspace[] {
    const sortedWorkspaces: Set<Workspace> = new Set<Workspace>();
    const visitWorkspace = (workspace: Workspace): void => {
      for (const dep of workspace.dependencies()) {
        visitWorkspace(dep);
      }
      sortedWorkspaces.add(workspace);
    };
    if (to) {
      visitWorkspace(to);
    } else {
      for (const root of this.roots()) {
        visitWorkspace(root);
      }
    }
    return Array.from(sortedWorkspaces);
  }

  runCommand(cmd: string, options: RunOptions): Observable<RunCommandEvent> {
    const runner = new Runner(this);
    return runner.runCommand(cmd, options);
  }

  async publishAll(bump?: ReleaseType, identifier?: string): Promise<Publish> {
    const publisher = new Publish(this);
    await publisher.determineActions(undefined, bump, identifier);
    return publisher;
  }
}
