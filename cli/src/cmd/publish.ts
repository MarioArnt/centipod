import { isCommittedEvent, isPublishedEvent, isPushedEvent, Project, resloveProjectRoot, Upgrade } from "@neoxia/centipod-core";
import { logger } from "../utils/logger";
import { resolveWorkspace } from "../utils/validate-workspace";
import chalk from 'chalk';
import { createInterface } from "readline";

export const publish = async (workspaceName: string, bump: Upgrade, identifier: string | undefined, options: { yes: boolean, accessPublic: boolean }) => {
  const project =  await Project.loadProject(resloveProjectRoot());
  const workspace = resolveWorkspace(project, workspaceName);
  logger.lf();
  logger.info(logger.centipod, `Publishing ${chalk.white.bold(workspace.name)}`);
  logger.seperator();
  logger.info('Upgrade type:', chalk.white.bold(bump));
  if (identifier) {
    logger.info('Identifier:', chalk.white.bold(identifier));
  }
  logger.seperator();
  const actions = await workspace.bumpVersions(bump, identifier);
  for (const action of actions.actions) {
    if (action.error) {
      if (action.currentVersion) {
        logger.info(action.workspace.name + ':', chalk.white.bold(action.currentVersion), '->', chalk.red.bold(action.error));
      } else {
        logger.info(action.workspace.name + ':', chalk.red.bold(action.error));
      }
    } else {
      if (action.targetVersion) {
        logger.info(action.workspace.name + ':', chalk.white.bold(action.currentVersion), '->', chalk.white.bold(action.targetVersion));
      } else {
        logger.info(action.workspace.name + ':', chalk.white.bold(action.currentVersion), '->', chalk.grey('[no changes]'));
      }
    }
  }
  logger.seperator();
  const doPublish = () => {
    workspace.publish(options.accessPublic).subscribe(
      (evt) => {
        if (isPublishedEvent(evt)) {
          logger.info(`Published ${chalk.white.bold(evt.action.workspace.name)}@${chalk.white.bold(evt.action.targetVersion)}`);
          logger.lf();
          logger.log(evt.output.stdout);
          logger.seperator();
        } else if (isCommittedEvent(evt)) {
          logger.info('Creating commit', chalk.white(evt.message));
        } else if (isPushedEvent(evt)) {
          logger.info('Pushing tags and release commit');
        }
      },
      (err) => {
        logger.error(err);
        process.exit(1);
      },
      () => {
        logger.info(logger.centipod, logger.success, chalk.green.bold(`Successfully published package ${workspaceName} and its dependencies`));
        process.exit(0);
      },
    );
  }
  if (options.yes) {
    doPublish();
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('Do you want to publish (y/N) ? ', (confirm) => {
      if (confirm === 'y' || confirm === 'yes') {
        logger.seperator();
        doPublish();
      } else {
        logger.error('\nAborted by user');
        process.exit(1);
      }
    });
  }
};
