/*
 *  HyperVault - decentralized least-authority personal storage
 *  Copyright (C) <2018>  <Tony Ivanov>
 *
 *  This program is free software: you can redistribute it and/or modify
 *  it under the terms of the GNU Affero General Public License as published
 *  by the Free Software Foundation, either version 3 of the License, or
 *  (at your option) any later version.
 *
 *  This program is distributed in the hope that it will be useful,
 *  but WITHOUT ANY WARRANTY; without even the implied warranty of
 *  MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 *  GNU Affero General Public License for more details.
 *
 *  You should have received a copy of the GNU Affero General Public License
 *  along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

const debug = require('debug')('hypervault')
const multifeed = require('multifeed')
const sigrid = require('../multifeed-sigrid') // # TODO: publish to npm.
const assert = require('assert')
const hyperdrive = require('../hyperdrive')
const krypto = require('./lib/crypto')
const raf = require('random-access-file')
const datstore = require('dat-storage')
const path = require('path')
const fs = require('fs')
const pump = require('pump')
const Hyperphet = require('./lib/hyperphet')
const am = require('automerge')

// Export class and methods
module.exports = HyperVault

module.exports.passwdPair = function(ident, secret) {
  // hardcoded key-id 0, but there's a whole dimension there to use.
  return krypto.signPair(ident, secret, 0)
}

function HyperVault(key, repo, secret, opts) {
  if(!(this instanceof HyperVault)) return new HyperVault(key, repo, secret, opts)

  if (typeof secret === 'object' && !Buffer.isBuffer(secret)) {opts = secret; secret = null}
  this.opts = opts || {}

  // Assign secrets; TODO: would like to garbage collect them asap.
  this.key = key
  this.canWrite = !!secret
  this.secret = secret
  //this.deviceId = this.opts.deviceId || crypto.randomBytes(4).readUInt32BE()

  // Figure out what kind of repository we're dealing with.
  this.repo = repo || '.'
  this.bare = !!this.opts.bare
  this.metaDir = '.hypervault'


  const self = this
  const storage = (target) => {
    let fullPath = path.join(self.repo, self.metaDir, target)
    if (self.bare) fullPath = path.join(self.repo, target)
    if (typeof self.opts.storage === 'function') return self.opts.storage(fullPath)
    else if (!self.opts.storage) return raf(fullPath)
    else throw new Error('Optional storage was passed but only random-access is supported now')
  }

  // Initialize multifeed + sigrid
  this.sig = sigrid(this.key, storage, this.secret)
  this.multi = multifeed(spawnCore.bind(this), storage)
  this.multi.use(this.sig)
  this.multi.on('feed', this.appendChangeListenerToFeed.bind(this))
  this.ready(() => {
    debug('vault initialized')
  })
}

// Monkeypatching hyperdrive to redirect all tree-ops to our
// CRDT core
function spawnCore (storage, key, opts) {
  if (typeof key !== 'string' && !Buffer.isBuffer(key)) {
    opts = key
    key = null
  }

  const db = new Hyperphet(storage, key, opts)

  // yikes.
  db.wormholeGet = (key, opts, callback) => {
    if ( typeof opts === 'function') {
      callback = opts
      opts = {}
    }
    callback(null, this._local.metadata.doc[path.resolve('/', key)])
  }

  return hyperdrive(storage, key, Object.assign({}, opts, {
    metadata: db
  }))
}

HyperVault.prototype.appendChangeListenerToFeed = function(feed) {
  // We don't want to append change listeners on our own writers.
  // since their changes get loaded during initialization
  // and they're really the ones holding the CRDT-documents which are the
  // final recievers of theese change-events. for this experiment
  // we're only going to use one single writer implicitly saying only one single
  // CRDT-document.
  if (feed.writable) return // It's a writer, don't bother
  // subscribe to remote download events
  // and automatically apply them to this._local.metadata.doc
  feed.metadata.on('download',this.onChangesDownloaded.bind(this))
}

HyperVault.prototype.onChangesDownloaded = function (seq, data) {
  if (data.toString('utf8').match(/^\n\nhyperdrive/)) return
  try {
    const batch = JSON.parse(data.toString('utf8'))
    this._local.metadata.doc = am.applyChanges(this._local.metadata.doc, batch)
  } catch(err) {
    debug("Failed to deserialize changes", err)
    //this.emit('error', err)
    //this.removeAllListeners()
  }
}

HyperVault.prototype.replicate = function (opts) {
  return this.multi.replicate(opts)
}

HyperVault.prototype.ready = function(cb) {
  this.multi.ready(() => {
    if (this.canWrite) this.multi.writer('local', (err, writer) => {
      if (err) return cb(err)
      this._local = writer
      cb(null)
    })
    else cb()
  })
}

/** combines all hyperdrives into a virtual tree
 * that contains the latest changes from all cores.
 */
HyperVault.prototype.indexView = function(done) {
  done(null, this._local.metadata.doc)
}

/** not used **/
HyperVault.prototype.hyperTime = function () {
  const feeds = this.multi.feeds()
  return feeds.map((archive) => {
    return [a2k(archive), archive.version].join(':')
  }).sort()

  function a2k (archive) {
    const id = archive.discoveryKey.toString('hex')
    return id.substr(0,8) //TODO: this is a disaster waiting to happen. fix before production.
  }
}


/*
 * Reflects the combined hyperdrive view to disk and vice-versa
 * This approach causes our repo to always require minimum twice the
 * size of the files it stores (git-style). Alternative is to use a FUSE based approach
 * https://github.com/mafintosh/fuse-bindings
 * Which incidentially would let us access encrypted files without being forced
 * of writing their unencrypted contents to actual disk.
 * Use reflection only when FUSE is not available.
 */
HyperVault.prototype.reflect = function(cb) {
  const changeLog = {}

  this.indexView((err, hyperTree) => {
    if (err) return cb(err)

    _indexFolder(this.repo, (err, fsTree) => {
      if (err) return cb(err)

      // Calculate list of unique known entries
      const uniqueEntries = Object.keys(
        Object.keys(hyperTree)
        .concat(Object.keys(fsTree))
        .reduce((m,f) => { m[f]=true; return m }, {})
      )

      const nextEntry = (i) => {
        if (i >= uniqueEntries.length) return cb(null, changeLog)
        const file = uniqueEntries[i]

        // Decide what to do with it
        let action = 'nop'
        const hstat = hyperTree[file]
        const fstat = fsTree[file]

        if (hstat && hstat.deleted && fstat.mtime < hstat.mtime) action = 'delete-local' // losses offline changes
        else if (hstat && !fstat) action = 'export'
        else if (!hstat && fstat) action = 'import'
        else if (hstat && fstat) {
          debug('REFLECT: comparing', file, hstat.mtime, fstat.mtime)
          // prototype conflict resolution using mtime (pick newest)
          if (hstat.mtime < fstat.mtime) action = 'import'
          else if (hstat.mtime > fstat.mtime) action = 'export'
        }

        debug('REFLECT:', action.toUpperCase(), '\t\t', file)
        changeLog[file] = action

        // Import if needed TODO: stop importing deleted entries.
        if (action === 'import' && this.canWrite) {
          importFile(this._local, this.repo, file, fstat, err => {
            if (err) return cb(err)
            else nextEntry(i + 1)
          })
        }

        // Export if needed
        if (action === 'export' && !this.bare) {
          let srcFeed = this.multi.feeds().find(f => f.discoveryKey.toString('hex'), [hstat.feed])
          exportFile(srcFeed, this.repo, file, hstat, err => {
            if (err) return cb(err)
            else nextEntry(i + 1)
          })
        }

        // No op
        if (action === 'nop') nextEntry(i + 1)
      } // end of nextEntry()
      nextEntry(0)
    })
  })

  // reflect helpers
  function exportFile(feed, dst, file, stat, cb) {
    let dstPath = path.join(dst, file)
    // TODO: don't call mkdirSync on every pass, cache which dirs have already been
    // created during an reflect op to avoid trying to recreate them.
    fs.mkdirSync(path.dirname(dstPath),{ recursive: true })
    pump(feed.createReadStream(file), fs.createWriteStream(dstPath), err => {
      if (err) return cb(err)
      // Fix mtime to match stored stat in hyperdrive
      fs.open(dstPath, 'w', (err, fd) => {
        if (err) return done(err)
        fs.futimes(fd, stat.mtime / 1000, stat.mtime / 1000, (err) => {
          fs.close(fd, (err) => {'nop'}) // unconditional cleanup
          if(err) cb(err)
          else cb()
        })
      })
    })
  }

  function importFile(writer, dst, file, stat, cb) {
    pump(
      fs.createReadStream(path.join(dst, file)),
      writer.createWriteStream(file, {mtime: stat.mtime}),
      cb
    )
  }
}


/** Calculates a flat hash containing keys as files using full path from repo-root,
 * and values contain indicators required for synchronization.
 *
 * @param arch {Hyperdrive|String} if string provded, will index folder from
 * local filsystem; It can index hyperdrives but it's not optimal.
 * @param dir {String} sub directory to index, defaults to `/`
 */
function _indexFolder(arch, dir, cb) {
  if (typeof dir === 'function') { cb = dir; dir = null}
  if (!dir) dir = '/'
  const tree = {}

  // Consider it being a real filesystem if arch equals string
  const isHyperdrive = typeof arch !== 'string'

  const readdir = (file, done) => {
    if (isHyperdrive) arch.readdir(file, done)
    else fs.readdir(path.join(arch, file), done)
  }
  const lstat = (file, done) => {
    if (isHyperdrive) arch.lstat(file, done)
    else fs.lstat(path.join(arch, file), done)
  }

  const traverseDir = (subDir, dirDone) => {
    //debug('INDEX: traversing dir:', subDir)
    readdir(subDir, (err, list) => {
      if (err) return cb(err)
      const next = (i) => {
        if (i >= list.length) return dirDone()
        const entry = list[i]
        const fpath = path.join(subDir, entry)
        //debug('INDEX: processing entry:', fpath)

        // TODO: better ignore, hardcoding dosen't sit right.
        if (fpath.match(/^\/.hypervault/)) return next(i + 1)

        lstat(fpath, (err, stat) => {
          if (err) return cb(err)
          if (stat.isDirectory()) {
            traverseDir(fpath, (err) => {
              if (err) cb(err) // Abort _indexFolder with err
              else next(i + 1) // continue to next entry
            })
          } else if (stat.isFile()) {
            // Common keys
            let n = {
              size: stat.size,
              mtime: new Date(stat.mtime).getTime(),
              ctime: new Date(stat.ctime).getTime()
            }
            // Hyperdrive only keys
            if (isHyperdrive) {
              n.feed = arch.name
            }
            tree[fpath] = n
            next( i + 1 )
          } else {
            // only dir and plain file support right now.
            // symlinks can be patched in later.
            // continue to next if entry isn't supported
            next( i + 1 )
          }
        })
      }

      // Start processing the list from 0-nth entry
      next(0)
    })
  }

  // Start the loop from provided `dir` argument.
  // if no errors were thrown during the entire process
  // then call the tee.
  traverseDir(dir, (err) => {
    if (err) cb(err)
    else cb(null, tree)
  })
}
module.exports._indexFolder = _indexFolder

// A quick'n'dirty way to wrap es5 callback style methods
// inside a promise without having to 'promisify' every function individually
// usage:
// p(done => {
//  doSomething(err => {
//    if (err) return done(err)
//    doSomethingElse(done)
//  })
// })
function p(cb) {
  return new Promise(function(resolve, reject) {
    cb(function (err, ...p) {
      if (err) reject(err)
      // If our cb was called with a single parameter
      // then resolve it directly; otherwise resolve as an array.
      else resolve(p.length < 2 ? p[0] : p)
    })
  })
}


/** fs API proxies **/

/** uses indexView + entry.source to locate the archive mentioned by the tree.
 * todo: accept opts with timestamp to read tree at different versions.
 */
HyperVault.prototype._archiveOf = function (name, callback) {
  this.indexView((err, tree) => {
    name = path.resolve('/', name)
    let entry = tree[name]
    if (!entry) return callback(new Error('file not found, TODO: create a real ENOENT err'))

    const archive = this.multi.feeds().find(arch => arch.discoveryKey.toString('hex') === entry.feed)
    if (!archive) return callback(new Error(`Archive ${entry.source} not available`))
    callback(null, archive)
  })
}

HyperVault.prototype.writeFile = function (name, data, callback) {
  this._local.writeFile(name, data, err => {
    if (err) callback(err)
    else callback(null, this.hyperTime())
  })
}

HyperVault.prototype.unlink = function (name, callback) {
  this._local.unlink(name, callback)
}

HyperVault.prototype.readFile = function (name, callback) {
  this._archiveOf(name, (err, archive) => {
    if (err) callback(err)
    else archive.readFile(name, callback)
  })
}

HyperVault.prototype.createReadStream = function (name, callback) {
  this._archiveOf(name, (err, archive) => {
    if (err) callback(err)
    else archive.createReadStream(name, callback)
  })
}
