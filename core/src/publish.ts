import { git } from "./git";
import { Workspace } from "./workspace";
import semver from 'semver';
import { command, ExecaReturnValue } from "execa";
import { Observable } from "rxjs";
import { join } from 'path';
import { CentipodError, CentipodErrorCode } from "./error";
import { Project } from "./project";

export interface IPublishAction {
  workspace: Workspace;
  currentVersion?: string;
  targetVersion?: string;
  changed?: boolean;
  error?: CentipodError;
}

enum PublishEventType {
  ACTIONS_RESOLVED,
  PUBLISHED_NODE,
  COMMITED,
  PUSHED,
}

interface IResolvedActionsEvent {
  type: PublishEventType.ACTIONS_RESOLVED;
  actions: PublishActions;
}

interface IPublishedNodeEvent {
  type: PublishEventType.PUBLISHED_NODE;
  action: IPublishAction;
  output: ExecaReturnValue;
}

interface ICommitCreatedEvent {
  type: PublishEventType.COMMITED;
  message: string;
}

interface IPushedEvent {
  type: PublishEventType.PUSHED;
}

export type PublishEvent = IResolvedActionsEvent | IPublishedNodeEvent | ICommitCreatedEvent | IPushedEvent;


export const isActionsResolvedEvent = (event: PublishEvent): event is  IResolvedActionsEvent => event.type === PublishEventType.ACTIONS_RESOLVED;

export const isPublishedEvent = (event: PublishEvent): event is   IPublishedNodeEvent => event.type === PublishEventType.PUBLISHED_NODE;

export const isCommittedEvent = (event: PublishEvent): event is  ICommitCreatedEvent => event.type === PublishEventType.COMMITED;

export const isPushedEvent = (event: PublishEvent): event is  IPushedEvent => event.type === PublishEventType.PUSHED;

export class PublishActions {
  private readonly _actions: IPublishAction[] = [];

  get actions(): IPublishAction[] {
    return this._actions;
  }

  add(action: IPublishAction): void {
    this._actions.push(action);
  }

  get hasError(): boolean {
    return this._actions.some((a) => a.error);
  }
}

export class Publish {
  constructor(
    private readonly _project: Project,
  ) {}

  private _tags: string[] = [];
  private _actionsResolved = false;
  private _actions: PublishActions = new PublishActions();

  get actions(): PublishActions {
    return this._actions;
  }

  async determineActions(workspace?: Workspace, bump?: semver.ReleaseType, identifier?: string): Promise<PublishActions> {
    if (this._actionsResolved) {
      return this._actions;
    }
    return this._preparePublish(workspace, bump, identifier);
  }

  release(options = { access: 'public', dry: false }): Observable<PublishEvent> {
    return new Observable((obs) => {
      this.determineActions().then(async (actions) => {
        obs.next({ type: PublishEventType.ACTIONS_RESOLVED, actions });
        if (actions.hasError) {
          obs.error('Some publish actions are invalid');
          obs.complete();
        }
        const toCommit: string[] = [];
        for (const action of actions.actions.filter((a) => a.changed)) {
          if (!action.targetVersion) {
            throw new CentipodError(CentipodErrorCode.CANNOT_BUMP_VERSION, 'Missing target version');
          }
          try {
            await action.workspace.setVersion(action.targetVersion);
            const output = await this._publish(action.workspace, options.access, options.dry);
            toCommit.push(join(action.workspace.root, 'package.json'));
            if (!options.dry) {
              await this._createTag(action.workspace, action.targetVersion);
            }
            obs.next({ type: PublishEventType.PUBLISHED_NODE, action, output });
          } catch (e) {
            if (action.currentVersion) {
              await action.workspace.setVersion(action.currentVersion);
            }
            obs.error(e);
            obs.complete();
          }
          if (options.dry && action.currentVersion) {
            await action.workspace.setVersion(action.currentVersion);
          }
        }
        if (!options.dry) {
          try {
            const message = `chore: publish packages\n${actions.actions.map((a) => `${a.workspace.name}@${a.targetVersion}`).join('\n')}`
            await git.commit(
              toCommit,
              message,
            );
            obs.next( {type: PublishEventType.COMMITED, message });
            await git.push();
            obs.next( {type: PublishEventType.PUSHED })
            obs.complete();
          } catch (e) {
            obs.error(e);
            obs.complete();
          }
        } else {
          obs.complete();
        }
      });
    })
  }

  private async _preparePublish(workspace?: Workspace, bump?: semver.ReleaseType, identifier?: string): Promise<PublishActions> {
    const workspaces = this._project.getTopologicallySortedWorkspaces(workspace);
    for (const workspace of workspaces) {
      if (!workspace.version) {
        this._actions.add({
          workspace,
          error: new CentipodError(CentipodErrorCode.MISSING_VERSION, 'Missing version field in package.json'),
        });
        continue;
      }
      if (workspace.private) {
        this._actions.add({
          workspace,
          error: new CentipodError(CentipodErrorCode.CANNOT_PUBLISH_PRIVATE_PACKAGE, 'Workspace is private and canoot be published'),
        });
        continue;
      }
      const currentVersion = workspace.version;
      const targetVersion = bump ? semver.inc(currentVersion, bump, identifier) : currentVersion;
      if (!targetVersion) {
        this._actions.add({
          workspace,
          currentVersion,
          error: new CentipodError(CentipodErrorCode.CANNOT_BUMP_VERSION, 'Cannot bump version with semver'),
        });
        continue;
      }
      const privateDependencies = await this._getPrivateDependencies(workspace);
      if (privateDependencies.length) {
        this._actions.add({
          workspace,
          currentVersion,
          targetVersion,
          error: new CentipodError(CentipodErrorCode.HAS_PRIVATE_DEPENDENCY, `Cannot publish package as it depends private workspaces: ${privateDependencies.map((w) => w.name).join(',')}`),
        });
        continue;
      }
      const isAlreadyPublished = await workspace.isPublished(targetVersion);
      const greaterVersions = await workspace.listGreaterVersionsInRegistry(targetVersion);
      if (isAlreadyPublished || greaterVersions.length) {
        const error = isAlreadyPublished 
          ? new CentipodError(CentipodErrorCode.ALREADY_PUBLISHED, 'Already published in registry')
          : new CentipodError(CentipodErrorCode.FOUND_GREATER_VERSIONS_IN_REGISTRY, `Latest version in registry if ahead current target version. Latest version in registry: ${greaterVersions.reduce((acc, val) => semver.gt(acc, val) ? acc : val , '0.0.0')}`);
        this._actions.add({
          workspace,
          currentVersion,
          targetVersion,
          error,
        });
        continue;
      }
      const hasChanged = await this._hasChangedSinceLastRelease(workspace);
      this._actions.add({
        workspace,
        currentVersion: workspace.version,
        targetVersion,
        changed: hasChanged,
      });
    }
    this._actionsResolved = true;
    return this._actions;
  }

  /**
   * Check if a workspace source code has been modified since last release.
   * If not skip publication
   * @param workspace
   * @returns 
   */
  private async _hasChangedSinceLastRelease(workspace: Workspace): Promise<boolean> {
    const version = workspace.version;
    if (!version) {
      throw new CentipodError(CentipodErrorCode.MISSING_VERSION, `Missing version field in ${workspace.name} package.json`);
    }
    const tag = this._getTagName(workspace, version);
    if (await this._tagExsist(tag)) {
      return workspace.isAffected('HEAD', tag, ['**'], false);
    } else {
      return true;
    }
  }

  private async _getPrivateDependencies(workspace: Workspace): Promise<Array<Workspace>> {
    const deps = this._project.getTopologicallySortedWorkspaces(workspace);
    return deps.filter((w) => w.private);
  }

  private async _publish(workspace: Workspace, access?: string, dry = false): Promise<ExecaReturnValue<string>> {
    const cmd = dry ? 'yarn pack --dry-run' : `yarn npm publish ${access ? '--access ' + access :''}`;
    return await command(cmd, { cwd: workspace.root, env: { ...process.env, FORCE_COLOR: '2' }, shell: process.platform === 'win32' });
  }

  private async _createTag(workspace: Workspace, version: string): Promise<void> {
    await git.tag(this._getTagName(workspace, version))
  }

  private _getTagName(workspace: Workspace, version: string): string {
    return `${workspace.name}-${version}`;
  }

  private async _tagExsist(tag: string): Promise<boolean> {
    if (!this._tags.length) {
      this._tags = (await git.tags({ fetch: true })).all;
    }
    return this._tags.includes(tag);
  }
}
