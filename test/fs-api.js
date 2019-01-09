const test = require('tape')
const HyperVault = require('..')
const RAM = require('random-access-memory')

function spawnVault(done) {
  const pair = HyperVault.passwdPair('telamohn@pm.me', 'supersecret')
  const vault = new HyperVault(pair.publicKey, null, pair.secretKey, {bare: true, storage: RAM})
  vault.ready((err) => {
    if (err) return done(err)
    const alias = vault._local.discoveryKey.toString('hex').substr(0, 8)
    vault.writeFile(`subfolder/alias.txt`, Buffer.from(alias), (err, timestamp) => {
      if (err) return done(err)
      vault.writeFile('README.md', Buffer.from('Hello world!'), (err, timestamp) => {
        if (err) return done(err)
        vault.writeFile('subfolder/bar/foo.md', Buffer.from('fubar'), (err, timestamp) => {
          if (err) return done(err)
          done(null, vault)
        })
      })
    })
  })
}

test('readdir', t => {
  t.plan(7)
  spawnVault((err, vault) => {
    t.error(err)
    vault.readdir('/', (err, list) => {
      t.error(err)
      t.deepEqual(list, ['subfolder','README.md'])
      vault.readdir('/subfolder', (err, list) => {
        t.error(err)
        t.deepEqual(list, ['bar', 'alias.txt'])
        vault.readdir('nonexisting', (err, list) => {
          t.ok(err) // TODO: check for code ENOENT
          t.ok(!list)
          t.end()
        })
      })
    })
  })
})

test.only('lstat', t => {
  spawnVault((err, vault) => {
    t.error(err)
    // stat file
    vault.lstat('README.md', (err, stat) => {
      t.error(err)
      // TODO: assert that necessary keys exist
      // TODO: assert that it is a file
      vault.lstat('subfolder', (err, stat) => {
        t.error(err)
        // TODO: use magic to derive that the 'subfolder' truly exists.
        // TODO: provide decent 'virtual' stat to enable read/write
      })
    })
  })
})

test('open & close', t => {
  spawnVault((err, vault) => {
    t.error(err)
    vault.open('README.md', 'r', (err, fd) => {
      t.error(err)
      t.equal(typeof fd, 'number')
      vault.close(fd, err => t.error(err))
    })
  })
})

// read(fd, buffer, offset, length, position, callback)
test('read', t => {
  spawnVault((err, vault) => {
    t.error(err)
    vault.open('README.md', 0, (err, fd) => {
      t.error(err)
      vault.fread(fd, 0, 5, (err, chunk) => {
        t.error(err)
        t.equal(chunk.toString('utf8'), 'Hello')
        vault.close(fd, err => t.error(err))
      })
    })
  })
})

// write(fd, buffer[, offset[, length[, position]]], callback)
test('write', t => {
  spawnVault((err, vault) => {
    t.error(err)
    vault.open('README.md', 2, (err, fd) => {
      t.error(err)
      vault.write(fd, Buffer.from('change'), 5, (err, bytesWritten) => {
        t.error(err)
        t.equal(bytesWritten, 6)
        vault.close(fd, err => t.error(err))
      })
    })
  })
})

