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
const lstat = promisify(fs.lstat);
const mkdir = promisify(fs.mkdir);
const readFile = promisify(fs.readFile);
const readlink = promisify(fs.readlink);
const realpath = promisify(fs.realpath);
const symlink = promisify(fs.symlink);
const utimes = promisify(fs.utimes);
const writeFile = promisify(fs.writeFile);

const IS_WINDOWS = process.platform === 'win32';

const runPlugins = async (input, options) => {
	if (options.plugins.length === 0) {
		return [];
	}

	const entryGroups = await Promise.all(options.plugins.map(plugin => plugin(input, options)));

	return entryGroups.flat();
};

const isInsideOutput = (target, root) => {
	const rel = path.relative(root, target);
	// '' is the dir itself; a `..` or an absolute path (different drive on Windows) is outside it
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const safeMakeDir = async (dir, realOutputPath) => {
	let realParentPath;

	try {
		realParentPath = await realpath(dir);
	} catch {
		const parent = path.dirname(dir);
		realParentPath = await safeMakeDir(parent, realOutputPath);
	}

	if (!isInsideOutput(realParentPath, realOutputPath)) {
		throw new Error('Refusing to create a directory outside the output path.');
	}

	await mkdir(dir, {recursive: true});
	return realpath(dir);
};

const ensureLinkTargetInsideOutput = async (linkname, linkBase, realOutputPath) => {
	const target = path.resolve(linkBase, linkname);

	if (!isInsideOutput(target, realOutputPath)) {
		throw new Error(`Refusing to create a link pointing outside the output directory: ${target}`);
	}

	// `path.resolve` collapses `a/..` lexically, so an in-archive symlink at `a`
	// can mask a `..` escape. Walk the linkname component-by-component, following
	// symlinks at each step like the OS does at access time, and reject if any
	// intermediate or final path leaves the output directory.
	let current = linkBase;
	const components = linkname.split(path.sep).filter(Boolean);

	for (const component of components) {
		if (component === '.') {
			continue;
		}

		if (component === '..') {
			current = path.dirname(current);
			if (!isInsideOutput(current, realOutputPath)) {
				throw new Error(`Refusing to create a link pointing outside the output directory: ${current}`);
			}

			continue;
		}

		current = path.join(current, component);

		let stat;
		try {
			// eslint-disable-next-line no-await-in-loop
			stat = await lstat(current);
		} catch {
			// Component does not exist yet (e.g. dangling symlink target).
			// The lexical check above already covered the final resolved path.
			if (!isInsideOutput(current, realOutputPath)) {
				throw new Error(`Refusing to create a link pointing outside the output directory: ${current}`);
			}

			continue;
		}

		if (stat.isSymbolicLink()) {
			// eslint-disable-next-line no-await-in-loop
			const symTarget = await readlink(current);
			const resolved = path.resolve(path.dirname(current), symTarget);
			if (!isInsideOutput(resolved, realOutputPath)) {
				throw new Error(`Refusing to create a link pointing outside the output directory: ${resolved}`);
			}

			current = resolved;
		}
	}

	return target;
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

// Hardlinks need their target written first, so extract everything else before linking
const isHardlink = entry => entry.type === 'link' || (entry.type === 'symlink' && IS_WINDOWS);

const extractFile = async (input, output, options) => {
	let entries = await runPlugins(input, options);

	if (options.strip > 0) {
		entries = entries
			.map(entry => {
				entry.path = stripDirs(entry.path, options.strip);
				return entry;
			})
			.filter(entry => entry.path !== '.');
	}

	if (typeof options.filter === 'function') {
		// eslint-disable-next-line unicorn/no-array-callback-reference
		entries = entries.filter(options.filter);
	}

	if (typeof options.map === 'function') {
		// eslint-disable-next-line unicorn/no-array-callback-reference
		entries = entries.map(options.map);
	}

	if (!output || entries.length === 0) {
		return entries;
	}

	await mkdir(output, {recursive: true});
	const realOutputPath = await realpath(output);

	const umask = process.umask();
	const now = new Date();

	const extractEntry = async entry => {
		const dest = path.join(output, entry.path);

		if (entry.type === 'directory') {
			await safeMakeDir(dest, realOutputPath);
			await utimes(dest, now, entry.mtime);
			return;
		}

		// Attempt to ensure parent directory exists (failing if it's outside the output dir)
		await safeMakeDir(path.dirname(dest), realOutputPath);

		const realDestinationDir = await realpath(path.dirname(dest));
		if (!isInsideOutput(realDestinationDir, realOutputPath)) {
			throw new Error(`Refusing to write outside output directory: ${realDestinationDir}`);
		}

		if (entry.type === 'link') {
			// Hardlink target is relative to the extraction root
			const target = await ensureLinkTargetInsideOutput(entry.linkname, realOutputPath, realOutputPath);
			await link(target, dest);
		} else if (entry.type === 'symlink' && IS_WINDOWS) {
			// No symlinks on Windows; emulate with a hardlink relative to the link's dir
			const target = await ensureLinkTargetInsideOutput(entry.linkname, path.dirname(dest), realOutputPath);
			await link(target, dest);
		} else if (entry.type === 'symlink') {
			// Target is relative to the link's own dir
			await ensureLinkTargetInsideOutput(entry.linkname, path.dirname(dest), realOutputPath);
			await symlink(entry.linkname, dest);
		} else {
			// Guard the write itself, not just `file`, so flavors like contiguous-file can't bypass it
			await preventWritingThroughSymlink(dest, realOutputPath);
			// Never honor setuid/setgid/sticky bits from an archive
			const mode = (entry.mode & 0o777) & ~umask; // eslint-disable-line no-bitwise
			await writeFile(dest, entry.data, {mode});
			await utimes(dest, now, entry.mtime);
		}
	};

	const results = Array.from({length: entries.length});
	const settle = async i => {
		try {
			await extractEntry(entries[i]);
			results[i] = {status: 'fulfilled'};
		} catch (error) {
			results[i] = {status: 'rejected', reason: error};
		}
	};

	const order = [...entries.keys()];
	await Promise.all(order.filter(i => !isHardlink(entries[i])).map(i => settle(i)));
	await Promise.all(order.filter(i => isHardlink(entries[i])).map(i => settle(i)));

	// Report the first failure in entry order, not whichever rejected first
	const failure = results.find(result => result.status === 'rejected');
	if (failure) {
		throw failure.reason;
	}

	return entries;
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
