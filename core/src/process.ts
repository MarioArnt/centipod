import { ExecaReturnValue } from "execa";
import { Workspace } from "./workspace";

export interface IProcessResult<T= string> {
  commands: Array<ICommandResult<T>>;
  overall: number;
  fromCache: boolean;
}

export interface ICommandResult<T = string> extends ExecaReturnValue<T> {
  took: number; 
}

export enum RunCommandEventEnum {
  TARGETS_RESOLVED,
  NODE_PROCESSED,
  NODE_ERRORED,
  NODE_STARTED,
}

export interface ITargetsResolvedEvent<T = unknown> {
  type: RunCommandEventEnum.TARGETS_RESOLVED;
  targets: Workspace[];
  data?: T;
}

export interface IRunCommandStartedEvent<T = unknown> {
  type: RunCommandEventEnum.NODE_STARTED;
  workspace: Workspace;
  data?: T;
}

export interface IRunCommandSuccessEvent<T = unknown> {
  type: RunCommandEventEnum.NODE_PROCESSED;
  result: IProcessResult;
  workspace: Workspace;
  data?: T;
}

export interface IRunCommandErrorEvent<T = unknown> {
  type: RunCommandEventEnum.NODE_ERRORED;
  error: unknown;
  workspace: Workspace;
  data?: T;
}

export type RunCommandEvent<T = unknown> = IRunCommandStartedEvent<T> | ITargetsResolvedEvent<T> | IRunCommandSuccessEvent<T> | IRunCommandErrorEvent<T>;

export const isTargetResolvedEvent = (event: RunCommandEvent): event is  ITargetsResolvedEvent => event.type === RunCommandEventEnum.TARGETS_RESOLVED;

export const isNodeSucceededEvent = (event: RunCommandEvent): event is  IRunCommandSuccessEvent => event.type === RunCommandEventEnum.NODE_PROCESSED;

export const isNodeErroredEvent = (event: RunCommandEvent): event is  IRunCommandErrorEvent => event.type === RunCommandEventEnum.NODE_ERRORED;

export const isNodeStartedEvent = (event: RunCommandEvent): event is  IRunCommandStartedEvent => event.type === RunCommandEventEnum.NODE_STARTED;
