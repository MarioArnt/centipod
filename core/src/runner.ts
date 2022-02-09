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
import { TargetsResolver } from './targets';

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

  private _scheduleTasks(cmd: string, targets: IResolvedTarget[], options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    if (isTopological(options)) {
      return from(targets.map((w) => this._runForWorkspace(targets, w, cmd, options.force, 'topological', args, options.stdio))).pipe(concatAll());
    } else {
      return from(targets.map((w) => this._runForWorkspace(targets, w, cmd, options.force, 'parallel', args, options.stdio))).pipe(mergeAll(this._concurrency));
    }
  }

  runCommand(cmd: string, options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      const targets = new TargetsResolver(this._project);
      targets.resolve(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets });
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

  private _runForWorkspace(targets: IResolvedTarget[], target: IResolvedTarget, cmd: string, force: boolean, mode: 'topological' | 'parallel', args: string[] | string = [], stdio: 'pipe' | 'inherit' = 'pipe'): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      const workspace = target.workspace;
      if (target.affected && target.hasCommand) {
        obs.next({ type: RunCommandEventEnum.NODE_STARTED, workspace });
        workspace.run(cmd, force, args, stdio)
          .then((result) => {
            // If result does not come from cache, that means source have changed and we must invalidate cache of every subsequent node
            if (mode === 'topological' && !result.fromCache) {
              Runner._invalidateSubsequentWorkspaceCache(targets, target, cmd).then(() => {
                obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
              });
            } else {
              obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace });
            }
          }).catch((error) => {
          Promise.all(targets.map(t => t.workspace.invalidate(cmd))).finally(() => {
            obs.next({ type: RunCommandEventEnum.NODE_ERRORED, error, workspace })
          });
        }).finally(() => {
          obs.complete();
        });
      } else {
        obs.next({ type: RunCommandEventEnum.NODE_SKIPPED, ...target });
        obs.complete();
      }
    });
  }

  private static async _invalidateSubsequentWorkspaceCache(targets: IResolvedTarget[], target: IResolvedTarget, cmd: string): Promise<void> {
    const invalidate$: Array<Promise<void>> = [];
    for (let idx = targets.indexOf(target); idx < targets.length; idx++) {
      invalidate$.push(targets[idx].workspace.invalidate(cmd));
    }
    await Promise.all(invalidate$);
  }
}
