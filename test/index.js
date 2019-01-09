const HyperVault = require('..')
const test = require('tape')
const pump = require('pump')
const fs = require('fs')
const rm = require('rimraf')
const path = require('path')
const RAM = require('random-access-memory')
const debug = require('debug')('hypervault-test')
const crypto = require('crypto')

test('folder indexer', t => {
  t.plan(3)
  HyperVault._indexFolder('node_modules/', (err, index) => {
    t.error(err)
    const entry = index['/tape/index.js']
    t.ok(entry)
    t.ok(typeof entry.mtime, 'number')
  })
})

test('distributed clocks & changes', (t) => {
  t.plan(26)

  setupVaults((vaults) => {
    const [v1, v2, v3] = vaults
    t.deepEqual(v2.hyperTime(), v3.hyperTime(), 'compare hypertime')
    v2.indexView((err, tree) => {
      t.error(err)
      t.notDeepEqual(tree, {}, 'Tree not empty')
      // v3's shared.txt was created last, thus v3 should be owner of current shared.txt
      const sharedOwner = v2.multi.feeds().find(f => {
        return f.key.toString('hex') === tree['/shared.txt'].id.split('@')[0]
      })
      t.equal(sharedOwner.discoveryKey.toString('hex'), v3._local.discoveryKey.toString('hex'))
      // v2 creates a new file and replicates with v1
      v2.writeFile(`frog.txt`, Buffer.from('amphibian'), (err, timestamp) => {
        t.error(err)
        debug('First repl START')
        replicate(v1, v2, err => {
          t.error(err)
          debug('First repl DONE')
          // v2 updates the file
          v2.writeFile('frog.txt', Buffer.from('amphibians have mucus glands'), (err) => {
            // v2 also deletes something cause I want see what delete looks like.
            v2.unlink('shared.txt', err => {
              t.error(err)
              let v1EventsCount = v1._local._bin.length
              // v1 updates the file.
              v1.writeFile('frog.txt', Buffer.from('toads'), (err) => {
                t.error(err)
                t.equal(v1._local._bin.length, v1EventsCount + 1, 'Change should have created new block')
                const shit = v2.multi.feeds().find(f => f.key.toString('hex') === v1._local.key.toString('hex'))
                t.equal(shit._bin.length, v1EventsCount, 'V2 should not yet be aware of the new change')
                // v1 and v2 replicate
                debug('Second repl START')
                replicate(v1, v2, err => {
                  debug('Second repl DONE')
                  t.error(err)
                  t.equal(shit._bin.length, v1._local._bin.length, 'Changes should have been replicated')

                  v1.indexView((err, tree) => {
                    t.error(err)
                    v2.readFile('frog.txt', (err, chunk) => {
                      t.error(err)
                      t.equal(chunk.toString('utf8'), 'toads', 'Last write wins')
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
        vault.writeFile('shared.txt', Buffer.from(alias), (err) => {
          t.error(err)
          done(vault)
        })
      })
    })
  }
})

test('Reflection', function(t) {
  t.plan(34)
  const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
  const testDir = '/tmp/reflectionTest'
  const vault = new HyperVault(pair.publicKey, testDir, pair.secretKey)

  // cleanup testdir leftovers from previous run.
  if (!fs.existsSync(testDir)) setup()
  else rm(testDir, {}, (err) => process.nextTick(setup, err))

  function setup(err) {
    t.error(err)
    t.equal(fs.existsSync(testDir), false, 'testfolder should not exist')
    function testBidirectionalEdits(vault) {
      const vfile = '/EDITME.txt'
      const file = path.join(testDir, vfile)

      fs.writeFile(file, 'foo bar', err => {
        t.error(err)
        vault.reflect(changes => {
          vault.readFile(vfile, (err, chunk) => {
            t.error(err)
            t.equal(chunk.toString('utf8'), 'foo bar')
            // Simulate remote change
            vault.writeFile(vfile, 'DEADBEEF', err => {
              t.error(err)
              vault.reflect((err, changes) => {
                t.error(err)
                t.equal(changes[vfile].action, 'export')
                // Verify that it got updated.
                fs.readFile(file, (err,chunk) => {
                  t.equal(chunk.toString('utf8'), 'DEADBEEF')
                  t.end()
                })
              })
            })
          })
        })
      })
    }


    vault.ready(function(err){
      t.error(err)
      let file = fs.readFileSync('package.json')
      vault.writeFile('package.json', file, function(err){
        t.error(err)

        vault.writeFile('pictures/cat.png', Buffer.from('this is not a cat'), function(err){
          t.error(err)
          // First reflection, exports our files.
          vault.reflect((err, changes, timestamp) => {
            t.error(err)
            // check changelog integrity

            t.equal(Object.keys(changes).length, 2, 'Two file entries')
            t.equal(changes['/package.json'].action, 'export')
            t.equal(changes['/pictures/cat.png'].action, 'export')
            let picContents = fs.readFileSync(path.join(testDir,'/pictures/cat.png'))
            t.equal(picContents.toString('utf8'), 'this is not a cat', 'Exported content correct')
            // Check the mod times
            vault.lstat('package.json', (err, hyperStat) => {
              let fileStat = fs.lstatSync(path.join(testDir, 'package.json'))
              t.equal(fileStat.mtime.getTime(), hyperStat.mtime.getTime(), 'exported mtime is reflected')
            })

            // attempt adding file through reflection.
            fs.writeFile(path.join(testDir, 'IMPORTME.md'), 'imported', (err) => {
              t.error(err)
              vault.reflect((err, changes) => {
                t.error(err)
                t.equal(Object.keys(changes).length, 3, 'Three file entries')
                t.equal(changes['/IMPORTME.md'].action, 'import')
                t.equal(changes['/package.json'].action, 'nop')
                t.equal(changes['/pictures/cat.png'].action, 'nop')
                // check imported content
                vault.readFile('/IMPORTME.md', (err, chunk) => {
                  t.error(err)
                  t.equal(chunk.toString('utf8'), 'imported', 'Imported content correct')
                  // check imported mtime
                  vault.lstat('IMPORTME.md', (err, hyperStat) => {
                    t.error(err)
                    let fileStat = fs.lstatSync(path.join(testDir, 'IMPORTME.md'))
                    t.equal(fileStat.mtime.getTime(), hyperStat.mtime.getTime(), 'imported mtime is reflected')
                    // Local delete generates a delete event.
                    fs.unlink(path.join(testDir, 'package.json'), err => {
                      vault.reflect((err, changes) => {
                        t.error(err)
                        vault.indexView((err, tree) => {
                          t.error(err)
                          t.equal(tree['/package.json'].deleted, true, 'local delete is registered')
                          // Remote delete (or rename) causes the file to
                          // dissapear
                          vault.unlink('IMPORTME.md', (err) => {
                            t.error(err)
                            vault.reflect((err, changes) => {
                              t.equal(changes['/IMPORTME.md'].action, 'delete', 'Reflect action = delete')
                              t.equal(fs.existsSync(path.join(testDir, 'IMPORTME.md')), false, 'File was removed from folder')
                              testBidirectionalEdits(vault)
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
        })
      })
    })
  }
})

test.only('larger file integrity', (t) => {
  t.plan(5)
  const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
  const vault = new HyperVault(pair.publicKey, null, pair.secretKey, {bare: true, storage: RAM})
  const size = 1024 * 1024 * 40 // 40mb
  crypto.randomBytes(size, (err, data) => {
    t.error(err)
    t.equal(data.length, size)
    vault.writeFile('file.bin', data, (err) => {
      t.error(err)
      vault.readFile('file.bin', (err, output) => {
        t.equal(output.length, data.length, 'Size should match')
        t.equal(data.compare(output), 0, 'Input and output matches')
        t.end()
      })
    })
  })
})
