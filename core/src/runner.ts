import { concat, from, Observable, of, Subject } from "rxjs";
import { catchError, concatAll, concatMap, map, mergeAll, takeUntil } from "rxjs/operators";
import {
  IErrorInvalidatingCacheEvent,
  IProcessResult,
  IResolvedTarget,
  IRunCommandErrorEvent,
  RunCommandEvent,
  RunCommandEventEnum, Step
} from "./process";
import { Project } from "./project";
import { Workspace } from "./workspace";
import { OrderedTargets, TargetsResolver } from "./targets";
import { ICacheOptions } from "./cache";
import { Watcher } from "./watcher";
import { IAbstractLogger, IAbstractLoggerFunctions } from "./logger";

export interface ICommonRunOptions{
  mode: 'parallel' | 'topological';
  force: boolean;
  affected?: { rev1: string, rev2: string};
  stdio?: 'pipe' | 'inherit';
  watch?: boolean;
}

export interface ITopologicalRunOptions extends ICommonRunOptions {
  mode: 'topological';
  to?: Workspace[];
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

interface StepCompletedEvent {
  type: 'STEP_COMPLETED',
}

const isStepCompletedEvent = (evt: RunCommandEvent | StepCompletedEvent): evt is StepCompletedEvent => {
  return evt.type === 'STEP_COMPLETED';
}

export class Runner {
  private _watchers = new Map<string, { watcher: Watcher, abort: Subject<void>}>();
  private _logger: IAbstractLoggerFunctions | undefined;

  constructor(
    private readonly _project: Project,
    private readonly _concurrency: number = 4,
    private readonly _cacheOptions: ICacheOptions = {},
    logger?: IAbstractLogger,
  ) {
    this._logger = logger?.log('@centipod/core/runner');
  }

  /**/

  private _scheduleTasks(
    cmd: string,
    targets: OrderedTargets,
    options: RunOptions,
    args: string[] | string = [],
    env: {[key: string]: string} = {}
  ): Observable<RunCommandEvent | StepCompletedEvent> {
    this._logger?.debug('Schedule tasks', { cmd });
    const steps$ = targets.map((step) => this._runStep(step, targets, cmd, options.force, options.mode, args, options.stdio, env));
    return from(steps$).pipe(concatAll());
  }

  private _rescheduleTasks(cmd: string, currentStep: IResolvedTarget[], impactedTargets: Set<Workspace>, targets: OrderedTargets, options: RunOptions, args: string[] | string, env: { [p: string]: string }) {
    this._logger?.debug('Rescheduling from step', targets.indexOf(currentStep))
    const subsequentSteps$ = targets
      .filter((step) => {
        return targets.indexOf(step) >= targets.indexOf(currentStep);
      })
      .map((step) => {
        this._logger?.debug('Scheduling step', targets.indexOf(step));
        if (targets.indexOf(step) === targets.indexOf(currentStep)) {
          this._logger?.debug('Ignoring non-impacted targets, impacted targets are', Array.from(impactedTargets).map(w => w.name));
          return this._runStep(step, targets, cmd, options.force, options.mode, args, options.stdio, env, impactedTargets);
        }
        return this._runStep(step, targets, cmd, options.force, options.mode, args, options.stdio, env);
      });
    return from(subsequentSteps$).pipe(concatAll());
  }

  unwatch(cmd: string) {
    this._logger?.debug('Un-watching command', cmd);
    this._watchers.get(cmd)?.watcher.unwatch();
    this._watchers.get(cmd)?.abort.next();
  }

  runCommand(cmd: string, options: RunOptions, args: string[] | string = [], env: {[key: string]: string} = {}, watch = false, debounce = 1000): Observable<RunCommandEvent> {
    return new Observable((obs) => {
      this._logger?.info('Resolving for command', cmd);
      const targets = new TargetsResolver(this._project, this._logger?.logger);
      targets.resolve(cmd, options).then((targets) => {
        // TODO: Validate configurations for each targets
        this._logger?.info('Targets resolved for command', cmd, targets.map(s => s.map(t => t.workspace.name)));
        obs.next({ type: RunCommandEventEnum.TARGETS_RESOLVED, targets: targets.flat() });
        if (!targets.length) {
          this._logger?.info('No eligible targets found for command', cmd)
          return obs.complete();
        }
        if (!watch) {
          const tasks$ = this._scheduleTasks(cmd, targets, options, args, env);
          this._logger?.info('Tasks scheduled for command', cmd)
          tasks$.subscribe({
            next: (evt) => {
              if (!isStepCompletedEvent(evt)) {
                obs.next(evt);
              }
            },
            error: (err) => obs.error(err),
            complete: () => obs.complete()
          })
        } else {
          this._logger?.info('Running target', cmd, 'in watch mode');
          let currentTasks$ = this._scheduleTasks(cmd, targets, options, args, env);
          const watcher = new Watcher(targets, cmd, debounce);
          const shouldAbort$ = new Subject<void>();
          const shouldReschedule$ = new Subject<Step>();
          const shouldKill$ = new Subject<Workspace | Step>();
          const sourcesChange$ = watcher.watch();
          this._watchers.set(cmd, { watcher, abort: shouldAbort$ });
          this._logger?.debug('Watching sources');
          let currentStep: IResolvedTarget[] | undefined;
          const isBeforeCurrentStep = (impactedStep: IResolvedTarget[] | undefined) => {
            if(!currentStep || !impactedStep) {
              return false;
            }
            return targets.indexOf(impactedStep) < targets.indexOf(currentStep);
          }
          const isEqualsCurrentStep = (impactedStep: IResolvedTarget[] | undefined) => {
            if(!currentStep || !impactedStep) {
              return false;
            }
            return targets.indexOf(impactedStep) === targets.indexOf(currentStep);
          }
          let letFinishStepAndAbort = false;
          let allProcessed = false;
          const _workspaceWithRunningProcesses = new Set<Workspace>();
          let workspaceProcessed = new Set<Workspace>();
          let impactedTargets = new Set<Workspace>();
          let killed = new Set<Workspace>();
          const executeCurrentTasks = () => {
            // Clear all re-scheduled workspaces but not others
            allProcessed = false;
            letFinishStepAndAbort = false;
            impactedTargets.forEach((w) => {
              workspaceProcessed.delete(w)
            });
            impactedTargets.clear();
            killed.clear();
            this._logger?.debug('New current tasks execution');
            this._logger?.debug('Reset impacted targets');
            this._logger?.debug('Reset killed targets');
            this._logger?.debug('Removing impacted targets from processed ', {
              processed: Array.from(workspaceProcessed).map((w) => w.name)
            });
            currentTasks$.pipe(takeUntil(shouldAbort$)).subscribe((evt) => {
              switch (evt.type) {
                case RunCommandEventEnum.NODE_STARTED:
                  currentStep = targets.find((step) => step.some((target) => target.workspace.name === evt.workspace.name));
                  if (currentStep) {
                    this._logger?.debug('Current step updated', targets.indexOf(currentStep));
                  }
                  _workspaceWithRunningProcesses.add(evt.workspace);
                  this._logger?.debug('Setting node as processing', evt.workspace.name);
                  this._logger?.debug({ processing: Array.from(_workspaceWithRunningProcesses).map((w) => w.name)});
                  break;
                case RunCommandEventEnum.NODE_PROCESSED:
                case RunCommandEventEnum.NODE_ERRORED:
                  _workspaceWithRunningProcesses.delete(evt.workspace);
                  workspaceProcessed.add(evt.workspace);
                  this._logger?.debug('Setting node as processed', evt.workspace.name);
                  this._logger?.debug({
                    processing: Array.from(_workspaceWithRunningProcesses).map((w) => w.name),
                    processed: Array.from(workspaceProcessed).map((w) => w.name)
                  });
                  break;
              }
              if (evt.type === RunCommandEventEnum.NODE_PROCESSED && killed.has(evt.workspace)) {
                this._logger?.debug('Node killed not forwarding processed event', evt.workspace.name);
              } else if (!isStepCompletedEvent(evt)) {
                obs.next(evt);
              } else if (letFinishStepAndAbort) {
                letFinishStepAndAbort = false;
                shouldAbort$.next();
                shouldReschedule$.next(currentStep!);
              }
            }, (err) => {
              obs.error(err);
            }, () => {
              this._logger?.debug('Current tasks executed watching for changes');
              allProcessed = true;
            });
          }
          shouldReschedule$.subscribe((fromStep) => {
            if (!currentStep) {
              throw Error('Assertion failed: current step not resolved in interruption !')
            }
            this._logger?.debug('Interruption has been received in previous step, re-scheduling');
            currentTasks$ = this._rescheduleTasks(cmd, fromStep, impactedTargets, targets, options, args, env);
            this._logger?.debug('Current tasks updated');
            executeCurrentTasks();
          })
          shouldKill$.subscribe((workspaceOrStep) => {
            const workspaces = Array.isArray(workspaceOrStep) ? workspaceOrStep.map((t) => t.workspace) : [workspaceOrStep];
            for (const workspace of workspaces) {
              this._logger?.info('Kill impacted processes if running', workspace.name);
              if (_workspaceWithRunningProcesses.has(workspace)) {
                this._logger?.info('Kill impacted processes', workspace.name);
                obs.next({ type: RunCommandEventEnum.NODE_INTERRUPTED, workspace });
                killed.add(workspace);
                workspace.kill(cmd);
              }
              if (allProcessed && letFinishStepAndAbort) {
                this._logger?.debug('All node processed and interruption received, rescheduling immediately');
                shouldReschedule$.next(currentStep!);
              }
            }
          });
          sourcesChange$.subscribe((changes) => {
            for (const change of changes) {
              this._logger?.debug('Source changed', change.target.workspace.name);
              const impactedTarget = change.target;
              obs.next({ type: RunCommandEventEnum.SOURCES_CHANGED, ...change })
              this._logger?.debug('Impacted target', change.target.workspace.name);
              const impactedStep = targets.find((step) => step.some((t) => t.workspace.name === impactedTarget.workspace.name));
              if (impactedStep) {
                this._logger?.debug('Impacted step updated', targets.indexOf(impactedStep));
              }
              const isProcessed = workspaceProcessed.has(change.target.workspace);
              const isProcessing = _workspaceWithRunningProcesses.has(change.target.workspace);
              const hasNotStartedYet = !(isProcessed || isProcessing);
              this._logger?.debug({ isBefore: isBeforeCurrentStep(impactedStep), isEqual: isEqualsCurrentStep(impactedStep), hasStarted: !hasNotStartedYet, isProcessed, isProcessing })
              if (isEqualsCurrentStep(impactedStep) && !hasNotStartedYet) {
                impactedTargets.add(change.target.workspace);
                this._logger?.debug('Impacted step is same than current step. Should abort after current step execution');
                letFinishStepAndAbort = true;
                shouldKill$.next(change.target.workspace);
              } else if (isBeforeCurrentStep(impactedStep)) {
                this._logger?.debug('Impacted step before current step. Should abort immediately');
                shouldAbort$.next();
                impactedTargets.add(change.target.workspace);
                letFinishStepAndAbort = false;
                shouldKill$.next(currentStep!);
                shouldReschedule$.next(impactedStep!);
              }
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
    env: {[key: string]: string} = {},
    only?: Set<Workspace>,
  ): Observable<RunCommandEvent | StepCompletedEvent> {
    const executions = new Set<CaughtProcessExecution>();
    this._logger?.info('Preparing step', targets.indexOf(step), { cmd });
    const tasks$ = step
      .filter((w) => !only || only.has(w.workspace))
      .map((w) => Runner._runForWorkspace(executions, w, cmd, force, mode, args, stdio, env, this._cacheOptions));
    const step$ = from(tasks$).pipe(
      mergeAll(this._concurrency),
    );
    return new Observable<RunCommandEvent | StepCompletedEvent>((obs) => {
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
            () => {
              obs.next({ type: 'STEP_COMPLETED' });
              obs.complete();
            },
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
