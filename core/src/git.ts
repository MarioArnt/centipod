import simpleGit, { FetchResult, TagResult } from 'simple-git';

// Types
export interface GitTagsOptions {
  fetch?: boolean;
}

// Namespace
export const git = {
  // Attributes
  git: simpleGit(),
  root: process.cwd(),

  // Methods
  setup(root: string): void {
    this.git = simpleGit({ baseDir: root });
    this.root = root;
  },

  // Commands
  async fetch(...args: string[]): Promise<FetchResult> {
    return this.git.fetch(args);
  },

  async diff(...args: string[]): Promise<string[]> {
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
    return await this.git.tags();
  }
};