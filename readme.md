# decompress [![npm version](https://img.shields.io/npm/v/@xhmikosr/decompress?logo=npm&logoColor=fff)](https://www.npmjs.com/package/@xhmikosr/decompress) [![CI Status](https://img.shields.io/github/actions/workflow/status/XhmikosR/decompress/ci.yml?branch=master&label=CI&logo=github)](https://github.com/XhmikosR/decompress/actions/workflows/ci.yml?query=branch%3Amaster)

> Extracting archives made easy

*See [decompress-cli](https://github.com/kevva/decompress-cli) for the command-line version.*

## Install

```sh
npm install @xhmikosr/decompress
```


## Usage

```js
import decompress from '@xhmikosr/decompress';

decompress('unicorn.zip', 'dist').then(files => {
	console.log('done!');
});
```


## API

### decompress(input, [output], [options])

Returns a Promise for an array of files in the following format:

```js
{
	data: Buffer,
	mode: Number,
	mtime: String,
	path: String,
	type: String
}
```

#### input

Type: `string` `Buffer`

File to decompress.

#### output

Type: `string`

Output directory.

#### options

##### filter

Type: `Function`

Filter out files before extracting. E.g:

```js
decompress('unicorn.zip', 'dist', {
	filter: file => path.extname(file.path) !== '.exe'
}).then(files => {
	console.log('done!');
});
```

*Note that in the current implementation, **`filter` is only applied after fully reading all files from the archive in memory**. Do not rely on this option to limit the amount of memory used by `decompress` to the size of the files included by `filter`. `decompress` will read the entire compressed file into memory regardless.*

##### map

Type: `Function`

Map files before extracting: E.g:

```js
decompress('unicorn.zip', 'dist', {
	map: file => {
		file.path = `unicorn-${file.path}`;
		return file;
	}
}).then(files => {
	console.log('done!');
});
```

##### plugins

* Type: `Array`
* Default: `[decompressTar(), decompressTarbz2(), decompressTargz(), decompressUnzip()]`

Array of [plugins](https://www.npmjs.com/browse/keyword/decompressplugin) to use.

##### strip

* Type: `number`
* Default: `0`

Remove leading directory components from extracted files.


## License

MIT © [Kevin Mårtensson](https://github.com/kevva)
