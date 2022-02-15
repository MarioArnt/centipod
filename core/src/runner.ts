import { concat, from, Observable, of } from 'rxjs';
import { catchError, concatAll, concatMap, map, mergeAll } from 'rxjs/operators';
import { IProcessResult, IResolvedTarget, RunCommandEvent, RunCommandEventEnum } from './process';
import { Project } from './project';
import { Workspace } from './workspace';
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

type FailedExecution =  { status: 'ko', error: unknown, target: IResolvedTarget};
type SucceededExecution = {status: 'ok', result: IProcessResult, target: IResolvedTarget };
type CaughtProcessExecution =  SucceededExecution | FailedExecution;

const isFailedExecution = (execution: CaughtProcessExecution): execution is FailedExecution => { return execution.status === 'ko' }

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
    const steps$ = targets.map((step) => this._runStep(step, targets, cmd, options.force, options.mode, args, options.stdio));
    return from(steps$).pipe(concatAll());
  }

  runCommand(cmd: string, options: RunOptions, args: string[] | string = []): Observable<RunCommandEvent> {
    console.debug('OBSERVABLE DEFINED');
    return new Observable((obs) => {
      console.debug('OBSERVABLE SUBSCRIBED');
      const targets = new TargetsResolver(this._project);
      console.debug('RESOLVING TARGETS');
      targets.resolve(cmd, options).then((targets) => {
        console.debug('TARGETS RESOLVED');
        // TODO: Validate configurations for each targets
        console.debug('targets resolved', targets);
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets: targets.flat() });
        if (!targets.length) {
          return obs.complete();
        }
        const tasks$ = this._scheduleTasks(cmd, targets, options, args);
        console.debug('Tasks scheduled', tasks$);
        tasks$.subscribe(
          (evt) => obs.next(evt),
          (err) => obs.error(err),
          () => obs.complete(),
        )
      })
    });
  }

  private _runStep(
    step: IResolvedTarget[],
    targets: OrderedTargets,
    cmd: string,
    force: boolean,
    mode: 'topological' | 'parallel',
    args: string[] | string = [],
    stdio: 'pipe' | 'inherit' = 'pipe'
  ): Observable<RunCommandEvent> {
    const executions = new Set<CaughtProcessExecution>();
    const tasks$ = step.map((w) => Runner._runForWorkspace(executions, targets, w, cmd, force, mode, args, stdio));
    const step$ = from(tasks$).pipe(
      mergeAll(this._concurrency),
    );
    return new Observable<RunCommandEvent>((obs) => {
      step$.subscribe(
        (evt) => obs.next(evt),
        (err) => obs.error(err),
        () => {
          console.debug('STEP COMPLETED', executions);
          // When execution step is completed, performed required cache invalidations
          // Invalidate cache of every errored nodes
          const invalidations$: Array<Observable<RunCommandEvent>> = [];
          let hasAtLeastOneError = false;
          let cachedInvalidated = false;
          let current: IResolvedTarget | null = null;
          for (const execution of executions) {
            current = execution.target;
            if (isFailedExecution(execution)) {
              hasAtLeastOneError = true;
              invalidations$.push(Runner._invalidateCache(execution.target.workspace, cmd));
            } else if (!execution.result.fromCache) {
              cachedInvalidated = true;
            }
          }
          // In topological mode, if an error happened during the step
          // or a cache has been invalidated invalidate all ancestors cache.
          if (mode === 'topological' && (hasAtLeastOneError || cachedInvalidated) && current) {
            invalidations$.push(Runner._invalidateSubsequentWorkspaceCache(targets, current, cmd));
          }
          from(invalidations$).pipe(concatAll()).subscribe(
            (next) => obs.next(next),
            (error) => obs.error(error),
            () => obs.complete(),
          );
        }
      )
    })
  }

  private static _runForWorkspace(
    executions: Set<CaughtProcessExecution>,
    targets: OrderedTargets,
    target: IResolvedTarget,
    cmd: string,
    force: boolean,
    mode: 'topological' | 'parallel',
    args: string[] | string = [],
    stdio: 'pipe' | 'inherit' = 'pipe'
  ): Observable<RunCommandEvent> {
    if (target.affected && target.hasCommand) {
      const started$: Observable<RunCommandEvent>  = of({ type: RunCommandEventEnum.NODE_STARTED, workspace: target.workspace });
      const execute$: Observable<RunCommandEvent> = Runner._executeCommandCatchingErrors(target, cmd, force, args, stdio).pipe(
        concatMap((result) => Runner._mapToEventsAndInvalidateCacheIfNecessary(executions, result, targets, target, cmd, mode)),
      );
      return concat(
        started$,
        execute$,
      );
    }
    return of({ type: RunCommandEventEnum.NODE_SKIPPED, ...target });
  }

  private static _executeCommandCatchingErrors(
    target: IResolvedTarget,
    cmd: string,
    force: boolean,
    args: string[] | string = [],
    stdio: 'pipe' | 'inherit' = 'pipe',
  ) : Observable<CaughtProcessExecution>{
    console.log({ cmd, force, args, stdio })
    const command$ = target.workspace.runObs(cmd, force, args, stdio);
    console.log(command$);
    return command$.pipe(
      map((result) => ({ status: 'ok' as const, result, target })),
      catchError((error) => of({ status: 'ko' as const, error, target })),
    );
  }

  private static _mapToEventsAndInvalidateCacheIfNecessary(
    executions: Set<CaughtProcessExecution>,
    execution: CaughtProcessExecution,
    targets: OrderedTargets,
    target: IResolvedTarget,
    cmd: string,
    mode: 'topological' | 'parallel',
  ): Observable<RunCommandEvent> {
    return new Observable<RunCommandEvent>((obs) => {
      executions.add(execution);
      const workspace = target.workspace;
      console.debug({
        execution, targets, target, cmd, mode,
      })
      if (execution.status === 'ok') {
        const result = execution.result;
        obs.next({ type: RunCommandEventEnum.NODE_PROCESSED, result, workspace: workspace });
        obs.complete();
      } else  if (mode === 'topological') {
        obs.error({ type: RunCommandEventEnum.NODE_ERRORED, error: execution.error, workspace });
        obs.complete();
      } else {
        obs.next({ type: RunCommandEventEnum.NODE_ERRORED, error: execution.error, workspace });
        obs.complete();
      }
    });
  }

  private static _invalidateCache(workspace: Workspace, cmd: string): Observable<RunCommandEvent> {
    return new Observable<RunCommandEvent>((obs) => {
      workspace.invalidate(cmd)
        .then(() => obs.next({ type: RunCommandEventEnum.CACHE_INVALIDATED, workspace }))
        .catch((error) => obs.error({ type: RunCommandEventEnum.ERROR_INVALIDATING_CACHE, workspace, error}))
        .finally(() => obs.complete());
    });
  }

  private static _invalidateSubsequentWorkspaceCache(targets: IResolvedTarget[][], current: IResolvedTarget, cmd: string): Observable<RunCommandEvent> {
    const invalidate$: Array<Observable<RunCommandEvent>> = [];
    let isAfterCurrent = false;
    for (const step of targets) {
      if (isAfterCurrent) {
        invalidate$.push(...step.map((t) => Runner._invalidateCache(t.workspace, cmd)));
      }
      if (step.includes(current)) {
        isAfterCurrent = true;
      }
    }
    return from(invalidate$).pipe(mergeAll());
  }
}
