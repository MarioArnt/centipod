import { IProcessResult, IRunCommandErrorEvent, isNodeErroredEvent, isNodeSucceededEvent, isTargetResolvedEvent, Project, resloveProjectRoot, Workspace } from "@neoxia/centipod-core";
import chalk from 'chalk';

const centipod = `${chalk.cyan.bold('>')} ${chalk.bgCyan.black.bold(' CENTIPOD ')}`;

export const run = async (cmd: string, options: {P: boolean, T: boolean, force: boolean, to?: string, affected?: string}) => {
  process.stdout.write('\n');
  console.info(centipod, chalk.grey(`Running target ${chalk.white.bold(cmd)}`));
  console.info(chalk.grey('———————————————————————————————————————————————'));
  console.info(chalk.grey('Topological:', chalk.white(!options.P)));
  console.info(chalk.grey('Parallel:', chalk.white(!!options.P)));
  console.info(chalk.grey('Use caches:', chalk.white(!options.force)));
  const affected = options.affected?.split('..');
  if (affected?.length) {
    const rev1 = affected?.length === 2 ? affected[0] : 'HEAD';
    const rev2 = affected?.length === 2 ? affected[1] : affected[0];
    console.info(chalk.grey('Only affected packages between', chalk.white.bold(rev1, '->', rev2)));
  }
  console.info(chalk.grey('———————————————————————————————————————————————'));
  const project =  await Project.loadProject(resloveProjectRoot());

  const printError = (event: IRunCommandErrorEvent) => {
    if ((event.error as IProcessResult)?.stderr) {
      console.log((event.error as IProcessResult)?.stderr);
    } else {
      console.error(event.error);
    }
  };
  let failures = new Set<Workspace>();
  const now = Date.now();
  let nbTargets = 0;
  project.runCommand(cmd, { parallel: options.P, force: options.force }).subscribe(
      (event) => {
        if (isTargetResolvedEvent(event)) {
          console.info(chalk.grey('Targets resolved:'));
          console.info(chalk.grey(event.targets.map((target) => `${' '.repeat(4)}- ${chalk.white.bold(target.name)}`).join('\n')));
          console.info(chalk.grey('———————————————————————————————————————————————'));
          nbTargets = event.targets.length;
        } else if (isNodeSucceededEvent(event)) {
          process.stdout.write('\n');
          console.log(centipod, `Run target ${chalk.bold(cmd)} on ${chalk.bold(event.workspace.name)} took ${chalk.magenta(event.result.took + 'ms')} ${event.result.fromCache ? chalk.bgCyanBright.bold.black(' FROM CACHE '): ''}`);
          console.log(event.result.stdout);
          console.info(chalk.grey('———————————————————————————————————————————————'));
        } else if (isNodeErroredEvent(event)) {

        }
    },
    (err) => {
      
    },
    () => {
      process.stdout.write('\n');
      const hasFailed = failures.size > 0;
      const status = hasFailed ? chalk.bgRedBright.black.bold(' FAILED ') : chalk.bgGreen.black.bold(' SUCCESS ');
      console.log(centipod, status, chalk.bold[hasFailed ? 'redBright' : 'green'](`Run target "${cmd}" succeeded on ${nbTargets} packages`), chalk.magenta(`took ${Date.now() - now}ms`));
      if (hasFailed) {
        console.info(chalk.grey('Failed packages:'));
        console.info(chalk.grey(Array.from(failures).map((target) => `${' '.repeat(4)}- ${chalk.white.bold(target.name)}`).join('\n')));
      }
      process.exit(hasFailed ? 1 : 0);
    },
  );
}
