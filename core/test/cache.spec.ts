import {Cache} from "../src/cache";
import {Workspace} from "../src";
import { stub } from "sinon";
import {Checksum} from "../src/checksum";
import { promises as nodeFs } from'fs';

describe('[class] Cache manager', () => {
  describe('[method] read()', () => {
    it('should return cached command result if the stored checksum and the current checksum are the same', async () => {
      const workspace = {
        root: '/tmp/fake/location',
      }
      const cache = new Cache(workspace as Workspace, 'foo');
      const checksums = {
        calculate: stub(Checksum.prototype, 'calculate'),
        read: stub(Checksum.prototype, 'read'),
      };
      const fs = stub(nodeFs, 'readFile');
      checksums.calculate.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      checksums.read.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      fs.rejects();
      fs.withArgs('/tmp/fake/location/.caches/foo/output.json').resolves(Buffer.from(JSON.stringify([{ cmd: 'foo', exitCode: 0, stderr: '', stdout: 'success', all: 'success'}])));
      const output = await cache.read();
      checksums.read.restore();
      checksums.calculate.restore();
      fs.restore();
      expect(output).toEqual([{ cmd: 'foo', exitCode: 0, stderr: '', stdout: 'success', all: 'success'}]);
    });
    it('should return null if the stored checksum and the current checksum are different', async () => {
      const workspace = {
        root: '/tmp/fake/location',
      }
      const cache = new Cache(workspace as Workspace, 'foo');
      const checksums = {
        calculate: stub(Checksum.prototype, 'calculate'),
        read: stub(Checksum.prototype, 'read'),
      };
      const fs = stub(nodeFs, 'readFile');
      checksums.calculate.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      checksums.read.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d83edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      fs.rejects();
      fs.withArgs('/tmp/fake/location/.caches/foo/output.json').resolves(Buffer.from(JSON.stringify([{ cmd: 'foo', exitCode: 0, stderr: '', stdout: 'success', all: 'success'}])));
      const output = await cache.read();
      checksums.read.restore();
      checksums.calculate.restore();
      fs.restore();
      expect(output).toBe(null);
    });
    it('should return null if something wrong happen reading checksum', async () => {
      const workspace = {
        root: '/tmp/fake/location',
      }
      const cache = new Cache(workspace as Workspace, 'foo');
      const checksums = {
        calculate: stub(Checksum.prototype, 'calculate'),
        read: stub(Checksum.prototype, 'read'),
      };
      checksums.calculate.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      checksums.read.rejects('Error happened reading checksums')
      const output = await cache.read();
      checksums.read.restore();
      checksums.calculate.restore();
      expect(output).toBe(null);
    });
    it('should return null if something wrong happen calculating current checksum', async () => {
      const workspace = {
        root: '/tmp/fake/location',
      }
      const cache = new Cache(workspace as Workspace, 'foo');
      const checksums = {
        calculate: stub(Checksum.prototype, 'calculate'),
        read: stub(Checksum.prototype, 'read'),
      };
      checksums.calculate.rejects('Error happened calculating checksums')
      checksums.read.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d83edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      const output = await cache.read();
      checksums.read.restore();
      checksums.calculate.restore();
      expect(output).toBe(null);
    });
    it('should return null if something wrong happen reading cached command output', async () => {
      const workspace = {
        root: '/tmp/fake/location',
      }
      const cache = new Cache(workspace as Workspace, 'foo');
      const checksums = {
        calculate: stub(Checksum.prototype, 'calculate'),
        read: stub(Checksum.prototype, 'read'),
      };
      const fs = stub(nodeFs, 'readFile');
      checksums.calculate.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      checksums.read.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      fs.rejects('Error reading file');
      const output = await cache.read();
      checksums.read.restore();
      checksums.calculate.restore();
      fs.restore();
      expect(output).toEqual(null);
    });
    it('should return null if cached output is not parseable', async () => {
      const workspace = {
        root: '/tmp/fake/location',
      }
      const cache = new Cache(workspace as Workspace, 'foo');
      const checksums = {
        calculate: stub(Checksum.prototype, 'calculate'),
        read: stub(Checksum.prototype, 'read'),
      };
      const fs = stub(nodeFs, 'readFile');
      checksums.calculate.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      checksums.read.resolves({
        cmd: 'foo',
        globs: 'foo/**/*.ts,bar/**/*;ts',
        'foo/bar.ts:': 'b6a73d8bc3edf20e',
        'foo/baz.ts:': '022cf092d78977',
      });
      fs.rejects();
      fs.withArgs('/tmp/fake/location/.caches/foo/output.json').resolves(Buffer.from('Not parseable content'));
      const output = await cache.read();
      checksums.read.restore();
      checksums.calculate.restore();
      fs.restore();
      expect(output).toEqual(null);
    });
    it.todo('should return null and warn user if config patterns match no files');
  });
  describe('[method] write()', () => {
    it.todo('should create cache directory if not exists');
    it.todo('should not create cache directory if exists');
    it.todo('should use cached checksums if available');
    it.todo('should recalculate checksums if not cached in class memory');
  });
});
