import { ICommandResult, IRunCommandErrorEvent, isNodeErroredEvent, isNodeSucceededEvent, isTargetResolvedEvent, Project, resloveProjectRoot, Workspace } from "@neoxia/centipod-core";
import chalk from 'chalk';
import { logger } from "../utils/logger";
import { resolveWorkspace } from "../utils/validate-workspace";

export const run = async (cmd: string, options: {parallel: boolean, topological: boolean, force: boolean, to?: string, affected?: string}) => {
  // TODO: Validate options (conflict between parallel/topolical)
  const project =  await Project.loadProject(resloveProjectRoot());
  const to = options.to ? resolveWorkspace(project, options.to) : undefined;
  logger.lf();
  logger.info(logger.centipod, `Running command ${chalk.white.bold(cmd)}`, options.to ? `on project ${options.to}` : '');
  logger.seperator();
  logger.info('Topological:', chalk.white(!options.parallel));
  logger.info('Parallel:', chalk.white(!!options.parallel));
  logger.info('Use caches:', chalk.white(!options.force));
  const affected = options.affected?.split('..');
  let revisions: { rev1: string, rev2: string } | undefined;
  if (affected?.length) {
    const rev1 = affected?.length === 2 ? affected[0] : 'HEAD';
    const rev2 = affected?.length === 2 ? affected[1] : affected[0];
    logger.info('Only affected packages between', chalk.white.bold(rev1, '->', rev2));
    revisions = { rev1, rev2 };
  }
  logger.seperator();
  const isProcessError = (error: unknown): error is ICommandResult => {
    return (error as ICommandResult)?.stderr != null;
  };
  const isNodeEvent = (error: unknown): error is IRunCommandErrorEvent => {
    const candidate = (error as IRunCommandErrorEvent);
    return !!candidate?.type && !!candidate?.error;
  }
  const printError = (error: unknown) => {
    if (isNodeEvent(error)) {
      logger.lf();
      logger.info(logger.centipod, `Run target ${chalk.white.bold(cmd)} on ${chalk.white.bold(error.workspace.name)}`, logger.failed);
      printError(error.error);
    } else if (isProcessError(error)) {
      logger.lf();
      logger.info(chalk.cyan('>'), error.command);
      logger.lf();
      logger.log(error.stdout);
      logger.log(error.stderr);
    } else {
      logger.error(error);
    }
  };
  let failures = new Set<Workspace>();
  const now = Date.now();
  let nbTargets = 0;
  project.runCommand(cmd, { parallel: options.parallel, force: options.force, affected: revisions, to }).subscribe(
      (event) => {
        if (isTargetResolvedEvent(event)) {
          if (!event.targets.length) {
            logger.lf();
            logger.error(logger.centipod, logger.failed, `No project found for command "${cmd}"`);
            logger.lf();
            process.exit(1);
          }
          logger.info('Targets resolved:');
          logger.info(event.targets.map((target) => `${' '.repeat(4)}- ${chalk.white.bold(target.name)}`).join('\n'));
          logger.seperator();
          nbTargets = event.targets.length;
        } else if (isNodeSucceededEvent(event)) {
          logger.lf();
          logger.info(logger.centipod, `Run target ${chalk.white.bold(cmd)} on ${chalk.white.bold(event.workspace.name)} took ${logger.took(event.result.overall )} ${event.result.fromCache ? logger.fromCache : ''}`);
          for (const command of event.result.commands) {
            logger.lf();
            logger.info(chalk.cyan('>'), command.command);
            logger.lf();
            if (command.stdout) {
              logger.log(command.stdout);
            } else {
              logger.info('Process exited with status', command.exitCode);
            }
          }
          logger.seperator();
        } else if (isNodeErroredEvent(event)) {
          printError(event.error);
        }
    },
    (err) => {
      printError(err);
      logger.error(logger.centipod, logger.failed, 'Command failed');
      process.exit(1)
    },
    () => {
      logger.lf();
      const hasFailed = failures.size > 0;
      const status = hasFailed ? logger.failed : logger.success;
      logger.info(logger.centipod, status, chalk.bold[hasFailed ? 'redBright' : 'green'](`Run target "${cmd}" ${hasFailed ? 'failed ' : 'succeeded'} on ${hasFailed ? failures.size + '/' + nbTargets : nbTargets} packages`), logger.took(Date.now() - now));
      if (hasFailed) {
        logger.info('Failed packages:');
        logger.info(Array.from(failures).map((target) => `${' '.repeat(4)}- ${chalk.white.bold(target.name)}`).join('\n'));
      }
      process.exit(hasFailed ? 1 : 0);
    },
  );
}
