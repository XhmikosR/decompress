import fs from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import {fileURLToPath} from 'node:url';
import isJpg from 'is-jpg';
import test from 'ava';
import decompress from './index.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const isWindows = process.platform === 'win32';

const pathExists = async path => {
	try {
		await fs.access(path);
		return true;
	} catch {
		return false;
	}
};

test.serial.afterEach('ensure decompressed files and directories are cleaned up', async () => {
	await fs.rm(path.join(__dirname, 'directory'), {force: true, recursive: true});
	await fs.rm(path.join(__dirname, 'dist'), {force: true, recursive: true});
	await fs.rm(path.join(__dirname, 'example.txt'), {force: true, recursive: true});
	await fs.rm(path.join(__dirname, 'file.txt'), {force: true, recursive: true});
	await fs.rm(path.join(__dirname, 'edge_case_dots'), {force: true, recursive: true});
	await fs.rm(path.join(__dirname, 'symlink'), {force: true, recursive: true});
	await fs.rm(path.join(__dirname, 'test.jpg'), {force: true, recursive: true});
});

test('throw when invalid input is passed', async t => {
	await t.throwsAsync(async () => {
		await decompress([]);
	}, {message: 'Input file required'});
});

test('extract file', async t => {
	const tarFiles = await decompress(path.join(__dirname, 'fixtures', 'file.tar'));
	const tarbzFiles = await decompress(path.join(__dirname, 'fixtures', 'file.tar.bz2'));
	const targzFiles = await decompress(path.join(__dirname, 'fixtures', 'file.tar.gz'));
	const zipFiles = await decompress(path.join(__dirname, 'fixtures', 'file.zip'));

	t.is(tarFiles[0].path, 'test.jpg');
	t.true(isJpg(tarFiles[0].data));
	t.is(tarbzFiles[0].path, 'test.jpg');
	t.true(isJpg(tarbzFiles[0].data));
	t.is(targzFiles[0].path, 'test.jpg');
	t.true(isJpg(targzFiles[0].data));
	t.is(zipFiles[0].path, 'test.jpg');
	t.true(isJpg(zipFiles[0].data));
});

test('extract file using buffer', async t => {
	const tarBuf = await fs.readFile(path.join(__dirname, 'fixtures', 'file.tar'));
	const tarFiles = await decompress(tarBuf);
	const tarbzBuf = await fs.readFile(path.join(__dirname, 'fixtures', 'file.tar.bz2'));
	const tarbzFiles = await decompress(tarbzBuf);
	const targzBuf = await fs.readFile(path.join(__dirname, 'fixtures', 'file.tar.gz'));
	const targzFiles = await decompress(targzBuf);
	const zipBuf = await fs.readFile(path.join(__dirname, 'fixtures', 'file.zip'));
	const zipFiles = await decompress(zipBuf);

	t.is(tarFiles[0].path, 'test.jpg');
	t.is(tarbzFiles[0].path, 'test.jpg');
	t.is(targzFiles[0].path, 'test.jpg');
	t.is(zipFiles[0].path, 'test.jpg');
});

test.serial('extract file to directory', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'file.tar'), __dirname);

	t.is(files[0].path, 'test.jpg');
	t.true(isJpg(files[0].data));
	t.true(await pathExists(path.join(__dirname, 'test.jpg')));
});

(isWindows ? test.skip : test.serial)('extract symlink', async t => {
	await decompress(path.join(__dirname, 'fixtures', 'symlink.tar'), __dirname, {strip: 1});
	t.is(await fs.realpath(path.join(__dirname, 'symlink')), path.join(__dirname, 'file.txt'));
});

test.serial('extract directory', async t => {
	await decompress(path.join(__dirname, 'fixtures', 'directory.tar'), __dirname);
	t.true(await pathExists(path.join(__dirname, 'directory')));
});

test('strip option', async t => {
	const zipFiles = await decompress(path.join(__dirname, 'fixtures', 'strip.zip'), {strip: 1});
	const tarFiles = await decompress(path.join(__dirname, 'fixtures', 'strip.tar'), {strip: 1});

	t.is(zipFiles[0].path, 'test-strip.jpg');
	t.true(isJpg(zipFiles[0].data));
	t.is(tarFiles[0].path, 'test-strip.jpg');
	t.true(isJpg(tarFiles[0].data));
});

test('filter option', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'file.tar'), {
		filter: x => x.path !== 'test.jpg',
	});

	t.is(files.length, 0);
});

test('map option', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'file.tar'), {
		map(x) {
			x.path = `unicorn-${x.path}`;
			return x;
		},
	});

	t.is(files[0].path, 'unicorn-test.jpg');
});

test.serial('set mtime', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'file.tar'), __dirname);
	const stat = await fs.stat(path.join(__dirname, 'test.jpg'));
	t.deepEqual(files[0].mtime, stat.mtime);
});

test('return empty array if no plugins are set', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'file.tar'), {plugins: []});
	t.is(files.length, 0);
});

test.serial('throw when a location outside the root is given', async t => {
	await t.throwsAsync(async () => {
		await decompress(path.join(__dirname, 'fixtures', 'slipping.tar.gz'), 'dist');
	}, {message: /Refusing/});
});

(isWindows ? test.skip : test.serial)('throw when a location outside the root including symlinks is given', async t => {
	await t.throwsAsync(async () => {
		await decompress(path.join(__dirname, 'fixtures', 'slip.zip'), 'dist');
	}, {message: /Refusing/});
});

(isWindows ? test.skip : test.serial)('throw when a top-level symlink outside the root is given', async t => {
	await t.throwsAsync(async () => {
		await decompress(path.join(__dirname, 'fixtures', 'slip2.zip'), 'dist');
	}, {message: /Refusing/});
});

test.serial('throw when a directory outside the root including symlinks is given', async t => {
	await t.throwsAsync(async () => {
		await decompress(path.join(__dirname, 'fixtures', 'slipping_directory.tar.gz'), 'dist');
	}, {message: /Refusing/});
});

test.serial('allows filenames and directories to be written with dots in their names', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'edge_case_dots.tar.gz'), __dirname);
	t.is(files.length, 6);
	t.deepEqual(files.map(f => f.path).sort(), [
		'edge_case_dots/',
		'edge_case_dots/internal_dots..txt',
		'edge_case_dots/sample../',
		'edge_case_dots/ending_dots..',
		'edge_case_dots/x',
		'edge_case_dots/sample../test.txt',
	].sort());
});

test.serial('allows top-level file', async t => {
	const files = await decompress(path.join(__dirname, 'fixtures', 'top_level_example.tar.gz'), 'dist');
	t.is(files.length, 1);
	t.is(files[0].path, 'example.txt');
});

(isWindows ? test.skip : test.serial)('throw when chained symlinks to /tmp/dist allow escape outside root directory', async t => {
	await t.throwsAsync(async () => {
		await decompress(path.join(__dirname, 'fixtures', 'slip3.zip'), '/tmp/dist');
	}, {message: /Refusing/});
});
