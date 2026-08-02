import {Buffer} from 'node:buffer';
import {constants as fsConstants} from 'node:fs';
// realpath follows symlinks, so a target that escapes via a symlink is caught
import {
	lstat, open as openFile, realpath, unlink,
} from 'node:fs/promises';
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
const symlink = promisify(fs.symlink);
const utimes = promisify(fs.utimes);

const IS_WINDOWS = process.platform === 'win32';
// Names Windows treats as device files, with or without an extension (`NUL.txt` is still `NUL`)
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

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

const isUnsafeWindowsSegment = segment => {
	// `.`/`..`/empty segments are handled by the traversal checks, not here
	if (segment === '' || segment === '.' || segment === '..') {
		return false;
	}

	// `:` opens an NTFS alternate data stream; the rest are invalid Windows filename chars
	if (/[<>:"|?*]/.test(segment) || [...segment].some(character => character.codePointAt(0) < 0x20)) {
		return true;
	}

	return WINDOWS_RESERVED_NAME.test(segment);
};

export const assertSafeEntryPath = (entryPath, isWindows = IS_WINDOWS) => {
	// fs rejects NUL too, but not before mkdir has created parent directories
	if (entryPath.includes('\0')) {
		throw new Error(`Refusing to extract a path containing a NUL byte: ${entryPath}`);
	}

	// Alternate data streams, reserved device names and forbidden characters are
	// all legal on POSIX, so reject them on Windows only
	if (!isWindows) {
		return;
	}

	const unsafe = entryPath.split(/[/\\]/).find(segment => isUnsafeWindowsSegment(segment));
	if (unsafe !== undefined) {
		throw new Error(`Refusing to extract a path that is unsafe on Windows: ${entryPath}`);
	}
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

	// An existing target may itself be a symlink that escapes, so check its real path
	let realTarget;
	try {
		realTarget = await realpath(target);
	} catch {
		// Dangling link; the path check above covers it
		return target;
	}

	if (!isInsideOutput(realTarget, realOutputPath)) {
		throw new Error(`Refusing to create a link pointing outside the output directory: ${realTarget}`);
	}

	return target;
};

const assertNotSymlink = async target => {
	// link() would clone the symlink inode, relocating its relative target outside
	const stats = await lstat(target).catch(() => null);

	if (stats && stats.isSymbolicLink()) {
		throw new Error(`Refusing to hardlink to a symlink: ${target}`);
	}
};

// realpath the longest existing prefix (follows sibling symlinks), then append the missing tail
const resolveMaybeMissing = async target => {
	let existing = target;
	const tail = [];

	for (;;) {
		try {
			// eslint-disable-next-line no-await-in-loop
			return path.join(await realpath(existing), ...tail.toReversed());
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) {
				return target;
			}

			tail.push(path.basename(existing));
			existing = parent;
		}
	}
};

// A self-referential linkname resolves inside lexically but escapes via the kernel
const assertSymlinkResolvesInside = async (dest, linkname, realOutputPath) => {
	// Keep the raw linkname so its symlink components aren't collapsed
	const rawTarget = path.isAbsolute(linkname) ? linkname : path.dirname(dest) + path.sep + linkname;
	const resolved = await resolveMaybeMissing(rawTarget);

	if (!isInsideOutput(resolved, realOutputPath)) {
		await unlink(dest).catch(() => null);
		throw new Error(`Refusing to keep a symlink that escapes the output directory: ${dest}`);
	}
};

// Files, then symlinks, then hardlinks: a hardlink may target a symlink
const isSymlink = entry => entry.type === 'symlink' && !IS_WINDOWS;
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
		assertSafeEntryPath(entry.path);

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
			await assertNotSymlink(target);
			await link(target, dest);
		} else if (entry.type === 'symlink' && IS_WINDOWS) {
			// No symlinks on Windows; emulate with a hardlink relative to the link's real dir
			const target = await ensureLinkTargetInsideOutput(entry.linkname, realDestinationDir, realOutputPath);
			await assertNotSymlink(target);
			await link(target, dest);
		} else if (entry.type === 'symlink') {
			// Lexical fast-reject; assertSymlinkResolvesInside is the real guard
			await ensureLinkTargetInsideOutput(entry.linkname, realDestinationDir, realOutputPath);
			await symlink(entry.linkname, dest);
		} else {
			// Never honor setuid/setgid/sticky bits from an archive
			const mode = (entry.mode & 0o777) & ~umask; // eslint-disable-line no-bitwise
			// O_NOFOLLOW so a symlink planted at dest can't redirect the write
			const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0); // eslint-disable-line no-bitwise
			const handle = await openFile(dest, flags, mode).catch(error => {
				if (error.code === 'ELOOP') {
					throw new Error('Refusing to write into a symlink');
				}

				throw error;
			});
			try {
				await handle.writeFile(entry.data);
				await handle.utimes(now, entry.mtime);
			} finally {
				await handle.close();
			}
		}
	};

	const results = Array.from({length: entries.length});
	const settle = async (i, task) => {
		try {
			await task(entries[i]);
			results[i] = {status: 'fulfilled'};
		} catch (error) {
			results[i] = {status: 'rejected', reason: error};
		}
	};

	const order = [...entries.keys()];
	const symlinkOrder = order.filter(i => isSymlink(entries[i]));
	await Promise.all(order.filter(i => !isSymlink(entries[i]) && !isHardlink(entries[i])).map(i => settle(i, extractEntry)));
	await Promise.all(symlinkOrder.map(i => settle(i, extractEntry)));
	await Promise.all(order.filter(i => isHardlink(entries[i])).map(i => settle(i, extractEntry)));

	// Now every symlink exists, resolve chains for real
	await Promise.all(symlinkOrder
		.filter(i => results[i].status === 'fulfilled')
		.map(i => settle(i, entry => assertSymlinkResolvesInside(path.join(output, entry.path), entry.linkname, realOutputPath))));

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
