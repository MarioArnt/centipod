// Class
import {Project} from './project';
import {promises as fs} from 'fs';
import {join, relative} from 'path';
import {INpmInfos, Package} from './package';
import {git} from './git';
import {sync as glob} from 'fast-glob';
import { command, ExecaChildProcess, ExecaError, ExecaReturnValue } from "execa";
import { ICommandConfig, IConfig, ILogsCondition, loadConfig } from "./config";
import {
  CommandResult,
  ICommandResult,
  IDaemonCommandResult,
  IProcessResult,
  isDaemon,
} from "./process";
import { Cache, ICacheOptions } from "./cache";
import {Publish, PublishActions, PublishEvent} from './publish';
import { Observable, race, throwError } from "rxjs";
import {CentipodError, CentipodErrorCode} from './error';
import semver from 'semver';
import { catchError, finalize } from "rxjs/operators";
import Timer = NodeJS.Timer;
import debug from 'debug';
import { AbstractLogsHandler, ILogsHandler } from "./logs-handler";

const TWO_MINUTES = 2 * 60 * 1000;
const DEFAULT_DAEMON_TIMEOUT = TWO_MINUTES;

export class Workspace {
  // Constructor
  constructor(
    readonly pkg: Package,
    readonly root: string,
    protected readonly _config: IConfig,
    readonly project?: Project
  ) {}

  // Statics
  static async loadPackage(root: string): Promise<Package> {
    const file = join(root, 'package.json');
    const data = await fs.readFile(file, 'utf-8');
    return JSON.parse(data);
  }

  static async loadWorkspace(root: string, project?: Project): Promise<Workspace> {
    return new Workspace(await this.loadPackage(root), root, await this.loadConfig(root), project);
  }

  static async loadConfig(root: string): Promise<IConfig> {
    const file = join(root, 'centipod.json');
    return loadConfig(file);
  }

  // Methods
  *dependencies(): Generator<Workspace, void> {
    if (!this.project) {
      throw new CentipodError(CentipodErrorCode.PROJECT_NOT_RESOLVED, `Cannot load dependencies of workspace ${this.name}: loaded outside of a project`)
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

  get descendants(): Map<string, Workspace> {
    const descendants = new Map<string, Workspace>();
    const visitWorkspace = (wks: Workspace): void => {
      for (const dep of wks.dependencies()) {
        visitWorkspace(dep);
        descendants.set(dep.name, dep);
      }
    }
    visitWorkspace(this);
    return descendants;
  }

  get ancestors(): Map<string, Workspace> {
    const ancestors = new Map<string, Workspace>();
    if (!this.project) {
      throw new CentipodError(CentipodErrorCode.PROJECT_NOT_RESOLVED, `Cannot load dependencies of workspace ${this.name}: loaded outside of a project`)
    }
    for (const workspace of this.project.workspaces.values()) {
      if (workspace === this) continue;
      if (workspace.descendants.has(this.name)) ancestors.set(workspace.name, workspace);
    }
    return ancestors;
  }

  // Properties
  get config(): IConfig {
    return this._config;
  }

  get name(): string {
    return this.pkg.name;
  }

  get private(): boolean {
    return this.pkg.private === true;
  }

  get version(): string | undefined {
    return this.pkg.version;
  }

  private _publish: Publish | undefined;
  private _npmInfos: INpmInfos | undefined;

  private async _testAffected(rev1: string, rev2?: string, patterns: string[] = ['**']): Promise<boolean> {
    // Compute diff
    const diffs = rev2
      ? await git.diff('--name-only', rev1, rev2, '--', this.root)
      : await git.diff('--name-only', rev1, '--', this.root);

    // No pattern
    if (patterns.length === 0 && patterns[0] === '**') {
      return diffs.length > 0;
    }

    const rel = relative(git.root, this.root);
    const files = patterns.map((pattern) => glob(join(rel, pattern))).reduce((acc, val) => acc = acc.concat(val), []);
    return diffs.some((diff) => files.includes(diff));
  }

  private async _testDepsAffected(tested: Set<Workspace>,rev1: string, rev2?: string, patterns: string[] = ['**']): Promise<boolean> {
    tested.add(this);

    // Test if is affected
    const affected = await this._testAffected(rev1, rev2, patterns);
    if (affected) return true;

    // Test dependencies if are affected
    for (const dep of this.dependencies()) {
      // Check if already tested
      if (tested.has(dep)) continue;

      // Test
      const affected = await dep._testDepsAffected(tested, rev1, rev2, patterns);
      if (affected) return true;
    }

    return false;
  }

  private static async _checkRevision(rev: string): Promise<void> {
    const isValid = await git.revisionExists(rev);
    if (!isValid) {
      throw new CentipodError(CentipodErrorCode.BAD_REVISION, `Bad revision: ${rev}`);
    }
  }

  private static async _checkRevisions(rev1: string, rev2?: string): Promise<void> {
    await Workspace._checkRevision(rev1);
    if (rev2) {
      await Workspace._checkRevision(rev2);
    }
  }

  async isAffected(rev1: string, rev2?: string, patterns: string[] = ['**'], topological = true): Promise<boolean> {
    await Workspace._checkRevisions(rev1, rev2);
    if (!topological) {
      return await this._testAffected(rev1, rev2, patterns);
    }
    return await this._testDepsAffected(new Set(), rev1, rev2, patterns);
  }

  hasCommand(cmd: string): boolean {
    return !!this.config[cmd];
  }

  private async _handleDaemon<T = string>(
    daemonConfig: ILogsCondition | ILogsCondition[],
    cmdProcess: ExecaChildProcess,
    startedAt: number,
  ): Promise<IDaemonCommandResult> {
    const logsConditions = Array.isArray(daemonConfig) ? daemonConfig : [daemonConfig];
    let killed = false;
    const crashed$ = new Observable<IDaemonCommandResult>((obs) => {
      cmdProcess.catch((crashed) => {
        if (!killed) {
          debug('centipod/run')('Daemon crashed');
          obs.error(crashed);
        }
      });
    });
    debug('centipod/run')('Verifying logs conditions');
    const timers: Timer[] = [];
    const logsConditionsMet$ = logsConditions.map((condition) => new Observable<IDaemonCommandResult>((obs) => {
      const logStream = cmdProcess[condition.stdio];
      if (!logStream) {
        return obs.error('Log stream not readable, did you try to run a daemon cmd using stdio inherit ?')
      }
      const timeout = condition.timeout || DEFAULT_DAEMON_TIMEOUT;
      const timer = setTimeout(() => obs.error(`Timeout (${timeout}ms) for log condition exceeded`), timeout);
      timers.push(timer);
      logStream.on('data', (chunk: string | Buffer) => {
        debug('centipod/run')('[child process]', chunk.toString());
        if (condition.matcher === 'contains' && chunk.toString().includes(condition.value)) {
          debug('centipod/run')('Condition resolved for', condition);
          clearTimeout(timer);
          if (condition.type === 'success') {
            obs.next({daemon: true, process: cmdProcess, took: Date.now() - startedAt});
            return obs.complete();
          }
          return obs.error(`Log condition explicitly failed : ${JSON.stringify(condition)}`);
        }
      });
    }));

    const race$ = race(...logsConditionsMet$, crashed$).pipe(
      catchError((e) => {
        debug('centipod/run')('Error happened, killing process');
        killed = true;
        cmdProcess.kill();
        debug('centipod/run')('Rethrow', e);
        return throwError(e);
      }),
      finalize(() => {
        debug('centipod/run')('Flushing timers');
        timers.forEach((timer) => clearTimeout(timer));
      })
    )
    return new Promise<IDaemonCommandResult>((resolve, reject) => {
      race$.subscribe({ next: resolve, error: reject });
    });
  }

  private _logsHandlers: Map<string, AbstractLogsHandler<unknown>> = new Map();

  logs(name: string): AbstractLogsHandler<unknown> | undefined {
    return this._logsHandlers.get(name);
  }

  addLogsHandler(handler: AbstractLogsHandler<unknown>) {
    if (this._logsHandlers.has(handler.name)) {
      throw new Error(`Log handler with name ${handler.name} already registered`)
    }
    this._logsHandlers.set(handler.name, handler);
  }

  private _handleLogs(
    action: keyof ILogsHandler,
    target: string,
    arg?: string | (string | Buffer) | (ExecaReturnValue | ExecaError),
  ) {
    for (const handler of this._logsHandlers.values()) {
      handler[action](target, arg as (string & (string | Buffer)) & (ExecaReturnValue | ExecaError));
    }
  }

  private _processes = new Map<string, Map<string, ExecaChildProcess>>();

  killAll() {
    this._processes.forEach((cmdProcesses) => cmdProcesses.forEach((cp) => cp.kill()));
  }

  private async _runCommand(
    target: string,
    cmd: string | ICommandConfig,
    args?: string,
    env: {[key: string]: string} = {},
    stdio: 'pipe' | 'inherit' = 'pipe',
  ): Promise<CommandResult> {
    const startedAt = Date.now();
    const _cmd = typeof cmd === 'string' ? cmd : cmd.run;
    const _fullCmd = args ? [_cmd, args].join(' ') : _cmd;
    debug('centipod/run')('Launching process');
    this._handleLogs('commandStarted', target, _fullCmd);
    const cmdId = _fullCmd + '-' + Date.now();
    const _process = command(_fullCmd, {
      cwd: this.root,
      all: true,
      env: { ...process.env, FORCE_COLOR: '2', ...env },
      shell: process.platform === 'win32',
      stdio,
    });
    if (this._processes.has(target)) {
      this._processes.get(target)?.set(cmdId, _process);
    } else {
      this._processes.set(target, new Map([[cmdId, _process]]));
    }
    debug('centipod/run')('Process launched');
    _process.all?.on('data', (chunk) => {
      this._handleLogs('append', target, chunk);
    });
    if (typeof cmd !== 'string' && cmd.daemon) {
      debug('centipod/run')('Command flagged as daemon');
      return this._handleDaemon(cmd.daemon, _process, startedAt);
    } else {
      debug('centipod/run')('Command not flagged as daemon');
      try {
        const result = await _process;
        debug('centipod/run')('Command terminated', result);
        this._processes.get(target)?.delete(cmdId);
        this._handleLogs('commandEnded', target, result);
        return {...result, took: Date.now() - startedAt, daemon: false };
      } catch (e) {
        if ((e as ExecaError).exitCode) {
          this._handleLogs('commandEnded', target, e as ExecaError);
        }
        throw e;
      }
    }
  }

  private async _runCommands(
    target: string,
    args: string[] | string = [],
    env: {[key: string]: string} = {},
    stdio: 'pipe' | 'inherit' = 'pipe',
  ): Promise<Array<CommandResult>> {
    const results: Array<CommandResult> = [];
    const config = this.config[target];
    const cmds = config.cmd;
    const _args = Array.isArray(args) ? args : [args];
    let idx = 0;
    this._handleLogs('open', target);
    for (const _cmd of Array.isArray(cmds) ? cmds : [cmds]) {
      debug('centipod/run')('Do run command', { cmd: _cmd, args: _args[idx], env, stdio});
      results.push(await this._runCommand(target, _cmd, _args[idx], env, stdio));
      idx++;
    }
    this._handleLogs('close', target);
    debug('centipod/run')('All commands run', results);
    return results;
  }

  private async _runCommandsAndCache(
    cache: Cache,
    target: string,
    args: string[] | string = [],
    env: {[key: string]: string} = {},
    stdio: 'pipe' | 'inherit' = 'pipe',
  ): Promise<IProcessResult> {
    try {
      debug('centipod/run')('Do run commands');
      const results = await this._runCommands(target, args, env, stdio);
      try {
        debug('centipod/run')('All success, caching result');
        const toCache: Array<ICommandResult> = results.filter((r) => !isDaemon(r)) as Array<ICommandResult>;
        await cache.write(toCache);
        debug('centipod/run')('Successfully cached');
        debug('centipod/run')('Emitting');
        return { commands: results, fromCache: false, overall: results.reduce((acc, val) => acc + val.took, 0) };
      } catch (e) {
        debug('centipod/run')('Error writing cache');
        debug('centipod/run')('Emitting');
        return { commands: results, fromCache: false, overall: results.reduce((acc, val) => acc + val.took, 0) };
      }
    } catch (e) {
      debug('centipod/run')('Command failed, invalidating cache');
      try {
        await cache.invalidate();
      } catch (err) {
        debug('centipod/run')('Error invalidating cache', err);
      }
      debug('centipod/run')('Rethrowing');
      throw e;
    }
  }

  private async _run(
    target: string,
    force = false,
    args: string[] | string = [],
    env: {[key: string]: string} = {},
    options: ICacheOptions = {},
    stdio: 'pipe' | 'inherit' = 'pipe',
  ): Promise<IProcessResult> {
    let now = Date.now();
    debug('centipod/run')('Running command', { target, args, env });
    const cache = new Cache(this, target, args, env, options);
    try {
      const cachedOutputs = await cache.read();
      debug('centipod/run')('Cache read', cachedOutputs);
      if (!force && cachedOutputs) {
        debug('centipod/run')('From cache');
        return { commands: cachedOutputs, overall: Date.now() - now, fromCache: true };
      }
      debug('centipod/run')('Cache outdated');
      return this._runCommandsAndCache(cache, target, args, env, stdio);
    } catch (e) {
      debug('centipod/run')('Error reading cache');
      // Error reading from cache
      return this._runCommandsAndCache(cache, target, args, env, stdio);
    }
  }

  run(
    target: string,
    force = false,
    args: string[] | string = [],
    stdio: 'pipe' | 'inherit' = 'pipe',
    env: {[key: string]: string} = {},
    options: ICacheOptions = {},
  ): Observable<IProcessResult> {
    return new Observable<IProcessResult>((obs) => {
      debug('centipod/run')('Running cmd');
      this._run(target, force, args, env, options, stdio)
        .then((result) => {
          debug('centipod/run')('Success', result);
          obs.next(result)
        })
        .catch((error) => {
          debug('centipod/run')('Errored', error);
          obs.error(error);
        }).finally(() => {
          debug('centipod/run')('Completed');
          obs.complete();
      });
    });
  }

  async getResult(cmd: string): Promise<Array<ICommandResult> | null> {
    const cache = new Cache(this, cmd);
    return cache.read();
  }

  async invalidate(cmd: string): Promise<void> {
    const cache = new Cache(this, cmd);
    await cache.invalidate();
  }

  async bumpVersions(bump: semver.ReleaseType, identifier?: string): Promise<PublishActions> {
    if (!this.project) {
      throw new CentipodError(CentipodErrorCode.PROJECT_NOT_RESOLVED, 'Cannot publish outside a project');
    }
    this._publish = new Publish(this.project);
    return this._publish.determineActions(this, bump, identifier);
  }

  publish(options = { access: 'public', dry: false }): Observable<PublishEvent> {
    if (!this._publish) {
      throw new CentipodError(CentipodErrorCode.PUBLISHED_WORKSPACE_WITHOUT_BUMP, 'You must bump versions before publishing');
    }
    return this._publish.release(options);
  }

  async getNpmInfos(): Promise<INpmInfos> {
    if (!this._npmInfos) {
      try {
        const result = await command(`yarn npm info ${this.name} --json`);
        const parsedInfos = JSON.parse(result.stdout) as INpmInfos;
        this._npmInfos = parsedInfos;
        return parsedInfos;
      } catch (e) {
        try {
          if (JSON.parse((e as any).stdout).name === 1) { // Not found
            this._npmInfos = { name: this.name, versions: []};
            return { name: this.name, versions: []};
          }
          throw e;
        } catch (_e) {
          throw e;
        }
      }
    }
    return this._npmInfos;
  }

  async isPublished(version: string): Promise<boolean> {
    const infos = await this.getNpmInfos();
    return infos.versions.includes(version);
  }

  async listGreaterVersionsInRegistry(version: string): Promise<Array<string>> {
    const infos = await this.getNpmInfos();
    return infos.versions.filter((v) => semver.gt(v, version));
  }

  async setVersion(version: string): Promise<void> {
    const manifest = await Workspace.loadPackage(this.root);
    manifest.version = version;
    await fs.writeFile(join(this.root, 'package.json'), JSON.stringify(manifest, null, 2));
  }

  async getLastReleaseOnRegistry(): Promise<string> {
    const infos = await this.getNpmInfos();
    return infos.versions.reduce((acc, val) => semver.gt(acc, val) ? acc : val, '0.0.0');
  }

  async getLastReleaseTag(): Promise<string> {
    const tags = await git.tags();
    return tags.all.filter((t) => t.startsWith(this.name)).reduce((acc, val) => semver.gt(acc, val.substr(this.name.length + 1)) ? acc : val.substr(this.name.length + 1), '0.0.0');
  }
}
