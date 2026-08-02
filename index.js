import {Buffer} from 'node:buffer';
import {constants as fsConstants} from 'node:fs';
// realpath follows symlinks, so a target that escapes via a symlink is caught
import {
	lstat,
	open as openFile,
	realpath,
	unlink,
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
// Node 18 fs.promises.realpath rejects Windows trailing-dot dir names; the callback realpath does not
const realpathDir = promisify(fs.realpath);
const symlink = promisify(fs.symlink);
const utimes = promisify(fs.utimes);

const IS_WINDOWS = process.platform === 'win32';
// Names Windows treats as device files, with or without an extension (`NUL.txt` is still `NUL`)
const WINDOWS_RESERVED_NAME = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i;

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

const runPlugins = (input, options) => {
	if (options.plugins.length === 0) {
		return Promise.resolve([]);
	}

	return Promise.all(options.plugins.map(x => x(input, options)))
		// eslint-disable-next-line unicorn/no-array-reduce
		.then(files => files.reduce((a, b) => [...a, ...b]));
};

const isInsideOutput = (target, root) => {
	const rel = path.relative(root, target);
	// '' is the dir itself; a `..` or an absolute path (different drive on Windows) is outside it
	return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

const safeMakeDir = (dir, realOutputPath) => realpathDir(dir)
	.catch(_ => {
		const parent = path.dirname(dir);
		return safeMakeDir(parent, realOutputPath);
	})
	.then(realParentPath => {
		if (!isInsideOutput(realParentPath, realOutputPath)) {
			throw new Error('Refusing to create a directory outside the output path.');
		}

		return mkdir(dir, {recursive: true}).then(() => realpathDir(dir));
	});

const ensureLinkTargetInsideOutput = (linkname, linkBase, realOutputPath) => {
	const target = path.resolve(linkBase, linkname);

	if (!isInsideOutput(target, realOutputPath)) {
		return Promise.reject(new Error(`Refusing to create a link pointing outside the output directory: ${target}`));
	}

	// An existing target may itself be a symlink that escapes, so check its real path
	return realpath(target).then(
		realTarget => {
			if (!isInsideOutput(realTarget, realOutputPath)) {
				throw new Error(`Refusing to create a link pointing outside the output directory: ${realTarget}`);
			}

			return target;
		},
		// Dangling target; the path check above covers it
		_ => target,
	);
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
			return path.join(await realpath(existing), ...tail);
		} catch {
			const parent = path.dirname(existing);
			if (parent === existing) {
				return target;
			}

			tail.unshift(path.basename(existing));
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

const extractFile = (input, output, options) => runPlugins(input, options).then(async files => {
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

	// Two entries at one path let a symlink and a write race the same destination
	const seenPaths = new Set();
	for (const x of files) {
		const key = IS_WINDOWS ? x.path.toLowerCase() : x.path;
		if (seenPaths.has(key)) {
			throw new Error(`Refusing to extract an archive with a duplicate entry path: ${x.path}`);
		}

		seenPaths.add(key);
	}

	await mkdir(output, {recursive: true});
	const realOutputPath = await realpathDir(output);
	const umask = process.umask();
	const now = new Date();

	const extractOne = x => {
		assertSafeEntryPath(x.path);
		const dest = path.join(output, x.path);

		if (x.type === 'directory') {
			return safeMakeDir(dest, realOutputPath).then(() => utimes(dest, now, x.mtime));
		}

		// Attempt to ensure parent directory exists (failing if it's outside the output dir)
		return safeMakeDir(path.dirname(dest), realOutputPath)
			.then(() => realpathDir(path.dirname(dest)))
			.then(realDestinationDir => {
				if (!isInsideOutput(realDestinationDir, realOutputPath)) {
					throw new Error(`Refusing to write outside output directory: ${realDestinationDir}`);
				}

				if (x.type === 'link') {
					// Hardlink target is relative to the extraction root
					return ensureLinkTargetInsideOutput(x.linkname, realOutputPath, realOutputPath)
						.then(target => assertNotSymlink(target).then(() => link(target, dest)));
				}

				if (x.type === 'symlink' && IS_WINDOWS) {
					// No symlinks on Windows; emulate with a hardlink relative to the link's real dir
					return ensureLinkTargetInsideOutput(x.linkname, realDestinationDir, realOutputPath)
						.then(target => assertNotSymlink(target).then(() => link(target, dest)));
				}

				if (x.type === 'symlink') {
					// Lexical fast-reject; assertSymlinkResolvesInside is the real guard
					return ensureLinkTargetInsideOutput(x.linkname, realDestinationDir, realOutputPath)
						.then(() => symlink(x.linkname, dest));
				}

				// Never honor setuid/setgid/sticky bits from an archive
				const mode = (x.mode & 0o777) & ~umask; // eslint-disable-line no-bitwise
				// O_NOFOLLOW so a symlink planted at dest can't redirect the write
				const flags = fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_TRUNC | (fsConstants.O_NOFOLLOW || 0); // eslint-disable-line no-bitwise
				return openFile(dest, flags, mode)
					.catch(error => {
						if (error.code === 'ELOOP') {
							throw new Error('Refusing to write into a symlink');
						}

						throw error;
					})
					.then(handle => handle.writeFile(x.data)
						.then(() => handle.utimes(now, x.mtime))
						.finally(() => handle.close()));
			});
	};

	const isSymlinkEntry = x => x.type === 'symlink' && !IS_WINDOWS;
	const isHardlinkEntry = x => x.type === 'link' || (x.type === 'symlink' && IS_WINDOWS);
	const symlinks = files.filter(x => isSymlinkEntry(x));

	// Files and dirs first, then symlinks, then hardlinks (which may target a symlink)
	await Promise.all(files.filter(x => !isSymlinkEntry(x) && !isHardlinkEntry(x)).map(x => extractOne(x)));
	await Promise.all(symlinks.map(x => extractOne(x)));
	await Promise.all(files.filter(x => isHardlinkEntry(x)).map(x => extractOne(x)));

	// Every symlink now exists, so self-referential chains can be resolved for real
	await Promise.all(symlinks.map(x => assertSymlinkResolvesInside(path.join(output, x.path), x.linkname, realOutputPath)));

	return files;
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
