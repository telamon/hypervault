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
const sigrid = require('multifeed-sigrid')
const assert = require('assert')
const hypercore = require('hypercore')
const krypto = require('./lib/crypto')
const raf = require('random-access-file')
const path = require('path')


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
      if (self.bare) fullPath = path.join(self.repo, target)
      if (typeof self.opts.storage === 'function') return self.opts.storage(fullPath)
      else if (!self.opts.storage) return raf(fullPath)
      else throw new Error('Optional storage was passed but only random-access is supported now')
    }

    // Initialize multifeed + sigrid
    this.sig = sigrid(this.key, storage, this.secret)
    this.multi = multifeed(hypercore, storage)
    this.multi.use(this.sig)
    this.ready(() => {
      debug('vault initialized')
    })
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
    //TODO
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
    this.indexView((err, tree) => {
      name = path.resolve('/', name)
      let entry = tree[name]
      if (!entry) return callback(new Error('file not found, TODO: create a real ENOENT err'))

      const archive = this.multi.feeds().find(arch => arch.discoveryKey.toString('hex') === entry.feed)
      if (!archive) return callback(new Error(`Archive ${entry.source} not available`))
      callback(null, archive)
    })
  }

  writeFile (name, data, callback) {
    this._local.writeFile(name, data, err => {
      if (err) callback(err)
      else callback(null, this.hyperTime())
    })
  }

  unlink (name, callback) {
    this._local.unlink(name, callback)
  }

  readFile (name, callback) {
    this._archiveOf(name, (err, archive) => {
      if (err) callback(err)
      else archive.readFile(name, callback)
    })
  }

  createReadStream (name, callback) {
    this._archiveOf(name, (err, archive) => {
      if (err) callback(err)
      else archive.createReadStream(name, callback)
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


