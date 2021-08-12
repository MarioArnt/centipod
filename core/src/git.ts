import simpleGit, { FetchResult, TagResult } from 'simple-git';

// Types
export interface GitTagsOptions {
  fetch?: boolean;
}

const simpleGitInstance = simpleGit();

export const fixture = {
  simpleGitInstance,
}

// Namespace
export const git = {
  // Attributes
  git: simpleGitInstance,

  // Commands
  async fetch(...args: string[]): Promise<FetchResult> {
    return this.git.fetch(args);
  },

  async diff(...args: string[]): Promise<string[]> {
    console.log(args);
    const res = await this.git.diff(args);
    // Parse result
    return res.split('\n').filter(f => f);
  },

  async tags(opts: GitTagsOptions = { fetch: false }): Promise<TagResult> {
    // Fetch tags
    if (opts.fetch) {
      await this.git.fetch(['--tags']);
    }
    // Get tags
    return this.git.tags();
  },

  async tag(version: string): Promise<string> {
    return this.git.tag([version]);
  },

  async commit(files: string[], message: string): Promise<void> {
    await this.git.commit(message, files, { '--allow-empty': null });
  },

  async push(): Promise<void> {
    await this.git.push();
    await this.git.pushTags();
  }
};
