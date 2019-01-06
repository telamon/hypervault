const HyperVault = require('..')
const HypervaultSwarm = require('../lib/swarm')
const test = require('tape')
const RAM = require('random-access-memory')
const debug = require('debug')('hypervault-test')

test.only ('Initializing a swarm', (t) => {
  t.plan(400)

  spawnVault(vault => {
    const swarm = new HypervaultSwarm(vault)
    swarm.join()
  })

  function spawnVault(done) {
    const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
    const vault = new HyperVault(pair.publicKey, null, pair.secretKey, {bare: true, storage: RAM})

    vault.ready((err) => {
      t.error(err)
      vault.writeFile(`test.txt`, Buffer.from("foo"), (err) => {
        t.error(err)
        if (!err) done(vault)
      })
    })
  }
})
