import { from, Observable, Subject, throwError } from 'rxjs';
import { concatAll, mergeAll, tap } from 'rxjs/operators';
import {
  IResolvedTarget,
  RunCommandEvent,
  RunCommandEventEnum
} from "./process";
import { Project } from "./project";
import { Workspace } from "./workspace";
import { watch } from 'chokidar';
import { OrderedTargets, TargetsResolver } from './targets';

export interface ICommonRunOptions{
  mode: 'parallel' | 'topological';
  force: boolean;
  affected?: { rev1: string, rev2: string};
  stdio?: 'pipe' | 'inherit';
  watch?: boolean;
}

export interface ITopologicalRunOptions extends ICommonRunOptions {
  to?: Workspace;
}

export interface IParallelRunOptions extends ICommonRunOptions {
  workspaces?: Workspace[];
}

export type RunOptions = IParallelRunOptions | ITopologicalRunOptions;

export const isTopological = (options: RunOptions): options is ITopologicalRunOptions => options.mode === 'topological';

export class Runner {

  constructor(
    private readonly _project: Project,
    private readonly _concurrency: number = 4,
  ) {}

  /*watch(cmd: string, options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      this._resolveTargets(cmd, options).then((targets) => {
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets });
        if (!targets.length) {
          return obs.complete();
        }

        const parallelTasks$ = from(targets.map((w) => this._runForWorkspace(w, cmd, options.force, args, options.stdio))).pipe(mergeAll(this._concurrency));

        const sourcesChanged$ = new Subject<void>();
        const shouldInterrupt$ = new Subject<void>();
        //const toWatch = new Map<Workspace, string[]>
        if (options.watch) {
          targets.forEach((target) => {
            const patterns = target.workspace.config[cmd].src;
            patterns.forEach((glob) => {
              watch(glob).on('all', (event, path) => {
                sourcesChanged$.next();
                obs.next({ type: RunCommandEventEnum.SOURCES_CHANGED, event, path });
              });
            });
          })
        }

      });
    });
  }*/

  private _scheduleTasks(cmd: string, targets: OrderedTargets, options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    if (isTopological(options)) {
      const steps$: Array< Observable<RunCommandEvent>> = [];
      for (const step of targets) {
        const tasks$ = step.map((w) => this._runForWorkspace(targets, w, cmd, options.force, 'topological', args, options.stdio));
        steps$.push(from(tasks$).pipe(mergeAll(this._concurrency)))
      }
      return from(steps$).pipe(concatAll());
    } else {
      return from(targets[0].map((w) => this._runForWorkspace(targets, w, cmd, options.force, 'parallel', args, options.stdio))).pipe(mergeAll(this._concurrency));
    }
  }

  runCommand(cmd: string, options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      const targets = new TargetsResolver(this._project);
      targets.resolve(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets: targets.flat() });
        if (!targets.length) {
          return obs.complete();
        }
        const tasks$ = this._scheduleTasks(cmd, targets, options, args);
        tasks$.subscribe(
          (evt) => obs.next(evt),
          (err) => obs.error(err),
          () => obs.complete(),
        )
      })
    });
  }

  private _runForWorkspace(targets: OrderedTargets, target: IResolvedTarget, cmd: string, force: boolean, mode: 'topological' | 'parallel', args: string[] | string = [], stdio: 'pipe' | 'inherit' = 'pipe'): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      const workspace = target.workspace;
      if (target.affected && target.hasCommand) {
        obs.next({ type: RunCommandEventEnum.NODE_STARTED, workspace });
        console.debug('Running command for', workspace.name);
        workspace.run(cmd, force, args, stdio)
          .then((result) => {
            console.debug('Output for', workspace.name, ':', result.commands[0].all);
            // If result does not come from cache, that means source have changed and we must invalidate cache of every subsequent node
            if (mode === 'topological' && !result.fromCache) {
              Runner._invalidateSubsequentWorkspaceCache(targets, target, cmd).finally(() => {
                obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
              });
            } else {
              obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
            }
          }).catch((error) => {
          // If an error occurs invalidate cache from node (and subsequent if topological)
          console.debug('Error for', workspace.name, ':', error.all);
          console.debug({ mode });
          if (mode === 'topological') {
            console.debug('Invalidating cache');
            Runner._invalidateSubsequentWorkspaceCache(targets, target, cmd)
              .catch((err) => {
                console.debug(err);
              })
              .finally(() => {
              console.debug('Emitting error');
              obs.error({ type: RunCommandEventEnum.NODE_ERRORED, error, workspace })
            });
          } else {
            workspace.invalidate(cmd).finally(() => {
              obs.next({ type: RunCommandEventEnum.NODE_ERRORED, error, workspace })
            })
          }
        }).finally(() => {
          obs.complete();
        });
      } else {
        obs.next({ type: RunCommandEventEnum.NODE_SKIPPED, ...target });
        obs.complete();
      }
    });
  }

  private static async _invalidateSubsequentWorkspaceCache(targets: IResolvedTarget[][], current: IResolvedTarget, cmd: string): Promise<void> {
    const invalidate$: Array<Promise<void>> = [];
    let isAfterCurrent = false;
    for (const step of targets) {
      if (step.includes(current)) {
        isAfterCurrent = true;
      }
      if (isAfterCurrent) {
        invalidate$.push(...step.map((t) => t.workspace.invalidate(cmd)));
      }
    }
    await Promise.all(invalidate$);
  }
}
