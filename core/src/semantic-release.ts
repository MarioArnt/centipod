// import { command } from 'execa';
// import { sync } from 'conventional-commits-parser';
import { CentipodError, CentipodErrorCode } from './error';
import { git } from './git';

export const getSemanticReleaseTags = async (): Promise<string[]> => {
  const tags = await git.tags();
  return tags.all.filter((t) => t.startsWith('semantic-release@'));
}

export const hasSemanticReleaseTags = async (): Promise<boolean> => {
  const semanticReleaseTags = await getSemanticReleaseTags();
  return semanticReleaseTags.length > 0;
}

export const createSemanticReleaseTag = async (): Promise<void> => {
  await git.tag(`semantic-release@${Date.now()}`);
  await git.push();
};

export const semanticRelease  = async (_identifier?: string): Promise<void> => {
  const semanticReleaseTags = await getSemanticReleaseTags();
  if (!semanticReleaseTags.length) {
    throw new CentipodError(CentipodErrorCode.NO_SEMANTIC_RELEASE_TAGS_FOUND, 'No semantic release tags found');
  }
  const latest = semanticReleaseTags.sort()
  process.exit(1);
  /*const log = await command(`git log --pretty=oneline --no-decorate ${rev1}..${rev2}`);
  const commits: Array<any> = [];
  for (const line of log.stdout.split('\n')) {
    const hash = line.split(' ')[0];
    const revList = await command(`git rev-list --format=%B --max-count=1 ${hash}`)
    const message = revList.stdout.split('\n').slice(1).join('\n');
    const conventional = sync(message);
    commits.push({ hash, message, conventional });
  }
  for (let i = 0; i ++; i < commits.length) {
    let cmd: string;
    if (i === 0) {
      cmd = `git diff --name-only ${rev1} ${commits[0]}`
    } else {
      cmd = `git diff --name-only ${commits[i - 1]} ${commits[i]}`
    }
    const diff = await command(cmd);
    
  }
  console.info(commits);*/
};
