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

export interface ITargetsResolvedEvent {
  type: RunCommandEventEnum.TARGETS_RESOLVED;
  targets: Workspace[];
}

export interface IRunCommandStartedEvent {
  type: RunCommandEventEnum.NODE_STARTED;
  workspace: Workspace;
}

export interface IRunCommandSuccessEvent {
  type: RunCommandEventEnum.NODE_PROCESSED;
  result: IProcessResult;
  workspace: Workspace;
}

export interface IRunCommandErrorEvent {
  type: RunCommandEventEnum.NODE_ERRORED;
  error: unknown;
  workspace: Workspace;

}

export type RunCommandEvent = ITargetsResolvedEvent | IRunCommandSuccessEvent | IRunCommandErrorEvent;

export const isTargetResolvedEvent = (event: RunCommandEvent): event is  ITargetsResolvedEvent => event.type === RunCommandEventEnum.TARGETS_RESOLVED;

export const isNodeSucceededEvent = (event: RunCommandEvent): event is  IRunCommandSuccessEvent => event.type === RunCommandEventEnum.NODE_PROCESSED;

export const isNodeErroredEvent = (event: RunCommandEvent): event is  IRunCommandErrorEvent => event.type === RunCommandEventEnum.NODE_ERRORED;
