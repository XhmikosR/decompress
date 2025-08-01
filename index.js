import {Buffer} from 'node:buffer';
import path from 'node:path';
import process from 'node:process';
import {promisify} from 'node:util';
import decompressTar from '@xhmikosr/decompress-tar';
import decompressTarbz2 from '@xhmikosr/decompress-tarbz2';
import decompressTargz from '@xhmikosr/decompress-targz';
import decompressUnzip from '@xhmikosr/decompress-unzip';
import fs from 'graceful-fs';
import stripDirs from 'strip-dirs';

const link = promisify(fs.link);
const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const readlink = promisify(fs.readlink);
const realpath = promisify(fs.realpath);
const symlink = promisify(fs.symlink);
const utimes = promisify(fs.utimes);
const writeFile = promisify(fs.writeFile);

const runPlugins = (input, options) => {
	if (options.plugins.length === 0) {
		return Promise.resolve([]);
	}

	return Promise.all(options.plugins.map(x => x(input, options)))
		// eslint-disable-next-line unicorn/no-array-reduce
		.then(files => files.reduce((a, b) => [...a, ...b]));
};

const safeMakeDir = (dir, realOutputPath) => realpath(dir)
	.catch(_ => {
		const parent = path.dirname(dir);
		return safeMakeDir(parent, realOutputPath);
	})
	.then(realParentPath => {
		if (realParentPath.indexOf(realOutputPath) !== 0) {
			throw new Error('Refusing to create a directory outside the output path.');
		}

		return mkdir(dir, {recursive: true}).then(() => realpath(dir));
	});

const preventWritingThroughSymlink = (destination, realOutputPath) => readlink(destination)
	// Either no file exists, or it's not a symlink. In either case, this is
	// not an escape we need to worry about in this phase.
	.catch(_ => null)
	.then(symlinkPointsTo => {
		if (symlinkPointsTo) {
			throw new Error('Refusing to write into a symlink');
		}

		// No symlink exists at `destination`, so we can continue
		return realOutputPath;
	});

const extractFile = (input, output, options) => runPlugins(input, options).then(files => {
	if (options.strip > 0) {
		files = files
			.map(x => {
				x.path = stripDirs(x.path, options.strip);
				return x;
			})
			.filter(x => x.path !== '.');
	}

	if (typeof options.filter === 'function') {
		// eslint-disable-next-line unicorn/no-array-callback-reference
		files = files.filter(options.filter);
	}

	if (typeof options.map === 'function') {
		// eslint-disable-next-line unicorn/no-array-callback-reference
		files = files.map(options.map);
	}

	if (!output) {
		return files;
	}

	return Promise.all(files.map(x => {
		const dest = path.join(output, x.path);
		const mode = x.mode & ~process.umask(); // eslint-disable-line no-bitwise
		const now = new Date();

		if (x.type === 'directory') {
			return mkdir(output, {recursive: true})
				.then(() => realpath(output))
				.then(realOutputPath => safeMakeDir(dest, realOutputPath))
				.then(() => utimes(dest, now, x.mtime))
				.then(() => x);
		}

		return mkdir(output, {recursive: true})
			.then(() => realpath(output))
			.then(realOutputPath =>
				// Attempt to ensure parent directory exists (failing if it's outside the output dir)
				safeMakeDir(path.dirname(dest), realOutputPath).then(() => realOutputPath),
			)
			.then(realOutputPath => x.type === 'file'
				? preventWritingThroughSymlink(dest, realOutputPath)
				: realOutputPath)
			.then(realOutputPath => realpath(path.dirname(dest))
				.then(realDestinationDir => {
					if (realDestinationDir.indexOf(realOutputPath) !== 0) {
						throw new Error(`Refusing to write outside output directory: ${realDestinationDir}`);
					}
				}))
			.then(() => {
				if (x.type === 'link') {
					return link(x.linkname, dest);
				}

				if (x.type === 'symlink' && process.platform === 'win32') {
					return link(x.linkname, dest);
				}

				if (x.type === 'symlink') {
					return symlink(x.linkname, dest);
				}

				return writeFile(dest, x.data, {mode});
			})
			.then(() => x.type === 'file' && utimes(dest, now, x.mtime))
			.then(() => x);
	}));
});

const decompress = (input, output, options) => {
	if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
		return Promise.reject(new TypeError('Input file required'));
	}

	if (typeof output === 'object') {
		options = output;
		output = null;
	}

	options = {
		plugins: [
			decompressTar(),
			decompressTarbz2(),
			decompressTargz(),
			decompressUnzip(),
		],
		...options,
	};

	const read = typeof input === 'string' ? readFile(input) : Promise.resolve(input);

	return read.then(buf => extractFile(buf, output, options));
};

export default decompress;
