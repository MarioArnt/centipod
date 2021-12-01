import { from, Observable } from "rxjs";
import { mergeAll } from "rxjs/operators";
import {
  isNodeErroredEvent,
  isNodeStartedEvent,
  isNodeSucceededEvent,
  RunCommandEvent,
  RunCommandEventEnum
} from "./process";
import { Project } from "./project";
import { Workspace } from "./workspace";

export interface ICommonRunOptions{
  mode: 'parallel' | 'topological';
  force: boolean;
  affected?: { rev1: string, rev2: string};
}

export interface ITopologicalRunOptions extends ICommonRunOptions {
  to?: Workspace;
}

export interface IParallelRunOptions extends ICommonRunOptions {
  workspaces?: Workspace[];
}

export type RunOptions = IParallelRunOptions | ITopologicalRunOptions;

const isTopological = (options: RunOptions): options is ITopologicalRunOptions => options.mode === 'topological';

export class Runner {

  constructor(
    private readonly _project: Project,
    private readonly _concurrency: number = 4,
  ) {}

  runCommand<T = unknown>(cmd: string, options: RunOptions, data?: T): Observable<RunCommandEvent<T>> {
    return new Observable((obs) => {
      this._resolveTargets(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets });
        if (!targets.length) {
          obs.complete();
        } else if (isTopological(options)) {
          const runNextWorkspace = (): void => {
            this._runForWorkspace(targets[0], cmd, options.force).subscribe(
              (evt) => {
                if (isNodeSucceededEvent(evt)) {
                  obs.next({...evt, data});
                  if (!options.force && !evt.result.fromCache) {
                    options.force = true;
                  }
                  targets.shift();
                  if (targets.length) {
                    runNextWorkspace();
                  } else {
                    obs.complete();
                  }
                } else if (isNodeErroredEvent(evt)) {
                  Promise.all(targets.map(t => t.invalidate(cmd))).finally(() => {
                    obs.error({...evt, data});
                  });
                } else if (isNodeStartedEvent(evt)) {
                  obs.next({...evt, data});
                }
              },
              (error) => obs.error(error),
            )
          }
          runNextWorkspace();
        } else {
          from(targets.map((w) => this._runForWorkspace(w, cmd, !!options.force))).pipe(mergeAll(this._concurrency)).subscribe(
            (evt) => obs.next({...evt, data}),
            (err) => obs.error({...err, data}),
            () => obs.complete(),
          )
        }
      })
    });
  }

  private _runForWorkspace(workspace: Workspace, cmd: string, force: boolean): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      obs.next({ type: RunCommandEventEnum.NODE_STARTED, workspace });
      workspace.run(cmd, force)
        .then((result) => {
          obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
        }).catch((error) => {
          obs.next({ type: RunCommandEventEnum.NODE_ERRORED, error, workspace })
        }).finally(() => {
          obs.complete();
        });
    });
  }

  private async _resolveTargets(cmd: string, options: RunOptions): Promise<Workspace[]> {
    const findTargets = async (eligible: Workspace[]): Promise<Workspace[]> => {
      const targets: Workspace[] = [];
      await Promise.all(Array.from(eligible).map(async (workspace) => {
        const hasCommand = await workspace.hasCommand(cmd);
        let isTarget = hasCommand;
        if (hasCommand && options.affected?.rev1) {
          const patterns = workspace.config[cmd].src;
          const isAffected = await workspace.isAffected(options.affected.rev1, options.affected.rev2, patterns, options.mode === 'topological');
          isTarget = hasCommand && isAffected;
        }
        if (isTarget) {
          targets.push(workspace);
        }
      }));
      return targets;
    }
    if (isTopological(options)) {
      return findTargets(this._project.getTopologicallySortedWorkspaces(options.to));
    }
    const workspaces = options.workspaces || Array.from(this._project.workspaces.values());
    return findTargets(workspaces);
  }
}
