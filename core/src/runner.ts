import { concat, debounceTime, from, Observable, of, Subject } from "rxjs";
import { catchError, concatAll, concatMap, map, mergeAll, takeUntil } from "rxjs/operators";
import {
  IErrorInvalidatingCacheEvent,
  IProcessResult,
  IResolvedTarget,
  IRunCommandErrorEvent,
  RunCommandEvent,
  RunCommandEventEnum
} from "./process";
import { Project } from "./project";
import { Workspace } from "./workspace";
import { OrderedTargets, TargetsResolver } from "./targets";
import { ICacheOptions } from "./cache";
import { Watcher } from "./watcher";

export interface ICommonRunOptions{
  mode: 'parallel' | 'topological';
  force: boolean;
  affected?: { rev1: string, rev2: string};
  stdio?: 'pipe' | 'inherit';
  watch?: boolean;
}

export interface ITopologicalRunOptions extends ICommonRunOptions {
  mode: 'topological';
  to?: Workspace;
}

export interface IParallelRunOptions extends ICommonRunOptions {
  mode: 'parallel';
  workspaces?: Workspace[];
}

type FailedExecution =  { status: 'ko', error: unknown, target: IResolvedTarget};
type SucceededExecution = {status: 'ok', result: IProcessResult, target: IResolvedTarget };
type CaughtProcessExecution =  SucceededExecution | FailedExecution;

const isFailedExecution = (execution: CaughtProcessExecution): execution is FailedExecution => { return execution.status === 'ko' }

const isRunCommandErroredEvent = (error: unknown): error is RunCommandEvent => {
  const _error = error as (IRunCommandErrorEvent | IErrorInvalidatingCacheEvent);
  return (_error.type === RunCommandEventEnum.ERROR_INVALIDATING_CACHE || _error.type === RunCommandEventEnum.NODE_ERRORED) && !!_error.workspace;
}

export type RunOptions = IParallelRunOptions | ITopologicalRunOptions;

export const isTopological = (options: RunOptions): options is ITopologicalRunOptions => options.mode === 'topological';

export class Runner {

  constructor(
    private readonly _project: Project,
    private readonly _concurrency: number = 4,
    private readonly _cacheOptions: ICacheOptions = {},
  ) {}

  /**/

  private _scheduleTasks(
    cmd: string,
    targets: OrderedTargets,
    options: RunOptions,
    args: string[] | string = [],
    env: {[key: string]: string} = {}
  ): Observable<RunCommandEvent> {
    console.debug('Schedule tasks');
    const steps$ = targets.map((step) => this._runStep(step, targets, cmd, options.force, options.mode, args, options.stdio, env));
    return from(steps$).pipe(concatAll());
  }

  runCommand(cmd: string, options: RunOptions, args: string[] | string = [], env: {[key: string]: string} = {}, watch = false, debounce = 1000): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      const targets = new TargetsResolver(this._project);
      targets.resolve(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets: targets.flat() });
        if (!targets.length) {
          return obs.complete();
        }
        if (!watch) {
          const tasks$ = this._scheduleTasks(cmd, targets, options, args, env);
          tasks$.subscribe(
            (evt) => obs.next(evt),
            (err) => obs.error(err),
            () => obs.complete(),
          )
        } else {
          console.debug('Running target', cmd, 'in watch mode');
          let currentTasks$ = this._scheduleTasks(cmd, targets, options, args, env);
          const watcher = new Watcher(targets, cmd, debounce);
          const shouldAbort$ = new Subject<void>();
          const sourcesChange$ = watcher.watch();
          console.debug('Watching sources');
          let currentStep: IResolvedTarget[] | undefined;
          const isBeforeOrEqualsCurrentStep = (impactedStep: IResolvedTarget[] | undefined) => {
            if(!currentStep || !impactedStep) {
              return false;
            }
            return targets.indexOf(impactedStep) <= targets.indexOf(currentStep);
          }
          const _workspaceWithRunningProcesses = new Set<Workspace>();
          const executeCurrentTasks = () => {
            console.debug('Executing current tasks');
            currentTasks$.pipe(takeUntil(shouldAbort$)).subscribe((evt) => {
              switch (evt.type) {
                case RunCommandEventEnum.NODE_STARTED:
                  currentStep = targets.find((step) => step.some((target) => target.workspace.name === evt.workspace.name));
                  if (currentStep) {
                    console.debug('Current step updated', targets.indexOf(currentStep));
                  }
                  _workspaceWithRunningProcesses.add(evt.workspace);
                  break;
                case RunCommandEventEnum.NODE_PROCESSED:
                case RunCommandEventEnum.NODE_ERRORED:
                  _workspaceWithRunningProcesses.delete(evt.workspace);
                  break;
              }
              obs.next(evt);
            }, (err) => {
              obs.error(err);
            }, () => {
              console.debug('Current tasks executed watching for changes');
            });
          }
          shouldAbort$.subscribe(() => {
            console.log('TODO: Kill impacted processes');
            // If current step is impacted step, only kill impacted target
            _workspaceWithRunningProcesses.forEach((workspace) => {
              obs.next({ type: RunCommandEventEnum.NODE_INTERRUPTED, workspace })
              workspace.killAll(cmd);
            });
            // If previous kill all targets running
          });
          sourcesChange$.pipe(debounceTime(debounce)).subscribe((change) => {
            console.debug('Source changed', change.target.workspace.name);
            const impactedTarget = change.target;
            obs.next({ type: RunCommandEventEnum.SOURCES_CHANGED, ...change })
            console.debug('Impacted target', change.target.workspace.name);
            const impactedStep = targets.find((step) => step.some((t) => t.workspace.name === impactedTarget.workspace.name));
            if (impactedStep) {
              console.debug('Impacted step updated', targets.indexOf(impactedStep));
            }
            if (isBeforeOrEqualsCurrentStep(impactedStep)) {
              console.debug('Impacted step before or same than current step. Should abort')
              shouldAbort$.next();
              // TODO: Reschedule only tasks impacted
              currentTasks$ = this._scheduleTasks(cmd, targets, options, args, env);
              console.debug('Current tasks updated');
              executeCurrentTasks();
            }
          });
          executeCurrentTasks();
        }
      });
    });
  }

  private _runStep(
    step: IResolvedTarget[],
    targets: OrderedTargets,
    cmd: string,
    force: boolean,
    mode: 'topological' | 'parallel',
    args: string[] | string = [],
    stdio: 'pipe' | 'inherit' = 'pipe',
    env: {[key: string]: string} = {}
  ): Observable<RunCommandEvent> {
    const executions = new Set<CaughtProcessExecution>();
    console.log('Running step', targets.indexOf(step));
    const tasks$ = step.map((w) => Runner._runForWorkspace(executions, w, cmd, force, mode, args, stdio, env, this._cacheOptions));
    const step$ = from(tasks$).pipe(
      mergeAll(this._concurrency),
    );
    return new Observable<RunCommandEvent>((obs) => {
      const resolveInvalidations$ = (): Observable<RunCommandEvent> => {
        // When execution step is completed or errored, perform required cache invalidations
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
        return from(invalidations$).pipe(concatAll())
      }
      step$.subscribe(
        (evt) => obs.next(evt),
        (err) => {
          if (isRunCommandErroredEvent(err)) {
            obs.next(err);
          }
          resolveInvalidations$().subscribe(
            (next) => obs.next(next),
            (error) => {
              if (isRunCommandErroredEvent(error)) {
                obs.next(error);
              }
              obs.error(error);
            },
            () => obs.error(err),
          );
        },
        () => {
          resolveInvalidations$().subscribe(
            (next) => obs.next(next),
            (error) => {
              if (isRunCommandErroredEvent(error)) {
                obs.next(error);
              }
              obs.error(error);
            },
            () => obs.complete(),
          );
        }
      )
    })
  }

  private static _runForWorkspace(
    executions: Set<CaughtProcessExecution>,
    target: IResolvedTarget,
    cmd: string,
    force: boolean,
    mode: 'topological' | 'parallel',
    args: string[] | string = [],
    stdio: 'pipe' | 'inherit' = 'pipe',
    env: {[key: string]: string} = {},
    cacheOptions: ICacheOptions = {},
  ): Observable<RunCommandEvent> {
    if (target.affected && target.hasCommand) {
      const started$: Observable<RunCommandEvent>  = of({ type: RunCommandEventEnum.NODE_STARTED, workspace: target.workspace });
      const execute$: Observable<RunCommandEvent> = Runner._executeCommandCatchingErrors(target, cmd, force, args, stdio, env, cacheOptions).pipe(
        concatMap((result) => Runner._mapToEventsAndInvalidateCacheIfNecessary(executions, result, target, mode)),
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
    env: {[key: string]: string} = {},
    cacheOptions: ICacheOptions = {},
  ) : Observable<CaughtProcessExecution>{
    const command$ = target.workspace.run(cmd, force, args, stdio, env, cacheOptions);
    return command$.pipe(
      map((result) => ({ status: 'ok' as const, result, target })),
      catchError((error) => of({ status: 'ko' as const, error, target })),
    );
  }

  private static _mapToEventsAndInvalidateCacheIfNecessary(
    executions: Set<CaughtProcessExecution>,
    execution: CaughtProcessExecution,
    target: IResolvedTarget,
    mode: 'topological' | 'parallel',
  ): Observable<RunCommandEvent> {
    return new Observable<RunCommandEvent>((obs) => {
      executions.add(execution);
      const workspace = target.workspace;
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
