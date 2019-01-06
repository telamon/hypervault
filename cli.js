#!/usr/bin/env node
const HyperVault = require('.')
const utils = HyperVault.utils
const parseArgs = require('minimist')
const pump = require('pump')

const usage = `
usage: hypervault SUBCOMMAND [OPTS]
Available subcommands:
\t init [-b/--bare] [-k/--vault=KEY] PATH
\t initializes a hypervault at target 'PATH'
\t -b/--bare \tdisables reflection, vault contents will not be checked out.
\t -k/--vault \t create a read-only clone of 'KEY'

\t repl[licate] [-n/--no-watch] PATH
\t starts replicating an previously initialized vault
\t If vault was not initalized with --bare then it will also synchronize
\t the currently checked out files in the folder.
\t  -n/--nowatch  stop process after a one-shot replicaton.

\t ------------------ not implemented yet ----------------
\t serve path [KEY]
\t key is required unless path contains a previously initialized vault.
\t Alias for 'hypervault init --bare --key=KEY PATH && hypervault repl PATH'
\t Dedicated replication without private-keys

\t share
\t prints this vault's pubkey and exits
\t
\t permit
\t remove
`
const argv = parseArgs(process.argv.slice(2))
const subcommand = argv._[0] ? argv._.shift().toLowerCase() : null

if (!subcommand || subcommand === 'help' || argv.h || argv.help) {
  process.stdout.write(usage)
  process.exit(1)
}

if (subcommand === 'init') {
  return utils.initRepo(argv)
}

if (subcommand.match(/^repl(?:icate)?$/ || subcommand === 'sync')) return utils.replicate(argv)

process.stdout.write(usage)
process.exit(1)

const net = require('net')

const pair = HyperVault.passwdPair('replication', 'test')
const vault = new HyperVault(pair.publicKey, "/tmp/vault-test", pair.secretKey)

const server = new net.Server(onConnection)

vault.ready(() => {
  vault.reflect((err, changes) => {
    if (err) throw err
    start()
  })
})

function start () {
  const port = 8894
  const remoteAddr = process.argv[process.argv.indexOf(__filename) + 1]
  if (!remoteAddr) {
    // accept connections if run in server mode
    server.listen(port, () => {
      console.log('Server listening on 8894')
    })
  }else {
    // try to connect if address was provided.
    console.log(`Connecting to: ${remoteAddr}:8894`)
    const handle = net.createConnection(port, remoteAddr, onConnection)
  }
}

function onConnection(connection) {
  const stream = vault.replicate()
  pump(stream, connection, stream, (err) => {
    if (err) throw err
    console.log('replication finished')
    vault.reflect((err, changes) => {
      if (err) throw err
      process.exit(0)
    })
  })
}
