import { from, Observable } from "rxjs";
import { mergeAll } from "rxjs/operators";
import {
  IResolvedTarget,
  isNodeErroredEvent,
  isNodeSkippedEvent,
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
  stdio?: 'pipe' | 'inherit';
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

  runCommand(cmd: string, options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      this._resolveTargets(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets });
        if (!targets.length) {
          obs.complete();
        } else if (isTopological(options)) {
          const runNextWorkspace = (): void => {
            const runNext = (): void => {
              targets.shift();
              if (targets.length) {
                runNextWorkspace();
              } else {
                obs.complete();
              }
            }
            this._runForWorkspace(targets[0], cmd, options.force, args, options.stdio).subscribe(
              (evt) => {
                if (isNodeSucceededEvent(evt)) {
                  obs.next(evt);
                  if (!options.force && !evt.result.fromCache) {
                    options.force = true;
                  }
                  runNext();
                } else if (isNodeErroredEvent(evt)) {
                  Promise.all(targets.map(t => t.workspace.invalidate(cmd))).finally(() => {
                    obs.error(evt);
                  });
                } else if (isNodeSkippedEvent(evt)) {
                  obs.next(evt);
                  runNext();
                } else {
                  obs.next(evt);
                }
              },
              (error) => obs.error(error),
            )
          }
          runNextWorkspace();
        } else {
          from(targets.map((w) => this._runForWorkspace(w, cmd, options.force, args, options.stdio))).pipe(mergeAll(this._concurrency)).subscribe(
            (evt) => obs.next(evt),
            (err) => obs.error(err),
            () => obs.complete(),
          )
        }
      })
    });
  }

  private _runForWorkspace(target: IResolvedTarget, cmd: string, force: boolean, args: string[] | string = [], stdio: 'pipe' | 'inherit' = 'pipe'): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      const workspace = target.workspace;
      if (target.affected && target.hasCommand) {
        obs.next({ type: RunCommandEventEnum.NODE_STARTED, workspace });
        workspace.run(cmd, force, args, stdio)
          .then((result) => {
            obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
          }).catch((error) => {
          obs.next({ type: RunCommandEventEnum.NODE_ERRORED, error, workspace })
        }).finally(() => {
          obs.complete();
        });
      } else {
        obs.next({ type: RunCommandEventEnum.NODE_SKIPPED, ...target });
        obs.complete();
      }
    });
  }

  private async _resolveTargets(cmd: string, options: RunOptions): Promise<Array<IResolvedTarget>> {
    const findTargets = async (eligible: Workspace[]): Promise<Array<IResolvedTarget>> => {
      const targets: Array<IResolvedTarget> = [];
      await Promise.all(Array.from(eligible).map(async (workspace) => {
        const hasCommand = await workspace.hasCommand(cmd);
        if (hasCommand && options.affected?.rev1) {
          const patterns = workspace.config[cmd].src;
          const isAffected = await workspace.isAffected(options.affected.rev1, options.affected.rev2, patterns, options.mode === 'topological');
          targets.push({ workspace, affected: isAffected, hasCommand})
        } else {
          targets.push({ workspace, affected: true, hasCommand})
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
