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

const runPlugins = async (input, options) => {
	if (options.plugins.length === 0) {
		return [];
	}

	const files = await Promise.all(options.plugins.map(x => x(input, options)));

	// eslint-disable-next-line unicorn/no-array-reduce
	return files.reduce((a, b) => [...a, ...b]);
};

const safeMakeDir = async (dir, realOutputPath) => {
	let realParentPath;

	try {
		realParentPath = await realpath(dir);
	} catch {
		const parent = path.dirname(dir);
		realParentPath = await safeMakeDir(parent, realOutputPath);
	}

	if (realParentPath.indexOf(realOutputPath) !== 0) {
		throw new Error('Refusing to create a directory outside the output path.');
	}

	await mkdir(dir, {recursive: true});
	return realpath(dir);
};

const preventWritingThroughSymlink = async (destination, realOutputPath) => {
	let symlinkPointsTo = null;

	try {
		symlinkPointsTo = await readlink(destination);
	} catch {
		// Either no file exists, or it's not a symlink. In either case, this is
		// not an escape we need to worry about in this phase.
	}

	if (symlinkPointsTo) {
		throw new Error('Refusing to write into a symlink');
	}

	// No symlink exists at `destination`, so we can continue
	return realOutputPath;
};

const extractFile = async (input, output, options) => {
	let files = await runPlugins(input, options);

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

	return Promise.all(files.map(async x => {
		const dest = path.join(output, x.path);
		const mode = x.mode & ~process.umask(); // eslint-disable-line no-bitwise
		const now = new Date();

		if (x.type === 'directory') {
			await mkdir(output, {recursive: true});
			const realOutputPath = await realpath(output);
			await safeMakeDir(dest, realOutputPath);
			await utimes(dest, now, x.mtime);
			return x;
		}

		await mkdir(output, {recursive: true});
		const realOutputPath = await realpath(output);

		// Attempt to ensure parent directory exists (failing if it's outside the output dir)
		await safeMakeDir(path.dirname(dest), realOutputPath);

		if (x.type === 'file') {
			await preventWritingThroughSymlink(dest, realOutputPath);
		}

		const realDestinationDir = await realpath(path.dirname(dest));
		if (realDestinationDir.indexOf(realOutputPath) !== 0) {
			throw new Error(`Refusing to write outside output directory: ${realDestinationDir}`);
		}

		if (x.type === 'link') {
			await link(x.linkname, dest);
		} else if (x.type === 'symlink' && process.platform === 'win32') {
			await link(x.linkname, dest);
		} else if (x.type === 'symlink') {
			await symlink(x.linkname, dest);
		} else {
			await writeFile(dest, x.data, {mode});
		}

		if (x.type === 'file') {
			await utimes(dest, now, x.mtime);
		}

		return x;
	}));
};

const decompress = async (input, output, options) => {
	if (typeof input !== 'string' && !Buffer.isBuffer(input)) {
		throw new TypeError('Input file required');
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

	const buffer = typeof input === 'string' ? await readFile(input) : input;

	return extractFile(buffer, output, options);
};

export default decompress;
