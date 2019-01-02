const HyperVault = require('..')
const test = require('tape')
const pump = require('pump')
const fs = require('fs')
const rm = require('rimraf')
const path = require('path')
const RAM = require('random-access-memory')

test('folder indexer', t => {
  t.plan(3)
  HyperVault._indexFolder('node_modules/', (err, index) => {
    t.error(err)
    const entry = index['/tape/index.js']
    t.ok(entry)
    t.ok(typeof entry.mtime, 'number')
  })
})

test.only('distributed clocks & changes', (t) => {
  t.plan(40)

  setupVaults((vaults) => {
    const [v1, v2, v3] = vaults
    t.deepEqual(v2.hyperTime(), v3.hyperTime())
    v2.indexView((err, tree) => {
      t.error(err)
      t.notDeepEqual(tree, {})
      // v3's shared.txt was created last, thus v3 should be owner of current shared.txt
      const sharedOwner = v2.multi.feeds().find(f => {
        return f.key.toString('hex') === tree['/shared.txt'].id.split('@')[0]
      })
      t.equal(sharedOwner.discoveryKey.toString('hex'), v3._local.discoveryKey.toString('hex'))
      // v2 creates a new file and replicates with v1
      v2.writeFile(`frog.txt`, Buffer.from('amphibian'), (err, timestamp) => {
        t.error(err)
        replicate(v1, v2, err => {
          t.error(err)
          // v2 updates the file
          v2.writeFile('frog.txt', Buffer.from('amphibians have mucus glands'), (err) => {
            // v2 also deletes something cause I want see what delete looks like.
            v2.unlink('shared.txt', err => {
              t.error(err)
              // v1 updates the file.
              v1.writeFile('frog.txt', Buffer.from('toads'), (err) => {
                t.error(err)
                // v1 and v2 replicate
                replicate(v1, v2, err => {
                  t.error(err)
                  v1.indexView((err, tree) => {
                    t.error(err)
                    v2.readFile('frog.txt', (err, chunk) => {
                      t.error(err)
                      t.equal(chunk.toString('utf8'), 'toads') // Last write rule wins
                    })
                  })
                })
              })
            })
          })
        })
      })
    })
  })

  function replicate(a,b, cb) {
    let stream = a.replicate()
    pump(stream, b.replicate(), stream, cb)
  }

  function setupVaults(cb) {
    spawnVault(v1 => {
      spawnVault(v2 => {
        spawnVault(v3 => {
          // replicate v1 with v2
            replicate(v1, v2, err => {
            t.error(err)
            replicate(v2, v3, err => {
              t.error(err)
              // return initialized vaults preloaded with a shared and an individual file
              // v1 and v2 are only aware of eachother, while v2 and v3 are aware of all known archives.
              cb([v1, v2, v3])
            })
          })
        })
      })
    })
  }

  function spawnVault(done) {
    const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
    const vault = new HyperVault(pair.publicKey, null, pair.secretKey, {bare: true, storage: RAM})

    vault.ready((err) => {
      t.error(err)
      const alias = vault._local.discoveryKey.toString('hex').substr(0, 8)
      vault._alias = alias // let's attach a small tag to each vault for easier testing.
      vault.writeFile(`individual_${alias}.txt`, Buffer.from(alias), (err) => {
        t.error(err)
        vault.writeFile('shared.txt', Buffer.from(alias), (err, timestamp) => {
          t.error(err)
          done(vault)
        })
      })
    })
  }
})

test('Reflection', function(t) {
  t.plan(19)
  const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
  const testDir = '/tmp/reflectionTest'
  const vault = new HyperVault(pair.publicKey, testDir, pair.secretKey)

  // cleanup testdir leftovers from previous run.
  if (fs.existsSync(testDir)) rm(testDir, setup)
  else setup()

  function setup(err) {
    t.error(err)

    vault.ready(function(err){
      t.error(err)
      let file = fs.readFileSync('package.json')
      vault.writeFile('package.json', file, function(err){
        t.error(err)
        file = fs.readFileSync('../cat.png')
        vault.writeFile('pictures/cat.png', file, function(err){
          t.error(err)
          // First reflection, exports our files.
          vault.reflect((err, changes, timestamp) => {
            t.error(err)
            // check changelog integrity
            t.equal(Object.keys(changes).length, 2, 'Two file entries')
            t.equal(changes['/package.json'], 'export')
            t.equal(changes['/pictures/cat.png'], 'export')

            // Check the mod times
            vault._local.lstat('package.json', (err, hyperStat) => {
              let fileStat = fs.lstatSync(path.join(testDir, 'package.json'))
              t.equal(fileStat.mtime.getTime(), hyperStat.mtime.getTime(), 'exported mtime is reflected')
            })

            // attempt adding file through reflection.
            pump(fs.createReadStream('README.md'), fs.createWriteStream(path.join(testDir, 'IMPORTME.md')), (err) => {
              t.error(err)
              vault.reflect((err, changes) => {
                t.error(err)
                t.equal(Object.keys(changes).length, 3, 'Three file entries')
                t.equal(changes['/IMPORTME.md'], 'import')
                t.equal(changes['/package.json'], 'nop')
                t.equal(changes['/pictures/cat.png'], 'nop')

                // check imported mtime
                vault._local.lstat('IMPORTME.md', (err, hyperStat) => {
                  t.error(err)
                  let fileStat = fs.lstatSync(path.join(testDir, 'IMPORTME.md'))
                  t.equal(fileStat.mtime.getTime(), hyperStat.mtime.getTime(), 'imported mtime is reflected')
                  fs.unlink(path.join(testDir, 'package.json'), err => {
                    vault.reflect((err, changes) => {
                      t.error(err)
                      vault.indexView((err, tree) => {
                        t.error(err)
                        t.equal(tree['/package.json'].deleted, true)
                        debugger
                      })
                    })
                  })
                })
              })
            })
          })
        })
      })
    })
  }
})

test.skip('dat-storage experiment',(t) => {
  let storage = require('dat-storage')
  let hyperdrive = require('hyperdrive')
  let p = storage('_what/')
  let drive = hyperdrive(p, {latest: true})
  debugger
  drive.ready((err) => {
    t.error(err)
    let bin = fs.readFileSync('../cat.png')
    drive.writeFile('cat.png', bin, (err) => {
      t.error(err)
      debugger
    })
  })
})
