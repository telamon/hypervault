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
const hyperdrive = require('hyperdrive')
const krypto = require('./crypto')
const raf = require('random-access-file')
const datstore = require('dat-storage')
const path = require('path')
const fs = require('fs')
const pump = require('pump')

// Export class and methods
module.exports = HyperVault

module.exports.passwdPair = function(ident, secret) {
  // hardcoded key-id 0, but there's a whole dimension there to use.
  return krypto.signPair(ident, secret, 0)
}

function HyperVault(key, repo, secret, opts) {
  if(!(this instanceof HyperVault)) return new HyperVault(key, repo, secret, opts)

  if (typeof secret === 'object' && !Buffer.isBuffer(secret)) {opts = secret; secret = null}
  let self = this
  self.opts = opts || {}

  //self.deviceId = self.opts.deviceId || crypto.randomBytes(4).readUInt32BE()
  self.key = key
  self.canWrite = !!secret
  self.secret = secret

  self.repo = repo || '.'
  self.bare = !!self.opts.bare
  self.metaDir = '.puzzlebox'

  const storage = (target) => {
    let fullPath = path.join(self.repo, self.metaDir, target)
    if (self.bare) fullPath = path.join(self.repo, target)
    if (typeof self.opts.storage === 'function') return self.opts.storage(fullPath)
    else if (!self.opts.storage) return raf(fullPath)
    else throw new Error('Optional storage was passed but only random-access is supported now')
  }

  self.sig = sigrid(self.key, storage, self.secret)
  self.multi = multifeed(hyperdrive, storage)
  self.multi.use(self.sig)
}

/** combines all hyperdrives into a virtual tree
 * that contains the latest changes from all cores.
 */
HyperVault.prototype.indexView = function(done) {
  const feeds = this.multi.feeds()
  const tree = {}

  const nextFeed = (i) => {
    if (i >= feeds.length) return done(null, tree)
    const archive = feeds[i]
    const stream = archive.history()
    const entryHandler = entry => {
      let file = entry.name
      let s = {
        feed: archive.name,
        mtime: entry.value.mtime,
        version: entry.version
      }

      // TODO: don't use mtime for age-checks
      // Vector-clocks are ineffective when total amount of id's is unknown.
      // Consider ITCs, (Interval Tree Clocks)
      // Note on security, all timestamps generated at remote peers can be
      // considered insecure. Just like it's very easy to forge an
      // mtime-timestamp to insert an entry at a random point of history or the
      // future
      if (entry.type === 'put') {
        if (!tree[file]) { // tree does not contain file previously
          tree[file] = s
        } else if (tree[file].mtime < s.mtime){ // Update tree with newer version of file
          tree[file] = s
        }
      } else {
        debugger // TODO: not yet tested.
        // Delete file from tree if the delete op is considered 'newer'
        if (tree[file] && tree[file].mtime < s.mtime) {
          // TODO: this does not solve deletion when 'reflecting', it might just
          // cause another import.
          delete tree[file]
        }
      }
    } // end of entryHandler

    stream.on('data', entryHandler)
    stream.once('error', err => done(err))
    stream.once('end', () => {
      stream.removeAllListeners()
      nextFeed(i + 1)
    })
  }
  nextFeed(0)
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


HyperVault.prototype.replicate = function (opts) {
  return this.multi.replicate(opts)
}

HyperVault.prototype.writeFile = function (name, data, callback) {
  this._local.writeFile(name, data, callback)
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
  this.indexView((err, hyperTree, version) => {
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
        if (hyperTree[file] && !fsTree[file]) action = 'export'
        else if (!hyperTree[file] && fsTree[file]) action = 'import'
        else if (hyperTree[file] && fsTree[file]) {
          debug('REFLECT: comparing', file, hyperTree[file].mtime, fsTree[file].mtime)

          // prototype conflict resolution using mtime (pick newest)
          if (hyperTree[file].mtime < fsTree[file].mtime) action = 'import'
          else if (hyperTree[file].mtime > fsTree[file].mtime) action = 'export'
        }

        debug('REFLECT:', action.toUpperCase(), '\t\t', file)

        // Import if needed TODO: stop importing deleted entries.
        if (action === 'import' && this.canWrite) {
          importFile(this._local, this.repo, file, fsTree[file], err => {
            if (err) return cb(err)
            else nextEntry(i + 1)
          })
        }

        // Export if needed
        if (action === 'export' && !this.bare) {
          let srcFeed = this.multi._feeds[hyperTree[file].feed]
          exportFile(srcFeed, this.repo, file, hyperTree[file], err => {
            if (err) return cb(err)
            else nextEntry(i + 1)
          })
        }

        // No op
        if (action === 'nop') nextEntry(i + 1)

        changeLog[file] = action
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
        if (fpath.match(/^\/.puzzlebox/)) return next(i + 1)

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
// inside a promise without having to 'promisify' every call
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
      else resolve(p.length < 2 ? p[0] : p)
    })
  })
}
