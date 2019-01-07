HyperVault
==========

Hypervault aims to become a personal cloud-storage replacement using p2p
technology, inspired by TahoeLAFS & the DAT-project.

Oh, and we also support multiple writers! :>

## Usage

```bash
# Initialize a new vault-folder called `myvault`

npx hypervault init myvault --repl

#<provide a secret passphrase and press enter>



# Resume a previously initialized vault

npx hypervault repl myvault

#<provide same passphrase as during init>

```

Your folder should now become populated with files created by anyone who
provided the same password during init&repl.

Communications are completely encrypted using derived keys and hypercore-protocol,
meaning password never leaves your computer.
At the moment of writing your files are not yet encrypted, so I wouldn't recommend
setting up a dedicated replicator on an untrusted computer.

To share your folder with a trusted party you have two alternatives:
1. For read-only access; give them your hypervault public-key that was displayed during
   init. the other party then can use `hypervault init <pubkey> && hypervault
   repl <pubkey>` to start replicating.

2. For write access; give them your password. But once the cat is out of the
   box..

We're making plans on improving the sharing mechanism to make the behaviour
a bit more natural.

For more info about design and implementation check out
[ARCHITECTURE.md](ARCHITECTURE.md)


## Hypervault API

```js
const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
const vault = new HyperVault(pair.publicKey, null, pair.secretKey)
```

#### `new HyperVault(key, path, secret, opts)`

Initializes a new vault in folder `path` using `key` for discovery.
Changes you make to the drive will not be replicated if `secret` is omitted

`opts` can include:

```
{
  // Inspired by git, causes your vault to use a checked out tree.
  bare: Boolean, // default: false
  // random-access compatible storage
  storage: RandomAccess  // default: random-access-file
}
```


#### `vault.indexView(callback)`

Returns a hash representing the virtual file-tree

`callback` will receive arguments `err` and `tree`

#### `vault.readdir(path, callback)`

Not implemented yet, use `indexView` and filter non matching keys.

#### `vault.replicate(opts)`

Returns a replication stream, see hypercore.replicate() for compatible `opts`

#### `vault.ready(callback)`

`callback` is triggered when the vault has finished initializing or immediately
if the vault is already initialized. callback takes no parameters.

#### `vault.writeFile(path, data, opts, callback)`

Writes content as a file in the virtual filesystem.

`path` Absolute path to file e.g. a value of `/pictures/cat.jpg` will be
reflected as `path/to/my/vault/pictures/cat.jpg`.

`data` A string or a Buffer containing the contents.

`opts` not documenting yet, but will contain possibility to set executable flag for
file mode, and maybe timestamps. (uid/gid/mode support dosen't make sense in
a shared-environment)

`callback` will recieve argument `err` on unsuccessful write

#### `vault.readFile(path, callback)`

Reads a file from the vault.

`path` virtual path to file

`callback` will receive arguments `err` and `data`

#### `vault.unlink(path, callback)`

Deletes a file from the vault.

`path` virtual path to file

`callback` will receive argument `err`

#### `vault.createReadStream(path, opts, callback)`

Creates a readable Stream to file in vault

`path` virtual path to file

`opts` can include:

```
{
  // Wait until downloaded
  wait: Boolean, // default: false
}
```

`callback` will receive argument `err` and `stream`.
 `err` will be passed if file doesn't exist
  or if file is not yet available and `opts.wait` was set to `false`

#### `vault.createWriteStream(path, opts, callback)`

Creates a writable Stream to file in vault

`path` virtual path to file

`opts` same as for `writeFile`, check the source/ nothing usable yet.

`callback` will receive argument `err` and `stream`.

#### `vault.exportFile(path, destination, opts, callback)`

Exports file from vault to filesystem, also sets the timestamps time and mode
as registered in vault.

`path` virtual path to file

`destination` physical path

`opts` see `vault.readFile`

`callback` will receive argument `err`


#### `vault.importFile(path, source, callback)`

Import file from filesystem to vault, also imports file's mode and timestamps.

`path` virtual path to file

`source` path to file to import

`callback` will receive argument `err`

#### `vault.lstat(path, callback)`

Fetches an the virtual filesystem entry for given  `path`
(compared to hyperdrive it does not support full node.js Stat compatibility)

`path` virtual path to file

`callback` recieves two arguments: `err`, `stat`

*A note on directories*
In order to maintain some sort of simplicity, hypervault does not support creation or registration of empty folders.
Folders are currently simulated via file-path but don't have their own entries.
Feel free to contact me or open an issue if you really need it.

## Current Status

| Feature                     | Status         |
| --------------------------- | -------------: |
| kappafs                     | not documented |
| metadrive                   | done           |
| cli                         | alpha          |
| swarm/discovery             | done           |
| folder mirroring/reflection | done           |
| Storage Encryption          | todo           |
| FUSE support                | todo           |
| friend signature management | todo           |
| Less hacky UI               | todo           |

## License

This project is release under GNU AGPLv3 license

