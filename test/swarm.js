const HyperVault = require('..')
const HypervaultSwarm = require('../lib/swarm')
const test = require('tape')
const RAM = require('random-access-memory')
const debug = require('debug')('hypervault-test')

test.skip ('Initializing a swarm', (t) => {
  t.plan(3)

  spawnVault(vault => {
    const swarm = new HypervaultSwarm(vault)
    swarm.join() // this test doesn't really test anything yet.
    vault.importFile('test.json', 'package.json', (err) => {
      t.error(err)
      swarm.destroy(t.end)
    })
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
