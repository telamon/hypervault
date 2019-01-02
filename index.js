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
const multifeed = require('../multifeed')
const sigrid = require('multifeed-sigrid')
const assert = require('assert')
const path = require('path')
const hypercore = require('hypercore')
const kappa = require('kappa-core')
const raf = require('random-access-file')
const krypto = require('./lib/crypto')
const HyperFS = require('./lib/hyperfs')
const metadrive = require('./lib/metadrive')

class HyperVault {

  constructor (key, repo, secret, opts) {
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
      // don't subpath cores into hidden folder if repo marked as 'bare'
      if (self.bare) fullPath = path.join(self.repo, target)
      // Proxy to random-access storage from opts if provided
      if (typeof self.opts.storage === 'function') return self.opts.storage(fullPath)
      // Proxy to random-access-file storing in our repo folder (default)
      else if (!self.opts.storage) return raf(fullPath)
      // Complain if someone passed a dat-storage type object instead of function
      else throw new Error('Optional storage was passed but only random-access is supported now')
    }
    this._storage = storage

    // Initialize multifeed + sigrid
    this.sig = sigrid(this.key, storage, this.secret)
    this.multi = multifeed(metadrive, storage)
    // this.multi.use(new OtherDrive.binfeedAnnouncer())
    this.multi.use(this.sig)
    this.ready(() => {
      debug('vault initialized')
    })
    this.db = kappa(storage, {
      multifeed: this.multi
    })
    this.tree = new HyperFS(this.db)
  }

  replicate (opts) {
    return this.multi.replicate(opts)
  }

  ready (cb) {
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
  indexView (done) {
    this.tree.toHash(done)
  }

  /** not used **/
  hyperTime () {
    const feeds = this.multi.feeds()
    return feeds.map((archive) => {
      return [a2k(archive), archive.version].join(':')
    }).sort()

    function a2k (archive) {
      const id = archive.discoveryKey.toString('hex')
      return id.substr(0,8) //TODO: this is a disaster waiting to happen. fix before production.
    }
  }

  /** fs API proxies **/

  /** uses indexView + entry.source to locate the archive mentioned by the tree.
   * todo: accept opts with timestamp to read tree at different versions.
   */
  _archiveOf (name, callback) {
    this.tree.feedOf(name, callback)
  }

  writeFile (name, data, opts, callback) {
    if(typeof opts === 'function') { callback = opts; opts = {} }
    const stream = this.createWriteStream(name, opts, (err, stream) => {
      stream.end(Buffer.from(data), callback)
    })
  }

  unlink (name, callback) {
    this.tree.bury(name, callback)
  }

  readFile (name, callback) {
    this.createReadStream(name, (err, stream) => {
      if (err) return callback(err)
      let buffer = null

      stream.on('data', chunk => {
        if (!buffer) buffer = chunk
        else buffer = Buffer.concat([buffer,chunk], 2)
      })

      stream.on('end', () => {
        callback(null, buffer)
      })
    })
  }

  createReadStream (name, callback) {
    this._archiveOf(name, (err, archive) => {
      if (err) return callback(err)
      debugger
    })
  }

  createWriteStream (name, opts, callback) {
    debug('writeStream created', name, opts)
    if(typeof opts === 'function') { callback = opts; opts = {} }

    const stream = hypercore(this._storage).createWriteStream(opts)
    stream.on('finish', () => {
      debug('WriteSteam finished')
    })

    const entry = {
      stat: {
        mtime: new Date().getTime()
      },
      blockId: 2,
      size: 500230
    }

    this.tree.set(name, entry, (err) => {
      if (err) { throw err }
      callback(null, stream)
    })
  }
}

// Export class and methods
module.exports = HyperVault

module.exports.passwdPair = function(ident, secret) {
  // hardcoded key-id 0, but there's a whole dimension there to use.
  return krypto.signPair(ident, secret, 0)
}

HyperVault.prototype.reflect = require('./lib/reflect')

module.exports._indexFolder = require('./lib/reflect')._indexFolder

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
