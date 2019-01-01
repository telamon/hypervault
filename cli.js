#!/usr/bin/env node
const HyperVault = require('.')
const net = require('net')
const pump = require('pump')

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
