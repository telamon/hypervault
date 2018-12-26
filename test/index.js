const HyperVault = require('..')
const test = require('tape')
const pump = require('pump')
const fs = require('fs')
const rm = require('rimraf')
const path = require('path')

test('folder indexer', async function(t) {
  t.plan(3)
  HyperVault._indexFolder('node_modules/', (err, index) => {
    t.error(err)
    const entry = index['/tape/index.js']
    t.ok(entry)
    t.ok(typeof entry.mtime, 'number')
  })
})

test('Reflection', function(t) {
  t.plan(17)
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
