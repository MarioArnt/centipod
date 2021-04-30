import { git } from "./git";
import { Workspace } from "./workspace";
import semver from 'semver';
import { command, ExecaReturnValue } from "execa";
import { Observable } from "rxjs";
import { join } from 'path';

export enum Upgrade {
  PATCH = 'patch',
  MINOR = 'minor',
  MAJOR = 'major',
}

export interface IPublishAction {
  workspace: Workspace;
  currentVersion?: string;
  targetVersion?: string;
  changed?: boolean;
  error?: string;
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

  add(action: IPublishAction) {
    this._actions.push(action);
  }

  get hasError(): boolean {
    return this._actions.some((a) => a.error);
  }
}

export class Publish {
  constructor(
    private readonly _workspace: Workspace,
    private readonly _bump: Upgrade,
    private readonly _identifier?: string,
  ) {}

  private _tags: string[] = [];
  private _actionsResolved = false;
  private _actions: PublishActions = new PublishActions();

  release(): Observable<PublishEvent> {
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
            continue;
          }
          try {
            await action.workspace.setVersion(action.targetVersion);
            const output = await this._publish(action.workspace);
            toCommit.push(join(action.workspace.root, 'package.json'));
            await this._createTag(action.workspace, action.targetVersion);
            obs.next({ type: PublishEventType.PUBLISHED_NODE, action, output });
          } catch (e) {
            obs.error(e);
            obs.complete();
          }
        }
        try {
          const message = `chore: release ${this._workspace.name}@${actions.actions.find((a) => a.workspace === this._workspace)?.targetVersion}`
          await git.commit(
            toCommit,
            message,
          );
          obs.next( {type: PublishEventType.COMMITED, message })
          await git.push();
          obs.next( {type: PublishEventType.PUSHED })
          obs.complete();
        } catch (e) {
          obs.error(e);
          obs.complete();
        }
      });
    })
  }

  async determineActions(): Promise<PublishActions> {
    if (this._actionsResolved) {
      return this._actions;
    }
    const project = this._workspace.project;
    if (!project) {
      throw Error('Cannot publish outside a project');
    }
    const dependencies = project.getTopologicallySortedWorkspaces(this._workspace);
    for (const dep of dependencies) {
      const currentVersion = dep.version;
      if (await this._shouldBePublished(dep)) {
        if (currentVersion) {
          const targetVersion = semver.inc(currentVersion, this._bump, this._identifier);
          if (!targetVersion) {
            this._actions.add({ workspace: dep, error: 'semver couldnt determine target version', currentVersion })
          }
          else if (await dep.isPublished(targetVersion)) {
            this._actions.add({ workspace: dep, error: 'already published', currentVersion, targetVersion })
          } else {
            this._actions.add({ workspace: dep, currentVersion, targetVersion, changed: true })
          }
        } else {
          this._actions.add({ workspace: dep, error: 'version field unset in package.json' })
        }
      } else {
        this._actions.add({ workspace: dep, changed: false, currentVersion })
      }
    }
    this._actionsResolved = true;
    return this._actions;
  }

  private async _publish(workspace: Workspace) {
    return await command('yarn npm publish', { cwd: workspace.root });
  }

  private async _createTag(workspace: Workspace, version: string) {
    await git.tag(this._getTagName(workspace, version))
  }

  private _getTagName(workspace: Workspace, version: string): string {
    return `${workspace.name}-${version}`;
  }

  private async _shouldBePublished(workspace: Workspace): Promise<boolean> {
    const version = workspace.version;
    if (!version) {
      throw new Error(`Missing version field in ${workspace.name} package.json`);
    }
    const tag = this._getTagName(workspace, version);
    if (await this._tagExsist(tag)) {
      return workspace.isAffected('HEAD', tag, ['**'], false);
    } else {
      return true;
    }
  }

  private async _tagExsist(tag: string): Promise<boolean> {
    if (!this._tags.length) {
      this._tags = (await git.tags({ fetch: true })).all;
    }
    return this._tags.includes(tag);
  }
}
