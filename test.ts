import sg from "simple-git";
import {join, relative} from "path";
import {sync as glob} from "fast-glob";

(async () => {
  try {
    const git = sg();
    const diffs = await git.diff(['--name-only', '8181a296275d80c2d089fab29c76d4255734b0a0', 'b2c775079257f05438c812167cb89c5e71f0211f', '--', '/Users/marioarnautou/Code/OpenSource/centipod/core'])
    console.info(diffs);
    const files = ['**/*.ts'].map((pattern) => glob(join('/Users/marioarnautou/Code/OpenSource/centipod/core', pattern))).reduce((acc, val) => acc = acc.concat(val), []).map(absolute => (relative('/Users/marioarnautou/Code/OpenSource/centipod', absolute)));
    console.log(files);
    console.log(diffs.split('\n').some((diff) => files.includes(diff)));
  } catch (e) {
    console.error(e);
  }
})();
