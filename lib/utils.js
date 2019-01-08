/**
 * Sorry for the mess, I ran out of time and lost patience.
 * I have no clue how this code works
 * */

// const hyperswarm = require('hyperswarm')
const minimist = require('minimist')

module.exports.printVaultStatus = function printVaultStatus (vault) {
  const sum = {}
  sum['vault id'] = vault.key.toString('hex')
  sum['path'] = vault.repo
  sum['writable'] = vault.writable
  sum['bare'] = vault.bare
  console.table(sum)
}

module.exports.pathContainsVault = function pathContainsVault(rpath) {
  const fs = require('fs')
  const path = require('path')
  // TODO: write better test conditionals.
  const isRegular = fs.existsSync(path.join(rpath, '.hypervault', 'signatures.json'))

  const isBare = fs.existsSync(path.join(rpath, 'signatures.json'))
  if (isRegular) return 1
  if (isBare) return 2
  return 0
}

module.exports.replicate = function replicate(argv) {
  const HyperVault = require('..')
  const debug = require('debug')('hypervault-cli-repl')
  const prompt = require('prompt')
  let [repoPath, pubkey] = argv._
  if (!repoPath) repoPath = process.cwd()
  const isVault = module.exports.pathContainsVault(repoPath)
  const bare = isVault === 2

  const noWatch = argv.n  || (typeof argv.watch !== 'undefined' && !argv.watch)
  if (noWatch) console.log('Doing a one-shot replication')



  // OK SO prompting for credentials every time might not be the
  // desired behaviour, and not really needed for write mode,
  // credentials are only needed when you want to create a new
  // writer, but i have to refactor the hypervault initialization
  // code before that.
  const promptForSecret = () => {
    prompt.message = null
    prompt.start();
    const schema = {
      properties: {
        //      ident: { message: 'ident ', required: true},
        secret: { message: 'password ', hidden: true, required: true}
      }
    }

    prompt.get(schema, (err, {secret}) => {
      prompt.stop()
      swarmAndReplicate(secret)
    })

  }

  const swarmAndReplicate = (secret) => {
    const {publicKey, secretKey} = HyperVault.passwdPair(secret, secret)

    const vault = new HyperVault(publicKey, repoPath, secretKey, {bare})
    vault.ready((err) => {
      if (err) throw err
      debug('vault loaded successfully')
      debug('lauching swarm')
      const HypervaultSwarm =  new require('./swarm')
      const swarm = new HypervaultSwarm(vault, {noWatch})
      swarm.join()

      process.once('SIGINT', function () {
        console.log('Shutting down ...')
        swarm.destroy(() => {
          process.exit(0)
        })
      })
    })
  }

  if (argv.secret) {
    swarmAndReplicate(`${argv.secret}`)
  } else {
    promptForSecret()
  }
}

// CLI-utility, don't attempt to run this in a browser.
module.exports.initRepo = function initRepo (argv) {
  const fs = require('fs')
  const path = require('path')
  const HyperVault = require('..')
  let [repoPath, pubkey] = argv._
  if (!repoPath) repoPath = process.cwd()

  const bare = !!argv.bare

  ensureFolder((err) => {
    if (err) {
      console.error(...err)
      process.exit(1)
    }

    if (pubkey) createVaultAndExit(pubKey)
    else {
      console.log(`No vault-key provided, using ident/password combo via prompt`)
      console.log(`Don't forget your ident/password! Due to security there is`)
      console.log(`absolutely no way to recover it if lost!`)

      promptPasswdPair((err, res) =>  {
        if (err) throw err
        const {publicKey, secretKey} = res
        createVaultAndExit(publicKey, secretKey)
      })
    }
  })

  function ensureFolder (callback) {
    if (module.exports.pathContainsVault(repoPath)) {
      callback(['There is already an initialized vault located in\n', repoPath])
    } else {
      fs.stat(repoPath, (err, stat) => {
        if (err && err.code !== 'ENOENT') return callback([err])

        // Don't allow bare repos to be initialized in populated folders
        if (bare && stat && stat.isDirectory()) {
          return fs.readdir(repoPath, (err, list) => {
            if (err) return callback([err])
            if (list.length !== 0) {
              callback(['Error: directory not empty\n', repoPath])
            } else callback(null)
          })
        } else if (stat && stat.isDirectory()) {
          return callback(null)
        }

        // Try to create repo directory if parent dir exists
        if (!stat) fs.stat(path.dirname(repoPath), (err, stat) => {
          if (stat && stat.isDirectory()) {
            return fs.mkdir(repoPath, (err) => {
              if (err) return callback([err])
              callback(null) // folder created successfully.
            })
          }
          callback(['Error: failed to create repository\n', repoPath, err])
        })
      })
    }
  }

  function createVaultAndExit(publicKey, secretKey) {
    if (!secretKey) console.log(`Initializing a read-only vault`)
    const vault = new HyperVault(publicKey, repoPath, secretKey, {bare})

    vault.ready((err) => {
      if (err) {
        console.log('Failed to create vault', err)
        process.exit(1)
      } else {
        console.log('\n\nYour shiny new vault has been created!')
        module.exports.printVaultStatus(vault)
        if (!argv.repl) {
          process.exit(0)
        } else if(!bare) {
          argv._.push(publicKey)
          argv.secret = secretKey
          module.exports.replicate(argv)
        }
      }
    })
  }

  function promptPasswdPair (callback) {
    const prompt = require('prompt')
    prompt.message = null
    prompt.start();
    const schema = {
      properties: {
        //ident: { message: 'ident/lucky-number' , required: true},
        secret: { message: 'password ', hidden: true , required: true},
        //secret2: { message: 'retype password', hidden: true, required: true}
      }
    }

    prompt.get(schema, (err, {secret}) => {
      prompt.stop()
      if (false && secret !== secret2) {
        process.stdout.write('Passwords mismatch!\n\n')
        process.exit(1)
      }
      callback(err, HyperVault.passwdPair(secret, secret))
    })
  }
}

