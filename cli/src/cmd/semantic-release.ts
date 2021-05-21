import { CentipodErrorCode, Project, resloveProjectRoot, semanticRelease as prepareRelease, hasSemanticReleaseTags, createSemanticReleaseTag, Publish } from "@centipod/core";;
import { logger } from '../utils/logger';
import { printActions } from '../utils/print-actions';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { printEvent } from '../utils/print-publish-events';

interface IPublishOptions {
  yes?: boolean;
  access?: string;
  dry?: boolean;
}

const printSummary = (publisher: Publish): void => {
  printActions(publisher.actions);
  logger.seperator();
  if (publisher.actions.actions.filter((a) => a.error).length) {
    logger.lf();
    logger.info('Cannot publish packages, errors were found when preparing releases');
    process.exit(1);
  }
  if (!publisher.actions.actions.filter((a) => a.changed).length) {
    logger.lf();
    logger.info('Nothing to publish');
    process.exit(0);
  }
}

const doPublish = (publisher: Publish, options: IPublishOptions): void => {
  publisher.release({
    access: options.access,
    dry: options.dry || false,
  }).subscribe(
    (evt) => printEvent(evt),
    (err) => {
      logger.error(err);
      process.exit(1);
    },
    async () => {
      await createSemanticReleaseTag();
      logger.lf();
      logger.info(logger.centipod, logger.success, chalk.green.bold(`Successfully initialized semantic release and published packages`, options.dry ? chalk.bgBlueBright.white(' DRY RUN ') : ''));
      process.exit(0);
    },
  );
};

const promptPublishConfirmation = (publisher: Publish, options: IPublishOptions): void => {
  if (options.yes) {
    doPublish(publisher, options);
  } else {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout
    });
    rl.question('Do you want to publish (y/N) ? ', (confirm) => {
      if (confirm === 'y' || confirm === 'yes') {
        logger.seperator();
        doPublish(publisher, options);
      } else {
        logger.error('\nAborted by user');
        process.exit(1);
      }
    });
  }
}

export const semanticRelease  = async (identifier: string, options: IPublishOptions): Promise<void> => {
  const project =  await Project.loadProject(resloveProjectRoot());
  logger.lf();
  logger.info(logger.centipod, chalk.white.bold('Initializing new semantic-release update'));
  logger.seperator();
  try {
    logger.info('Based on conventional commit messages analysis, the following updates are advised :');
    logger.lf();
    const publisher = await prepareRelease(project, identifier);
    printSummary(publisher);
    promptPublishConfirmation(publisher, options);
  } catch (e) {
    switch (e.code) {
      case CentipodErrorCode.NO_SEMANTIC_RELEASE_TAGS_FOUND:
        logger.error('Previous semantic release tag could not be found. Have you initialized semenatic-release with command "centipod semantic-release init <version>"');
        break
      default:
        logger.error(e);
        break;
    }
    process.exit(1);
  }
};

export const semanticReleaseInit  = async (options: IPublishOptions): Promise<void> => {
  const project =  await Project.loadProject(resloveProjectRoot());
  logger.lf();
  logger.info(logger.centipod, chalk.white.bold('Initializing semantic-release flow'));
  logger.seperator();
  const isAlreadyInitialized = await hasSemanticReleaseTags();
  if (isAlreadyInitialized) {
    logger.error('Semantic-release flow already initialized');
    process.exit(1);
  }
  try {
    const publisher = await project.publishAll();
    printSummary(publisher);
    promptPublishConfirmation(publisher, options);
  } catch (e) {
    logger.error(e);
    process.exit(1);
  }
};
